// 媒体生成（MediaGen）与语音识别（ASR）类型定义。
// 从 core/desktop/types.ts 拆出以遵守单文件 1200 行上限（与 plugin-types.ts 同款处理）。
// 使用方经 @cortex-work/core/desktop/types（barrel）或直接 import 本文件均可。
// 与 apps/desktop/src/main/ipc/types.ts 保持镜像（主进程侧同名接口）。

// 媒体供应商目录：normalizeMediaGenSettings 用它判定 providerId 合法性。
// 无循环风险——media-provider-directory 对本文件只有 type-only import（编译期擦除）。
import { findMediaProvider } from "./media-provider-directory";

// ── 媒体生成（MediaGen）设置：四模态（图片/语音/音乐/视频） ───────────────────
// 与 Kun KunImageGenerationSettingsV1 等对齐;协议枚举常量另行导出供 UI 下拉用。
// timeoutMs 默认值对齐 Kun（image 180s / speech 120s / music 300s / video 900s），
// 上限由 MAX_TIMEOUT_MS_BY_MODALITY 按模态钳制（见下方注释的看门狗依据）。
//
// ⚠️ apiKey 字段红线（全四模态）：持久化值只允许「空串」或「${secret:NAME} 金库引用」。
// personal-workspace.json 会被 renderer 全量读写过桥，任何明文密钥落在这里都等于泄漏；
// 明文只在主进程金库（safeStorage 加密）里存活。迁移期兼容历史明文（resolve 侧直用不报错），
// 首启迁移函数会把明文搬进金库并改写为引用（见主进程 migrateMediaGenPlaintextKeys）。

export type ImageGenProtocol =
  | "openai-images"
  | "minimax-image"
  | "grok-imagine-image"
  | "volcengine-ark-image";
export type SpeechGenProtocol = "openai-speech" | "minimax-t2a" | "mimo-tts";
export type MusicGenProtocol = "minimax-music";
export type VideoGenProtocol =
  | "minimax-video"
  | "grok-imagine-video"
  | "volcengine-ark-video";

// 图片画质档位："auto" 由供应商决定（对齐 Kun ImageGenerationQuality）。
export type ImageGenQuality = "auto" | "low" | "medium" | "high";
// 图片默认分辨率档（长边 1K=1024 … 4K=4096；"auto" 透传给供应商）。
export type ImageGenResolution = "auto" | "1K" | "2K" | "3K" | "4K";

export interface ImageGenSettings {
  enabled: boolean;
  providerId: string; // 'custom' 或媒体供应商目录 id（media-provider-directory.ts）
  protocol: ImageGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 供应商画质档位；与分辨率相互独立，默认 "auto"。*/
  quality: ImageGenQuality;
  /** 默认分辨率档；优先级：工具入参 > defaultSize > defaultResolution（MCP 层执行）。*/
  defaultResolution: ImageGenResolution;
  defaultSize: string; // "WxH" 或空；UI 正则校验 /^\d{2,5}x\d{2,5}$/
  // timeoutMs 上限见 MAX_TIMEOUT_MS_BY_MODALITY;openai-images 生成速度最快,180s 足够。
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
  // timeoutMs:对齐 Kun 默认 300s;上限 600s（钳制表）。
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
  defaultResolution: string; // 如 '1080P'（各协议档位不同：minimax 768P/1080P、grok 480P/720P、volcengine 480P-4K）
  // timeoutMs:视频生成最慢,对齐 Kun 默认 900s;上限 1500s（钳制表）。
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

// ── 按模态的 timeoutMs 钳制上限 ───────────────────────────────────────────────
//
// 钳制依据（承接原 resolve.ts:38-45 注释）：约束方是渲染端 per-run 静默看门狗
// （RUN_STALL_TIMEOUT_MS 现为 30min）与主进程活跃度兜底（40min）——媒体生成工具执行期间
// 无 CLI stdout 事件，若工具超时晚于看门狗触发，整轮 session 会被杀掉、主进程 poll 循环
// 悬挂导致资源泄漏。因此各模态上限必须显著低于 30min：video 取 25min（1_500_000）留 5min
// 余量，music 取 10min，image/speech 沿用历史保守值 290s；放宽看门狗阈值时本表无需跟改。
// normalize（core 侧）/ resolve（main 侧）/ 设置 UI 上下限三处共用此表，
// 避免复刻 Kun「UI 上限大于钳制上限导致静默截断」的错位 bug。
export const MAX_TIMEOUT_MS_BY_MODALITY = {
  image: 290_000,
  speech: 290_000,
  music: 600_000,
  video: 1_500_000,
} as const;

// timeoutMs 下限：太短的超时（如 0/负数/毫秒级手误）只会让所有请求必然失败。
export const MIN_TIMEOUT_MS = 10_000;

export function defaultImageGenSettings(): ImageGenSettings {
  return {
    enabled: false,
    providerId: "",
    protocol: "openai-images",
    baseUrl: "",
    apiKey: "",
    model: "",
    quality: "auto",
    defaultResolution: "1K",
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
    timeoutMs: 300_000,
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
    timeoutMs: 900_000,
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

// ── 旧档归一化（store hydrate 唯一入口） ──────────────────────────────────────
//
// 旧版 hydrate 是「s.mediaGenSettings ?? default」整体回落、无 deep merge：
// 旧档存在但缺新字段（quality/defaultResolution 等）时会出现 undefined 穿透。
// 此函数逐模态 deep-merge 工厂默认 + 枚举兜底 + providerId 合法化 + 数值钳制，
// 只在 hydrate 时跑一次（setMediaGenSettings 仍是浅合并——UI 只写合法值）。
// 刻意放 core 侧：main 进程 resolve 逐字段自校验，不镜像本函数。

const IMAGE_PROTOCOLS: readonly ImageGenProtocol[] = [
  "openai-images", "minimax-image", "grok-imagine-image", "volcengine-ark-image",
];
const SPEECH_PROTOCOLS: readonly SpeechGenProtocol[] = ["openai-speech", "minimax-t2a", "mimo-tts"];
const MUSIC_PROTOCOLS: readonly MusicGenProtocol[] = ["minimax-music"];
const VIDEO_PROTOCOLS: readonly VideoGenProtocol[] = [
  "minimax-video", "grok-imagine-video", "volcengine-ark-video",
];
const IMAGE_QUALITIES: readonly ImageGenQuality[] = ["auto", "low", "medium", "high"];
const IMAGE_RESOLUTIONS: readonly ImageGenResolution[] = ["auto", "1K", "2K", "3K", "4K"];

// defaultSize 合法形状："WxH"（各边 2-5 位数字）。不匹配且非空 → 置空（回落 defaultResolution）。
const DEFAULT_SIZE_RE = /^\d{2,5}x\d{2,5}$/;

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * providerId 合法化：空串与 "custom" 原样保留；其余必须命中媒体供应商目录，
 * 否则改写为 "custom"（旧 ProviderProfile id 已随 providerSettings 清理失效；
 * 保留用户自填 baseUrl/apiKey 等字段，不清空——切回自定义仍可用）。
 */
function normalizeProviderId(value: unknown, isKnownProvider: (id: string) => boolean): string {
  const id = pickString(value, "");
  if (!id || id === "custom") return id;
  return isKnownProvider(id) ? id : "custom";
}

function normalizeDefaultSize(value: unknown): string {
  const size = pickString(value, "").trim();
  if (!size) return "";
  return DEFAULT_SIZE_RE.test(size) ? size : "";
}

/**
 * 旧档兜底归一化：接受任意 unknown（旧档/脏档/缺档），返回结构完整、
 * 枚举与数值全部落在合法域内的 MediaGenSettings。
 */
export function normalizeMediaGenSettings(
  raw: unknown,
  options?: {
    /** providerId 是否命中媒体供应商目录（默认由 media-provider-directory 提供）。*/
    isKnownProvider?: (id: string) => boolean;
  },
): MediaGenSettings {
  const known = options?.isKnownProvider ?? defaultIsKnownProvider;
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof MediaGenSettings, unknown>>;
  const image = (src.image && typeof src.image === "object" ? src.image : {}) as Record<string, unknown>;
  const speech = (src.speech && typeof src.speech === "object" ? src.speech : {}) as Record<string, unknown>;
  const music = (src.music && typeof src.music === "object" ? src.music : {}) as Record<string, unknown>;
  const video = (src.video && typeof src.video === "object" ? src.video : {}) as Record<string, unknown>;

  const di = defaultImageGenSettings();
  const ds = defaultSpeechGenSettings();
  const dm = defaultMusicGenSettings();
  const dv = defaultVideoGenSettings();

  return {
    image: {
      enabled: pickBoolean(image.enabled, di.enabled),
      providerId: normalizeProviderId(image.providerId, known),
      protocol: pickEnum(image.protocol, IMAGE_PROTOCOLS, di.protocol),
      baseUrl: pickString(image.baseUrl, di.baseUrl),
      apiKey: pickString(image.apiKey, di.apiKey),
      model: pickString(image.model, di.model),
      quality: pickEnum(image.quality, IMAGE_QUALITIES, di.quality),
      defaultResolution: pickEnum(image.defaultResolution, IMAGE_RESOLUTIONS, di.defaultResolution),
      defaultSize: normalizeDefaultSize(image.defaultSize),
      timeoutMs: clampNumber(image.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS_BY_MODALITY.image, di.timeoutMs),
    },
    speech: {
      enabled: pickBoolean(speech.enabled, ds.enabled),
      providerId: normalizeProviderId(speech.providerId, known),
      protocol: pickEnum(speech.protocol, SPEECH_PROTOCOLS, ds.protocol),
      baseUrl: pickString(speech.baseUrl, ds.baseUrl),
      apiKey: pickString(speech.apiKey, ds.apiKey),
      model: pickString(speech.model, ds.model),
      voice: pickString(speech.voice, ds.voice),
      format: pickString(speech.format, ds.format),
      timeoutMs: clampNumber(speech.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS_BY_MODALITY.speech, ds.timeoutMs),
    },
    music: {
      enabled: pickBoolean(music.enabled, dm.enabled),
      providerId: normalizeProviderId(music.providerId, known),
      protocol: pickEnum(music.protocol, MUSIC_PROTOCOLS, dm.protocol),
      baseUrl: pickString(music.baseUrl, dm.baseUrl),
      apiKey: pickString(music.apiKey, dm.apiKey),
      model: pickString(music.model, dm.model),
      format: pickString(music.format, dm.format),
      timeoutMs: clampNumber(music.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS_BY_MODALITY.music, dm.timeoutMs),
    },
    video: {
      enabled: pickBoolean(video.enabled, dv.enabled),
      providerId: normalizeProviderId(video.providerId, known),
      protocol: pickEnum(video.protocol, VIDEO_PROTOCOLS, dv.protocol),
      baseUrl: pickString(video.baseUrl, dv.baseUrl),
      apiKey: pickString(video.apiKey, dv.apiKey),
      model: pickString(video.model, dv.model),
      defaultDuration: clampNumber(video.defaultDuration, 1, 30, dv.defaultDuration),
      defaultResolution: pickString(video.defaultResolution, dv.defaultResolution),
      timeoutMs: clampNumber(video.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS_BY_MODALITY.video, dv.timeoutMs),
      pollIntervalMs: clampNumber(video.pollIntervalMs, 1_000, 120_000, dv.pollIntervalMs),
    },
  };
}

function defaultIsKnownProvider(id: string): boolean {
  return findMediaProvider(id) !== undefined;
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
