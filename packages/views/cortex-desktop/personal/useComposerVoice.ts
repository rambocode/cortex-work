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
 * 4. 本地 whisper 模型状态订阅（getWhisperModelStatus + onWhisperDownloadProgress）
 * 5. 语音按钮可用条件（R11）：enabled + 本地模型 ready 或在线配置完整
 * 6. 失败 toast（带原因区分），成功回填（保留现有文本 + 换行）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge } from "@cortex-work/core";
import type { AsrSettings } from "@cortex-work/core/desktop/media-gen-types";
import type { LocalWhisperModelStatus } from "@cortex-work/core/whisper/models";
import { encodeBlobAsWav } from "./encodeWav";

/** MediaRecorder MIME 优先顺序，webm/opus 压缩比最佳。 */
const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

// ── 按钮可用条件（R11）─────────────────────────────────────────────────────────

/**
 * 判断在线配置是否就绪（openai-transcriptions / mimo-asr）。
 * 需要 baseUrl 非空；apiKey 可选（部分私有部署不需要）。
 */
function isOnlineConfigReady(asr: AsrSettings): boolean {
  return Boolean(asr.baseUrl.trim());
}

/**
 * 判断本地 whisper 模型是否就绪。
 * state 必须为 "ready"，其余（missing/downloading/error）均不可用。
 */
function isLocalModelReady(status: LocalWhisperModelStatus | null): boolean {
  return status?.state === "ready";
}

/** 是否本地 whisper 协议。 */
function isLocalProtocol(asr: AsrSettings): boolean {
  return asr.protocol === "local-whisper";
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
  /** 本地模型下载进度 0-100（仅 local-whisper 且 downloading 时非 null） */
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
  /** 本地 whisper 模型状态（只在 local-whisper 协议时订阅）。 */
  const [localModelStatus, setLocalModelStatus] = useState<LocalWhisperModelStatus | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  // 使用 ref 镜像 asrSettings 与 callbacks，避免 onstop 闭包捕获旧值
  const asrSettingsRef = useRef(asrSettings);
  const onTranscriptRef = useRef(onTranscript);
  const onToastRef = useRef(onToast);

  useEffect(() => { asrSettingsRef.current = asrSettings; }, [asrSettings]);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onToastRef.current = onToast; }, [onToast]);

  // ── 本地模型状态订阅 ─────────────────────────────────────────────────────────
  // 仅 local-whisper 协议时才查模型状态；切换协议立即重置状态。
  useEffect(() => {
    if (!bridge || !bridge.getWhisperModelStatus || !isLocalProtocol(asrSettings)) {
      setLocalModelStatus(null);
      return;
    }
    const modelId = asrSettings.model;
    let cancelled = false;

    // 首次加载：用 getWhisperModelStatus 拉快照
    bridge.getWhisperModelStatus(modelId as Parameters<typeof bridge.getWhisperModelStatus>[0])
      .then((status) => { if (!cancelled) setLocalModelStatus(status); })
      .catch(() => { /* 模型不在清单内则忽略，按钮将隐藏/禁用 */ });

    // 订阅下载进度推送：downloading → 更新 percent；ready/error → 刷新状态
    let unsubscribe: (() => void) | undefined;
    if (bridge.onWhisperDownloadProgress) {
      unsubscribe = bridge.onWhisperDownloadProgress((progress) => {
        if (cancelled || progress.modelId !== modelId) return;
        // 进度推送只含 percent，需同步拉完整状态
        if (bridge.getWhisperModelStatus) {
          bridge.getWhisperModelStatus(modelId as Parameters<typeof bridge.getWhisperModelStatus>[0])
            .then((status) => { if (!cancelled) setLocalModelStatus(status); })
            .catch(() => undefined);
        }
      });
    }

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
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── 转写逻辑 ─────────────────────────────────────────────────────────────────
  const transcribeBlob = useCallback(
    async (blob: Blob) => {
      if (!bridge || !bridge.transcribeSpeech) return;
      const asr = asrSettingsRef.current;
      setTranscribing(true);
      try {
        // 重采样为 16kHz 单声道 WAV（whisper-cli 需要；在线接口也接受 WAV）
        const audio = await encodeBlobAsWav(blob);
        const result = await bridge.transcribeSpeech(
          {
            baseUrl: asr.baseUrl,
            apiKey: asr.apiKey || undefined,
            model: asr.model,
            // language 空串/"auto" → 不传（让服务端自动检测；OpenAI 兼容接口省略 language 表示 auto）
            language: asr.language && asr.language !== "auto" ? asr.language : undefined,
            fileName: `recording.wav`,
            mimeType: "audio/wav",
            audio,
          },
          asr,
        );
        onTranscriptRef.current(result.text);
      } catch (err) {
        // 区分本地运行器退出码与网络/配置错误：
        // - 退出码错误通常含 "exit code" 字样（由主进程 whisper-cli runner 抛出）
        // - 网络错误含 fetch/network 字样
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
  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!bridge || !bridge.transcribeSpeech) {
      onToastRef.current("当前环境不支持语音输入");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onToastRef.current("当前浏览器不支持录音");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = pickRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        // 停止麦克风轨道，释放系统录音权限指示灯
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);

        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];

        if (blob.size === 0) {
          onToastRef.current("没有录到音频");
          return;
        }
        // type 仅用于 Blob 构建，encodeBlobAsWav 内部重采样后输出 WAV
        void transcribeBlob(blob);
      };

      recorder.start();
      setRecording(true);
    } catch (err) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setRecording(false);
      const msg = err instanceof Error ? err.message : String(err);
      onToastRef.current(`录音失败：${msg}`);
    }
  }, [bridge, transcribeBlob]);

  const toggleRecording = useCallback(() => {
    if (runningOrSending || transcribing) return;
    if (recording) stopRecording();
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
