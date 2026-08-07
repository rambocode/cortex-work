// SenseVoiceSmall 本地模型目录。
//
// 模型 URL、大小和摘要固定在代码中：主进程只接受白名单 modelId，并在原子落盘前校验
// SHA-256，避免远端 main 分支漂移或路径注入把未知文件送入原生运行时。

export const LOCAL_ASR_DOWNLOAD_SOURCES = [
  { id: "huggingface", label: "Hugging Face", host: "https://huggingface.co" },
  { id: "hf-mirror", label: "HF-Mirror", host: "https://hf-mirror.com" },
] as const;

export type LocalAsrDownloadSourceId = (typeof LOCAL_ASR_DOWNLOAD_SOURCES)[number]["id"];

export const LOCAL_ASR_MODELS = [
  {
    id: "sensevoice-small-q8",
    label: "SenseVoiceSmall (Q8)",
    shortName: "SenseVoiceSmall",
    repository: "FunAudioLLM/SenseVoiceSmall-GGUF",
    revision: "90c1c61912018b70ada0fcc024ea24aca62f2e63",
    fileName: "sensevoice-small-q8.gguf",
    sha256: "4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5",
    sizeBytes: 254_208_320,
    maxBytes: 300 * 1024 * 1024,
    resourceEstimate: { memory: "约 500-900 MB", cpuThreads: "4-8" },
    qualityTier: "balanced" as const,
    recommended: true,
  },
] as const;

export type LocalAsrModelId = (typeof LOCAL_ASR_MODELS)[number]["id"];
export type LocalAsrQualityTier = (typeof LOCAL_ASR_MODELS)[number]["qualityTier"];

export const LOCAL_ASR_DEFAULT_MODEL_ID: LocalAsrModelId = "sensevoice-small-q8";

export interface LocalAsrModelProgress {
  modelId: LocalAsrModelId;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  speedBytesPerSecond?: number;
}

export interface LocalAsrModelStatus {
  modelId: LocalAsrModelId;
  label: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  maxBytes: number;
  resourceEstimate: { memory: string; cpuThreads: string };
  qualityTier: LocalAsrQualityTier;
  recommended: boolean;
  state: "missing" | "downloading" | "ready" | "error";
  path?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  error?: string;
}

export interface LocalAsrSourceStatus {
  sourceId: LocalAsrDownloadSourceId;
  label: string;
  state: "available" | "unavailable";
  httpStatus?: number;
  responseTimeMs?: number;
  message?: string;
}

export interface LocalAsrSourcesResult {
  modelId: LocalAsrModelId;
  sources: LocalAsrSourceStatus[];
}

export function isLocalAsrModelId(value: unknown): value is LocalAsrModelId {
  return typeof value === "string" && LOCAL_ASR_MODELS.some((model) => model.id === value);
}

export function isLocalAsrDownloadSourceId(value: unknown): value is LocalAsrDownloadSourceId {
  return typeof value === "string" && LOCAL_ASR_DOWNLOAD_SOURCES.some((source) => source.id === value);
}

export function localAsrModelById(value: unknown): (typeof LOCAL_ASR_MODELS)[number] {
  if (!isLocalAsrModelId(value)) {
    throw new Error(`无效的本地 ASR 模型: ${String(value)}`);
  }
  return LOCAL_ASR_MODELS.find((model) => model.id === value)!;
}

export function localAsrSourceById(value: unknown): (typeof LOCAL_ASR_DOWNLOAD_SOURCES)[number] {
  if (!isLocalAsrDownloadSourceId(value)) {
    throw new Error(`无效的本地 ASR 下载源: ${String(value)}`);
  }
  return LOCAL_ASR_DOWNLOAD_SOURCES.find((source) => source.id === value)!;
}

/** 只接收清单枚举，revision 固定，调用方不能拼接仓库、文件名或任意 URL。 */
export function localAsrDownloadUrl(
  sourceId: LocalAsrDownloadSourceId,
  modelId: LocalAsrModelId = LOCAL_ASR_DEFAULT_MODEL_ID,
): string {
  const source = localAsrSourceById(sourceId);
  const model = localAsrModelById(modelId);
  return `${source.host}/${model.repository}/resolve/${model.revision}/${model.fileName}`;
}
