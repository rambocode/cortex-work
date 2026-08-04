// 语音录制核心（U8 抽取）：MediaRecorder 采集 → 16kHz 单声道 WAV → bridge.transcribeSpeech。
//
// 抽离原因：ComposerShell 的「点按切换录音」与 reply 候选气泡的「按住说话」两处都要走
// 完全相同的「采集音频 → 重采样 WAV → 统一转写入口」链路，仅「何时开始/停止」的控制模型不同。
// 把与控制模型无关的采集/编码/转写核心收口到本文件，两处宿主复用，避免三段逻辑重复漂移。
//
// 本模块不含任何 React 状态：宿主（hook / 气泡渲染端）各自管理 UI 态与开始/停止时机。

import type { DesktopBridge } from "@cortex-work/core";
import type { AsrSettings } from "@cortex-work/core/desktop/media-gen-types";
import { encodeBlobAsWav } from "./encodeWav";

/** MediaRecorder MIME 优先顺序，webm/opus 压缩比最佳。 */
const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

/** 选取当前环境支持的录音 MIME；均不支持时返回空串（交由 MediaRecorder 用默认）。 */
export function pickRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/**
 * 一次进行中的录音会话。命令式封装 MediaRecorder + MediaStream 生命周期：
 * stop() 结束录音并异步返回录到的音频 Blob（空录音 → null）；dispose() 立即释放麦克风、不回调。
 */
export class VoiceCapture {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  // stop() 的 resolve；onstop 触发后回调它把最终 Blob 交回，随即清空避免重复 resolve。
  private stopResolve: ((blob: Blob | null) => void) | null = null;

  /** 是否处于活动录音中（宿主据此判断能否 stop）。 */
  get active(): boolean {
    return this.recorder != null;
  }

  /**
   * 申请指定麦克风（未传则系统默认）并开始录音。若已选设备不再满足约束则自动回退默认设备；
   * 其余失败（无 getUserMedia / 无 MediaRecorder / 用户拒绝）原样抛出，由宿主转成 toast。
   */
  async start(deviceId?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("当前浏览器不支持录音");
    }
    // 指定设备用 exact 保证用户选择生效；设备被拔出/权限变更时仅对约束不满足回退默认，
    // 其它错误（如用户拒绝权限）必须原样抛出，不能静默绕过用户决定。
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (!deviceId || !(error instanceof DOMException) || error.name !== "OverconstrainedError") {
        throw error;
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    this.stream = stream;
    this.chunks = [];
    const mimeType = pickRecordingMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    recorder.onstop = () => {
      // 停止麦克风轨道，释放系统录音权限指示灯
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      this.recorder = null;
      const resolve = this.stopResolve;
      this.stopResolve = null;
      // 空录音（size 0）返回 null，宿主据此提示「没有录到音频」而非发起转写。
      resolve?.(blob.size === 0 ? null : blob);
    };

    recorder.start();
  }

  /** 停止录音，异步 resolve 录到的音频 Blob；未在录音则立即 resolve null。 */
  stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      this.stopResolve = resolve;
      recorder.stop();
    });
  }

  /** 立即中止并释放麦克风，不返回音频（组件卸载 / 取消场景）。 */
  dispose(): void {
    this.stopResolve = null;
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        /* 已停止 / 状态异常：忽略，下面统一清理轨道 */
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

/**
 * 把录到的音频 Blob 重采样为 16kHz 单声道 WAV 并经统一转写入口（bridge.transcribeSpeech，
 * 按 asrSettings.protocol 路由本地 whisper / 在线 ASR）转写，返回识别文本。
 * 抛错交由宿主处理（toast / 失败结果）。
 */
export async function transcribeRecording(
  bridge: Pick<DesktopBridge, "transcribeSpeech">,
  asr: AsrSettings,
  blob: Blob,
  opts?: { prompt?: string },
): Promise<string> {
  if (!bridge.transcribeSpeech) throw new Error("当前环境不支持语音转写");
  // 重采样为 16kHz 单声道 WAV（whisper-cli 需要；在线接口也接受 WAV）
  const audio = await encodeBlobAsWav(blob);
  const result = await bridge.transcribeSpeech(
    {
      baseUrl: asr.baseUrl,
      apiKey: asr.apiKey || undefined,
      model: asr.model,
      // language 空串/"auto" → 不传（让服务端自动检测；OpenAI 兼容接口省略 language 表示 auto）
      language: asr.language && asr.language !== "auto" ? asr.language : undefined,
      // 词典 prompt 与 ASR 端点统一约定为解码偏置；空白值不发送，避免污染线上请求。
      prompt: opts?.prompt?.trim() || undefined,
      fileName: "recording.wav",
      mimeType: "audio/wav",
      audio,
    },
    asr,
  );
  return result.text;
}
