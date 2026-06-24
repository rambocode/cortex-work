// 本地 Whisper 模型清单 — 纯数据模块，不含 Node API / app / fs。
// 供 packages/core（UI 层）与 apps/desktop 主进程共用。
// sha256/sizeBytes 来自 Kun src/shared/local-whisper.ts，与 ggerganov/whisper.cpp 官方发布一致。

// ── 下载源 ────────────────────────────────────────────────────────────────────

export const WHISPER_DOWNLOAD_SOURCES = [
  { id: "huggingface", label: "Hugging Face",   host: "https://huggingface.co" },
  { id: "hf-mirror",  label: "HF-Mirror",       host: "https://hf-mirror.com" },
  { id: "hf-sufy",   label: "HF CDN (Sufy)",   host: "https://hf-cdn.sufy.com" },
] as const;

export type WhisperDownloadSourceId = (typeof WHISPER_DOWNLOAD_SOURCES)[number]["id"];

/** 根据下载源 host + 文件名拼 URL（pattern 与 Kun 一致）。*/
export function whisperDownloadUrl(
  fileName: string,
  sourceId: WhisperDownloadSourceId,
): string {
  const src = WHISPER_DOWNLOAD_SOURCES.find((s) => s.id === sourceId)!;
  // 安全断言：host 从清单读取，不接受外部输入
  if (!src.host.startsWith("https://")) {
    throw new Error(`whisperDownloadUrl: host 必须以 https:// 开头 (${src.host})`);
  }
  return `${src.host}/ggerganov/whisper.cpp/resolve/main/${fileName}`;
}

// ── 模型清单 ──────────────────────────────────────────────────────────────────

export const WHISPER_MODELS = [
  {
    id: "whisper-base-q5_1",
    label: "Whisper Base (Q5_1)",
    shortName: "Base",
    fileName: "ggml-base-q5_1.bin",
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    sizeBytes: 59_707_625,
    maxBytes: 100 * 1024 * 1024,
    resourceEstimate: { memory: "100-300 MB", cpuThreads: "1-2" },
    qualityTier: "basic" as const,
    recommended: false,
  },
  {
    id: "whisper-small-q5_1",
    label: "Whisper Small (Q5_1)",
    shortName: "Small",
    fileName: "ggml-small-q5_1.bin",
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    sizeBytes: 190_085_487,
    maxBytes: 400 * 1024 * 1024,
    resourceEstimate: { memory: "300-600 MB", cpuThreads: "2-4" },
    qualityTier: "balanced" as const,
    recommended: true,  // 默认推荐模型
  },
  {
    id: "whisper-medium-q5_0",
    label: "Whisper Medium (Q5_0)",
    shortName: "Medium",
    fileName: "ggml-medium-q5_0.bin",
    sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    sizeBytes: 539_212_467,
    maxBytes: 600 * 1024 * 1024,
    resourceEstimate: { memory: "800-1200 MB", cpuThreads: "4-8" },
    qualityTier: "strong" as const,
    recommended: false,
  },
] as const;

export type LocalWhisperModelId = (typeof WHISPER_MODELS)[number]["id"];
export type LocalWhisperQualityTier = (typeof WHISPER_MODELS)[number]["qualityTier"];

// ── 派生类型 ──────────────────────────────────────────────────────────────────

/** 下载进度（主进程 → 渲染端，经 bridge 回调推送，不进 Zustand）。*/
export interface LocalWhisperModelProgress {
  modelId: LocalWhisperModelId;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  speedBytesPerSecond?: number;
}

/** 单个模型的完整状态（listModels / modelStatus 返回）。*/
export interface LocalWhisperModelStatus {
  modelId: LocalWhisperModelId;
  label: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  maxBytes: number;
  resourceEstimate: { memory: string; cpuThreads: string };
  qualityTier: LocalWhisperQualityTier;
  recommended: boolean;
  // 运行态
  state: "missing" | "downloading" | "ready" | "error";
  path?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  error?: string;
}

/** 单个下载源的可达性检测结果。*/
export interface LocalWhisperSourceStatus {
  sourceId: WhisperDownloadSourceId;
  label: string;
  state: "available" | "unavailable";
  responseTimeMs?: number;
  httpStatus?: number;
  message?: string;
}

/** checkSources 返回值（含所属 modelId + 各源状态）。*/
export interface LocalWhisperSourcesResult {
  modelId: LocalWhisperModelId;
  sources: LocalWhisperSourceStatus[];
}

// ── 工具函数（纯函数，不含 Node API）────────────────────────────────────────

export function isLocalWhisperModelId(value: unknown): value is LocalWhisperModelId {
  return WHISPER_MODELS.some((m) => m.id === value);
}

export function isWhisperDownloadSourceId(value: unknown): value is WhisperDownloadSourceId {
  return WHISPER_DOWNLOAD_SOURCES.some((s) => s.id === value);
}

export const WHISPER_DEFAULT_MODEL_ID: LocalWhisperModelId = "whisper-small-q5_1";
export const WHISPER_DEFAULT_SOURCE_ID: WhisperDownloadSourceId = "huggingface";

/** 按 id 查找模型，找不到时回退默认模型，保证始终返回有效对象。*/
export function whisperModelById(modelId: unknown): (typeof WHISPER_MODELS)[number] {
  return (
    WHISPER_MODELS.find((m) => m.id === modelId) ??
    WHISPER_MODELS.find((m) => m.id === WHISPER_DEFAULT_MODEL_ID) ??
    WHISPER_MODELS[0]
  );
}

/** 按 id 查找下载源，找不到时回退默认源。*/
export function whisperSourceById(
  sourceId: unknown,
): (typeof WHISPER_DOWNLOAD_SOURCES)[number] {
  return (
    WHISPER_DOWNLOAD_SOURCES.find((s) => s.id === sourceId) ??
    WHISPER_DOWNLOAD_SOURCES.find((s) => s.id === WHISPER_DEFAULT_SOURCE_ID) ??
    WHISPER_DOWNLOAD_SOURCES[0]
  );
}
