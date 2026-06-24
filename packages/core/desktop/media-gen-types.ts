// 媒体生成（MediaGen）与语音识别（ASR）类型定义。
// 从 core/desktop/types.ts 拆出以遵守单文件 1200 行上限（与 plugin-types.ts 同款处理）。
// 使用方经 @cortex-work/core/desktop/types（barrel）或直接 import 本文件均可。
// 与 apps/desktop/src/main/ipc/types.ts 保持镜像（主进程侧同名接口）。

// ── 媒体生成（MediaGen）设置：四模态（图片/语音/音乐/视频） ───────────────────
// 与 Kun KunImageGenerationSettingsV1 等对齐;协议枚举常量另行导出供 UI 下拉用。
// timeoutMs 全部定在 ~280s 以内:主进程 node-fetch 自身无 socket timeout,系统 TCP
// 超时约 300s,卡在 280 以内可在看门狗触发前拿到清晰超时错误（Kun 原值 300/900s,此处下调）。

export type ImageGenProtocol = "openai-images" | "minimax-image";
export type SpeechGenProtocol = "openai-speech" | "minimax-t2a" | "mimo-tts";
export type MusicGenProtocol = "minimax-music";
export type VideoGenProtocol = "minimax-video";

export interface ImageGenSettings {
  enabled: boolean;
  providerId: string; // 'custom' 或供应商 id
  protocol: ImageGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultSize: string;
  // timeoutMs < 300s 看门狗上限;openai-images 生成速度最快,180s 足够。
  timeoutMs: number;
}

export interface SpeechGenSettings {
  enabled: boolean;
  providerId: string;
  protocol: SpeechGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: string; // 'mp3'|'wav'|...
  // timeoutMs:TTS 通常 <1min;120s 对长文本留余量。
  timeoutMs: number;
}

export interface MusicGenSettings {
  enabled: boolean;
  providerId: string;
  protocol: MusicGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  format: string;
  // timeoutMs:音乐生成比视频快,280s 覆盖极端慢速节点。
  timeoutMs: number;
}

export interface VideoGenSettings {
  enabled: boolean;
  providerId: string;
  protocol: VideoGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultDuration: number; // 秒
  defaultResolution: string; // 如 '1080P'
  // timeoutMs:视频生成最慢,280s 覆盖；超时后应重试或告知用户。
  timeoutMs: number;
  // pollIntervalMs:视频为异步任务,按此间隔轮询状态。
  pollIntervalMs: number;
}

// 媒体生成总配置（四模态一组,可选字段 → 旧 JSON 向后兼容）。
export interface MediaGenSettings {
  image: ImageGenSettings;
  speech: SpeechGenSettings;
  music: MusicGenSettings;
  video: VideoGenSettings;
}

export function defaultImageGenSettings(): ImageGenSettings {
  return {
    enabled: false,
    providerId: "",
    protocol: "openai-images",
    baseUrl: "",
    apiKey: "",
    model: "",
    defaultSize: "",
    timeoutMs: 180_000,
  };
}

export function defaultSpeechGenSettings(): SpeechGenSettings {
  return {
    enabled: false,
    providerId: "",
    protocol: "openai-speech",
    baseUrl: "",
    apiKey: "",
    model: "",
    voice: "",
    format: "mp3",
    timeoutMs: 120_000,
  };
}

export function defaultMusicGenSettings(): MusicGenSettings {
  return {
    enabled: false,
    providerId: "",
    protocol: "minimax-music",
    baseUrl: "",
    apiKey: "",
    model: "",
    format: "mp3",
    timeoutMs: 280_000,
  };
}

export function defaultVideoGenSettings(): VideoGenSettings {
  return {
    enabled: false,
    providerId: "",
    protocol: "minimax-video",
    baseUrl: "",
    apiKey: "",
    model: "",
    defaultDuration: 6,
    defaultResolution: "1080P",
    timeoutMs: 280_000,
    pollIntervalMs: 10_000,
  };
}

export function defaultMediaGenSettings(): MediaGenSettings {
  return {
    image: defaultImageGenSettings(),
    speech: defaultSpeechGenSettings(),
    music: defaultMusicGenSettings(),
    video: defaultVideoGenSettings(),
  };
}

// ── 语音识别（ASR）设置 ──────────────────────────────────────────────────────
// 与 Kun KunSpeechToTextSettingsV1 对齐;local-whisper 走本地模型(U7/U8 接入)。

export type AsrProtocol = "openai-transcriptions" | "mimo-asr" | "local-whisper";
// 本地 Whisper 模型下载来源:huggingface 官方 / hf-mirror 国内镜像 / hf-sufy 加速镜像。
export type LocalWhisperDownloadSource = "huggingface" | "hf-mirror" | "hf-sufy";

export interface AsrSettings {
  enabled: boolean;
  providerId: string;
  protocol: AsrProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  // local-whisper 专用:模型下载来源（国内用户建议 hf-mirror 或 hf-sufy）。
  localWhisperDownloadSource: LocalWhisperDownloadSource;
  // language:'' 或 'auto' 表示自动识别;指定语言代码如 'zh' 可提升速度。
  language: string;
  // timeoutMs:语音片段通常 <30s;60s 对长录音留余量（U7 本地 whisper 可能更慢,后续 U8 再校准）。
  timeoutMs: number;
}

export function defaultAsrSettings(): AsrSettings {
  return {
    enabled: false,
    providerId: "",
    protocol: "openai-transcriptions",
    baseUrl: "",
    apiKey: "",
    model: "",
    localWhisperDownloadSource: "huggingface",
    language: "auto",
    timeoutMs: 60_000,
  };
}
