/**
 * useComposerVoice — ComposerShell 的语音录制与转写逻辑 hook。
 *
 * 抽离原因：ComposerShell.tsx 录音+转写逻辑行数较多，结合 U9 的可用条件
 * 检查（本地模型状态订阅、按钮禁用逻辑），若直接堆在 ComposerShell 会超 1200 行限制。
 *
 * 负责：
 * 1. 录音状态机（idle → recording → transcribing → idle）
 * 2. 录音 Blob 重采样为 16kHz 单声道 WAV（经 encodeBlobAsWav）
 * 3. 转写路由：统一走 bridge.transcribeSpeech（U8 入口，按 asrSettings.protocol 分发）
 * 4. 本地 SenseVoiceSmall 模型状态订阅
 * 5. 语音按钮可用条件（R11）：enabled + 本地模型 ready 或在线配置完整
 * 6. 失败 toast（带原因区分），成功回填（保留现有文本 + 换行）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { AsrSettings } from "@cortex-work/core/desktop/media-gen-types";
import { isLocalStreamingAsrProtocol } from "@cortex-work/core/desktop/media-gen-types";
import type { LocalAsrModelStatus } from "@cortex-work/core/asr/local-models";
// 录音采集 + 16kHz WAV + 统一转写核心抽到 voiceRecorder（与 reply 气泡共用，见其文件头注释）。
import { VoiceCapture, transcribeRecording } from "./voiceRecorder";

// ── 按钮可用条件（R11）─────────────────────────────────────────────────────────

/**
 * 判断在线配置是否就绪（openai-transcriptions / mimo-asr）。
 * 需要 baseUrl 非空；apiKey 可选（部分私有部署不需要）。
 */
function isOnlineConfigReady(asr: AsrSettings): boolean {
  return Boolean(asr.baseUrl.trim());
}

/**
 * 本地模型状态在本 hook 里只需要这几个字段，SenseVoice 与流式 Zipformer 的状态类型
 * 在这部分是同形的，故用结构子集统一处理，避免为两条协议写两套订阅逻辑。
 */
type LocalModelStatusView = Pick<
  LocalAsrModelStatus,
  "state" | "downloadedBytes" | "totalBytes" | "speedBytesPerSecond"
> & { modelId: string };

/**
 * 判断本地模型是否就绪。
 * state 必须为 "ready"，其余（missing/downloading/error）均不可用。
 */
function isLocalModelReady(status: LocalModelStatusView | null): boolean {
  return status?.state === "ready";
}

/** 是否本地协议（SenseVoice 整段 / Zipformer 流式，两者都需要先下好模型）。 */
function isLocalProtocol(asr: AsrSettings): boolean {
  return isLocalStreamingAsrProtocol(asr.protocol);
}

// ── Hook 返回值 ────────────────────────────────────────────────────────────────

export interface UseComposerVoiceResult {
  /** 是否正在录音 */
  recording: boolean;
  /** 是否正在转写 */
  transcribing: boolean;
  /** 按钮是否可见（bridge 存在 + STT enabled） */
  micVisible: boolean;
  /** 按钮是否可点击（可见 + 配置就绪 + 非 downloading 状态） */
  micReady: boolean;
  /** 本地模型下载进度 0-100（仅 local-sensevoice 且 downloading 时非 null） */
  downloadPercent: number | null;
  /** 切换录音状态（开始/停止） */
  toggleRecording: () => void;
}

// ── Hook 实现 ──────────────────────────────────────────────────────────────────

export function useComposerVoice({
  bridge,
  asrSettings,
  onTranscript,
  onToast,
  runningOrSending,
}: {
  bridge: DesktopBridge | null;
  asrSettings: AsrSettings;
  /** 转写成功后回调，传入转写文本，由调用方决定如何回填输入框。 */
  onTranscript: (text: string) => void;
  /** 错误/提示 toast 回调。 */
  onToast: (text: string) => void;
  /** 是否处于 running 或 sending 状态（此时录音按钮禁用）。 */
  runningOrSending: boolean;
}): UseComposerVoiceResult {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  /** 本地模型状态（只在本地协议时订阅，SenseVoice / 流式 Zipformer 共用这一份）。 */
  const [localModelStatus, setLocalModelStatus] = useState<LocalModelStatusView | null>(null);

  // 进行中的录音会话（VoiceCapture 封装 MediaRecorder/MediaStream 生命周期）。
  const captureRef = useRef<VoiceCapture | null>(null);
  // 语音交互设置(纠错开关/词典)直接读 store,转写回调经 ref 取最新值。
  const voiceSettings = usePersonalStore((s) => s.voiceSettings);
  const voiceSettingsRef = useRef(voiceSettings);
  useEffect(() => { voiceSettingsRef.current = voiceSettings; }, [voiceSettings]);
  // 使用 ref 镜像 asrSettings 与 callbacks，避免异步回调闭包捕获旧值
  const asrSettingsRef = useRef(asrSettings);
  const onTranscriptRef = useRef(onTranscript);
  const onToastRef = useRef(onToast);

  useEffect(() => { asrSettingsRef.current = asrSettings; }, [asrSettings]);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onToastRef.current = onToast; }, [onToast]);

  // ── 本地模型状态订阅 ─────────────────────────────────────────────────────────
  // 仅本地协议时才查模型状态；切换协议立即重置状态。
  useEffect(() => {
    // 两条本地协议各有一套模型管理 IPC（SenseVoice: stt:local:*，Zipformer: stt:streaming:*），
    // 模型 id 取值域也不同，必须按 protocol 选对通道，否则查询会因「模型不在清单内」失败，
    // 状态停在 null → 麦克风按钮被永久禁用。
    const streaming = asrSettings.protocol === "local-zipformer-stream";
    if (!bridge || !isLocalProtocol(asrSettings)) {
      setLocalModelStatus(null);
      return;
    }
    const modelId = asrSettings.model;
    let cancelled = false;
    // 两侧的状态/进度类型只在 modelId 的字面量取值域上不同，这里统一收敛成
    // LocalModelStatusView / 结构化 progress 再消费；分支写死而不是取函数并集，
    // 否则 TS 会因为两个签名的 modelId 互不兼容而无法调用。
    const queryStatus = (): Promise<LocalModelStatusView> =>
      streaming
        ? (bridge.getStreamingAsrModelStatus?.(modelId) ?? Promise.reject(new Error("bridge 不支持")))
        : (bridge.getLocalAsrModelStatus?.(
            modelId as Parameters<NonNullable<typeof bridge.getLocalAsrModelStatus>>[0],
          ) ?? Promise.reject(new Error("bridge 不支持")));

    queryStatus()
      .then((status) => { if (!cancelled) setLocalModelStatus(status); })
      .catch(() => { /* 模型不在清单内则忽略，按钮将隐藏/禁用 */ });

    // 订阅下载进度推送：乐观更新——直接用事件字段更新进度，
    // 避免每条进度都打 IPC 往返，防止乱序 resolve 把 ready 覆盖回 downloading。
    // 仅在终态（percent >= 100 或 complete）时才补拉完整状态刷新。
    const onProgress = (progress: {
      modelId: string;
      percent?: number;
      downloadedBytes: number;
      totalBytes?: number;
      speedBytesPerSecond?: number;
    }): void => {
      {
        if (cancelled || progress.modelId !== modelId) return;
        const percent = progress.percent;
        if (percent !== undefined && percent >= 100) {
          // 下载完成：补拉一次完整状态确认 ready（终态一次 IPC 可接受）
          queryStatus()
            .then((status) => { if (!cancelled) setLocalModelStatus(status); })
            .catch(() => undefined);
        } else {
          // 进行中：直接用事件字段乐观更新，不打 IPC 往返；
          // prev 为 null 说明初始快照未到，等快照落地后再推进度即可（init 请求保持）
          setLocalModelStatus((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              state: "downloading",
              downloadedBytes: progress.downloadedBytes,
              totalBytes: progress.totalBytes,
              speedBytesPerSecond: progress.speedBytesPerSecond,
            };
          });
        }
      }
    };
    const unsubscribe = streaming
      ? bridge.onStreamingAsrDownloadProgress?.(onProgress)
      : bridge.onLocalAsrDownloadProgress?.(onProgress);

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // asrSettings.model 变化时重新订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, asrSettings.protocol, asrSettings.model]);

  // ── 组件卸载时停止录音 ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      captureRef.current?.dispose();
      captureRef.current = null;
    };
  }, []);

  // ── 转写逻辑 ─────────────────────────────────────────────────────────────────
  const transcribeBlob = useCallback(
    async (blob: Blob) => {
      if (!bridge || !bridge.transcribeSpeech) return;
      const asr = asrSettingsRef.current;
      setTranscribing(true);
      try {
        const voice = voiceSettingsRef.current;
        // 词典偏置与浮层/听写路径对齐;空词典不传 prompt。
        let text = await transcribeRecording(bridge, asr, blob, {
          prompt: voice.dictationDictionary.join("，") || undefined,
        });
        // LLM 纠错完成后才回填输入框(界面上不出现未纠错的原始转写);失败原文返回。
        if (voice.transcriptPolish && bridge.polishTranscript) {
          text = (await bridge.polishTranscript(text)).trim() || text;
        }
        onTranscriptRef.current(text);
      } catch (err) {
        // 本地 sidecar 与在线请求都返回明确失败原因，输入框原内容不受影响。
        const msg = err instanceof Error ? err.message : String(err);
        onToastRef.current(`转写失败：${msg}`);
        // 注：输入框内容不在本 hook 管理，onToast 后调用方输入框不会被清空
      } finally {
        setTranscribing(false);
      }
    },
    [bridge],
  );

  // ── 录音状态机 ────────────────────────────────────────────────────────────────
  // 停止录音 → 取回 Blob → 空则提示、非空转写。VoiceCapture.stop 异步 resolve 最终音频。
  const stopRecording = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    setRecording(false);
    const blob = await capture.stop();
    if (!blob) {
      onToastRef.current("没有录到音频");
      return;
    }
    void transcribeBlob(blob);
  }, [transcribeBlob]);

  const startRecording = useCallback(async () => {
    if (!bridge || !bridge.transcribeSpeech) {
      onToastRef.current("当前环境不支持语音输入");
      return;
    }
    try {
      const capture = new VoiceCapture();
      await capture.start();
      captureRef.current = capture;
      setRecording(true);
    } catch (err) {
      captureRef.current?.dispose();
      captureRef.current = null;
      setRecording(false);
      const msg = err instanceof Error ? err.message : String(err);
      onToastRef.current(`录音失败：${msg}`);
    }
  }, [bridge]);

  const toggleRecording = useCallback(() => {
    if (runningOrSending || transcribing) return;
    if (recording) void stopRecording();
    else void startRecording();
  }, [runningOrSending, transcribing, recording, stopRecording, startRecording]);

  // ── 可用条件计算（R11）───────────────────────────────────────────────────────
  // micVisible：bridge 存在 + transcribeSpeech 存在 + STT enabled
  const micVisible =
    Boolean(bridge) &&
    Boolean(bridge?.transcribeSpeech) &&
    asrSettings.enabled;

  // 本地协议 downloading 中的进度（供 tooltip 展示）
  const downloadPercent =
    micVisible &&
    isLocalProtocol(asrSettings) &&
    localModelStatus?.state === "downloading"
      ? (localModelStatus.totalBytes && localModelStatus.totalBytes > 0
          ? Math.round(((localModelStatus.downloadedBytes ?? 0) / localModelStatus.totalBytes) * 100)
          : null)
      : null;

  // micReady：可见 + (本地模型 ready 或 在线配置有 baseUrl)
  const micReady =
    micVisible &&
    (isLocalProtocol(asrSettings)
      ? isLocalModelReady(localModelStatus)
      : isOnlineConfigReady(asrSettings));

  return {
    recording,
    transcribing,
    micVisible,
    micReady,
    downloadPercent,
    toggleRecording,
  };
}
