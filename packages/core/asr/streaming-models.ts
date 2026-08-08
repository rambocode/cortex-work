// 流式 ASR（sherpa-onnx streaming zipformer）本地模型目录。
//
// 与 SenseVoice 的 local-models.ts 是并列关系而非替代：SenseVoice 是「句末整句推理」的
// 离线模型（单文件 GGUF），这里是「边说边解码」的流式 transducer（encoder/decoder/joiner
// 三件套 + tokens 词表，缺一不可）。两者共存，由 AsrSettings.protocol 分流。
//
// 安全边界与 local-models.ts 一致：只接受白名单 modelId，revision 钉死到 commit sha，
// 逐文件校验 size + SHA-256 后才原子落盘，原生运行时永不加载未校验的文件。
// 下面的 sha256 是 2026-08-08 实际下载后计算得到的，不是从模型卡片抄的。

export const STREAMING_ASR_DOWNLOAD_SOURCES = [
  { id: "huggingface", label: "Hugging Face", host: "https://huggingface.co" },
  { id: "hf-mirror", label: "HF-Mirror", host: "https://hf-mirror.com" },
] as const;

export type StreamingAsrDownloadSourceId = (typeof STREAMING_ASR_DOWNLOAD_SOURCES)[number]["id"];

/** 三件套 + 词表在引擎里的角色；engine.ts 按 role 组装 OnlineRecognizer 配置。 */
export type StreamingAsrFileRole = "encoder" | "decoder" | "joiner" | "tokens";

export interface StreamingAsrModelFile {
  role: StreamingAsrFileRole;
  fileName: string;
  sha256: string;
  sizeBytes: number;
}

export const STREAMING_ASR_MODELS = [
  {
    id: "zipformer-bilingual-zh-en-int8",
    label: "Streaming Zipformer 中英双语 (int8)",
    shortName: "Zipformer 流式",
    repository: "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    revision: "98590b7ed6443e77b714204da2757d75e1a642f4",
    // encoder 用 int8 量化版（181MB），decoder 保持 fp32：官方导出里 decoder 只是嵌入表，
    // 量化收益极小；joiner 用 int8。这与 sherpa 官方推荐组合一致。
    files: [
      {
        role: "encoder",
        fileName: "encoder-epoch-99-avg-1.int8.onnx",
        sha256: "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b",
        sizeBytes: 181_895_032,
      },
      {
        role: "decoder",
        fileName: "decoder-epoch-99-avg-1.onnx",
        sha256: "2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d",
        sizeBytes: 13_876_452,
      },
      {
        role: "joiner",
        fileName: "joiner-epoch-99-avg-1.int8.onnx",
        sha256: "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0",
        sizeBytes: 3_228_404,
      },
      {
        role: "tokens",
        fileName: "tokens.txt",
        sha256: "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
        sizeBytes: 56_317,
      },
    ] as readonly StreamingAsrModelFile[],
    // 单文件上限：给最大的 encoder 留余量，防止远端换文件后无限下载。
    maxBytesPerFile: 256 * 1024 * 1024,
    resourceEstimate: { memory: "约 400-700 MB", cpuThreads: "2-4" },
    recommended: true,
  },
] as const;

export type StreamingAsrModelId = (typeof STREAMING_ASR_MODELS)[number]["id"];

export const STREAMING_ASR_DEFAULT_MODEL_ID: StreamingAsrModelId = "zipformer-bilingual-zh-en-int8";

export interface StreamingAsrModelProgress {
  modelId: StreamingAsrModelId;
  /** 当前正在下载的文件名，便于 UI 显示「正在下载 encoder…」。 */
  fileName: string;
  /** 已完成文件 + 当前文件的累计字节数（跨文件累计，UI 可直接算总进度）。 */
  downloadedBytes: number;
  totalBytes: number;
  percent?: number;
  speedBytesPerSecond?: number;
}

export interface StreamingAsrModelStatus {
  modelId: StreamingAsrModelId;
  label: string;
  sizeBytes: number;
  resourceEstimate: { memory: string; cpuThreads: string };
  recommended: boolean;
  state: "missing" | "downloading" | "ready" | "error";
  /** ready 时为模型目录（引擎按 role 在目录内定位各文件）。 */
  path?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  error?: string;
}

export interface StreamingAsrSourceStatus {
  sourceId: StreamingAsrDownloadSourceId;
  label: string;
  state: "available" | "unavailable";
  httpStatus?: number;
  responseTimeMs?: number;
  message?: string;
}

export interface StreamingAsrSourcesResult {
  modelId: StreamingAsrModelId;
  sources: StreamingAsrSourceStatus[];
}

export function isStreamingAsrModelId(value: unknown): value is StreamingAsrModelId {
  return typeof value === "string" && STREAMING_ASR_MODELS.some((model) => model.id === value);
}

export function isStreamingAsrDownloadSourceId(value: unknown): value is StreamingAsrDownloadSourceId {
  return (
    typeof value === "string" && STREAMING_ASR_DOWNLOAD_SOURCES.some((source) => source.id === value)
  );
}

export function streamingAsrModelById(value: unknown): (typeof STREAMING_ASR_MODELS)[number] {
  if (!isStreamingAsrModelId(value)) {
    throw new Error(`无效的流式 ASR 模型: ${String(value)}`);
  }
  return STREAMING_ASR_MODELS.find((model) => model.id === value)!;
}

export function streamingAsrSourceById(
  value: unknown,
): (typeof STREAMING_ASR_DOWNLOAD_SOURCES)[number] {
  if (!isStreamingAsrDownloadSourceId(value)) {
    throw new Error(`无效的流式 ASR 下载源: ${String(value)}`);
  }
  return STREAMING_ASR_DOWNLOAD_SOURCES.find((source) => source.id === value)!;
}

/** 模型总字节数（四个文件之和），用于 UI 展示与跨文件进度分母。 */
export function streamingAsrModelTotalBytes(modelId: StreamingAsrModelId): number {
  return streamingAsrModelById(modelId).files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

/** 只接收清单枚举，revision 固定，调用方不能拼接仓库、文件名或任意 URL。 */
export function streamingAsrDownloadUrl(
  sourceId: StreamingAsrDownloadSourceId,
  modelId: StreamingAsrModelId,
  fileName: string,
): string {
  const source = streamingAsrSourceById(sourceId);
  const model = streamingAsrModelById(modelId);
  if (!model.files.some((file) => file.fileName === fileName)) {
    throw new Error(`文件不在模型清单内: ${fileName}`);
  }
  return `${source.host}/${model.repository}/resolve/${model.revision}/${fileName}`;
}
