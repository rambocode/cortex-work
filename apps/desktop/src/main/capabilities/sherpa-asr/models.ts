// 流式 ASR 模型管理：状态、受控下载（三件套 + 词表）、取消、删除与下载源探测。
//
// 与 SenseVoice 的 models.ts 同构，差别只有一处但很关键：这里一个 modelId 对应**四个文件**，
// 必须整组 ready 才算就绪。任一文件缺失/损坏都要退回 missing，否则 OnlineRecognizer 会在
// 创建时抛原生错误（信息不可读），排查成本远高于在这里挡住。
//
// 安全边界：modelId/sourceId 必须命中 core 白名单；目标路径只由白名单派生（fileName 也来自
// 清单，不接受调用方拼接）；每个文件先写 `.download` 临时文件，校验 size + SHA-256 后才原子
// 重命名，引擎永不加载未完成或未校验的文件。

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";

import {
  STREAMING_ASR_DEFAULT_MODEL_ID,
  STREAMING_ASR_DOWNLOAD_SOURCES,
  STREAMING_ASR_MODELS,
  isStreamingAsrDownloadSourceId,
  isStreamingAsrModelId,
  streamingAsrDownloadUrl,
  streamingAsrModelById,
  streamingAsrModelTotalBytes,
  streamingAsrSourceById,
  type StreamingAsrDownloadSourceId,
  type StreamingAsrModelId,
  type StreamingAsrModelProgress,
  type StreamingAsrModelStatus,
  type StreamingAsrSourceStatus,
  type StreamingAsrSourcesResult,
} from "@cortex-work/core/asr/streaming-models";

const CONNECT_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 30_000;
const SOURCE_CHECK_TIMEOUT_MS = 8_000;

type StreamingAsrModel = (typeof STREAMING_ASR_MODELS)[number];
type StreamingAsrSource = (typeof STREAMING_ASR_DOWNLOAD_SOURCES)[number];

export type StreamingAsrDownloadResult =
  | { ok: true; status: StreamingAsrModelStatus }
  | { ok: false; message: string; status?: StreamingAsrModelStatus };

let downloadPromise: Promise<StreamingAsrDownloadResult> | null = null;
let progressEmitter: ((progress: StreamingAsrModelProgress) => void) | null = null;
let lastProgress: StreamingAsrModelProgress | null = null;
let activeDownload: {
  modelId: StreamingAsrModelId;
  controller: AbortController;
  tempPath: string;
  canceled: boolean;
} | null = null;

export function setStreamingAsrProgressEmitter(
  cb: ((progress: StreamingAsrModelProgress) => void) | null,
): void {
  progressEmitter = cb;
}

export async function getStreamingAsrModelStatus(
  modelId?: unknown,
): Promise<StreamingAsrModelStatus | StreamingAsrModelStatus[]> {
  if (modelId === undefined || modelId === null) {
    return Promise.all(STREAMING_ASR_MODELS.map((model) => queryOneStatus(model.id)));
  }
  if (!isStreamingAsrModelId(modelId)) throw new Error(`无效的 modelId: ${String(modelId)}`);
  return queryOneStatus(modelId);
}

export async function downloadStreamingAsrModel(args: {
  modelId: unknown;
  sourceId: unknown;
}): Promise<StreamingAsrDownloadResult> {
  if (!isStreamingAsrModelId(args.modelId)) throw new Error(`无效的 modelId: ${String(args.modelId)}`);
  const sourceId: StreamingAsrDownloadSourceId = isStreamingAsrDownloadSourceId(args.sourceId)
    ? args.sourceId
    : "huggingface";
  const current = await queryOneStatus(args.modelId);
  if (current.state === "ready") return { ok: true, status: current };
  if (downloadPromise) return downloadPromise;
  downloadPromise = runDownload(args.modelId, sourceId).finally(() => {
    downloadPromise = null;
    lastProgress = null;
  });
  return downloadPromise;
}

export async function cancelStreamingAsrDownload(modelId: unknown): Promise<StreamingAsrDownloadResult> {
  if (!isStreamingAsrModelId(modelId)) throw new Error(`无效的 modelId: ${String(modelId)}`);
  if (!activeDownload || activeDownload.modelId !== modelId) {
    return { ok: true, status: await queryOneStatus(modelId) };
  }
  activeDownload.canceled = true;
  activeDownload.controller.abort();
  await rm(activeDownload.tempPath, { force: true }).catch(() => undefined);
  return { ok: true, status: buildStatus(modelId, "missing") };
}

/**
 * 删除整个模型目录。
 *
 * 引擎持有 encoder/decoder/joiner 的原生句柄，Windows 下删除被映射的文件会失败，
 * 故调用方（stt.ts）必须先 shutdown 引擎再调这里——与 SenseVoice 删除前停 sidecar 同理。
 */
export async function deleteStreamingAsrModel(modelId: unknown): Promise<StreamingAsrDownloadResult> {
  if (!isStreamingAsrModelId(modelId)) throw new Error(`无效的 modelId: ${String(modelId)}`);
  try {
    await rm(modelDir(modelId), { recursive: true, force: true });
    return { ok: true, status: await queryOneStatus(modelId) };
  } catch (error) {
    return { ok: false, message: errorMessage(error), status: await queryOneStatus(modelId) };
  }
}

export async function checkStreamingAsrSources(
  modelId: unknown = STREAMING_ASR_DEFAULT_MODEL_ID,
): Promise<StreamingAsrSourcesResult> {
  const model = isStreamingAsrModelId(modelId)
    ? streamingAsrModelById(modelId)
    : streamingAsrModelById(STREAMING_ASR_DEFAULT_MODEL_ID);
  return {
    modelId: model.id,
    sources: await Promise.all(
      STREAMING_ASR_DOWNLOAD_SOURCES.map((source) => checkOneSource(model, source)),
    ),
  };
}

/** 就绪判据：四个文件全部存在且字节数与清单一致（哈希只在下载时校验，避免每次启动重算 199MB）。 */
async function queryOneStatus(modelId: StreamingAsrModelId): Promise<StreamingAsrModelStatus> {
  const model = streamingAsrModelById(modelId);
  const total = streamingAsrModelTotalBytes(modelId);
  let readyBytes = 0;
  let allReady = true;
  for (const file of model.files) {
    try {
      const info = await stat(join(modelDir(modelId), file.fileName));
      if (info.isFile() && info.size === file.sizeBytes) {
        readyBytes += info.size;
        continue;
      }
      allReady = false;
    } catch {
      allReady = false;
    }
  }
  if (allReady) {
    return buildStatus(modelId, "ready", {
      path: modelDir(modelId),
      downloadedBytes: total,
      totalBytes: total,
    });
  }
  if (activeDownload?.modelId === modelId && activeDownload.canceled) {
    return buildStatus(modelId, "missing", { downloadedBytes: readyBytes, totalBytes: total });
  }
  if (downloadPromise && lastProgress?.modelId === modelId) {
    return buildStatus(modelId, "downloading", {
      downloadedBytes: lastProgress.downloadedBytes,
      totalBytes: lastProgress.totalBytes,
      speedBytesPerSecond: lastProgress.speedBytesPerSecond,
    });
  }
  return buildStatus(modelId, "missing", { downloadedBytes: readyBytes, totalBytes: total });
}

/**
 * 顺序下载模型的每个文件。
 *
 * 刻意串行而非并发：四个文件里 encoder 占 91%，并发只会让进度条抖动且抢带宽，
 * 而串行能保证「已完成字节」单调递增，取消时也只需清理一个临时文件。
 * 已存在且大小正确的文件直接跳过，使中断后重试等价于断点续传（按文件粒度）。
 */
async function runDownload(
  modelId: StreamingAsrModelId,
  sourceId: StreamingAsrDownloadSourceId,
): Promise<StreamingAsrDownloadResult> {
  const model = streamingAsrModelById(modelId);
  const source = streamingAsrSourceById(sourceId);
  const totalBytes = streamingAsrModelTotalBytes(modelId);
  const dir = modelDir(modelId);
  let completedBytes = 0;

  try {
    await mkdir(dir, { recursive: true });
    for (const file of model.files) {
      const target = join(dir, file.fileName);
      // 跳过已就绪文件：重试下载时不必重传 181MB 的 encoder。
      try {
        const info = await stat(target);
        if (info.isFile() && info.size === file.sizeBytes) {
          completedBytes += file.sizeBytes;
          emitProgress({
            modelId,
            fileName: file.fileName,
            downloadedBytes: completedBytes,
            totalBytes,
            speedBytesPerSecond: 0,
          });
          continue;
        }
      } catch {
        // 不存在则正常下载。
      }
      const result = await downloadOneFile({
        modelId,
        sourceId,
        fileName: file.fileName,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        maxBytes: model.maxBytesPerFile,
        target,
        baseBytes: completedBytes,
        totalBytes,
      });
      if (!result.ok) {
        if (result.canceled) return { ok: true, status: buildStatus(modelId, "missing") };
        const message = `${source.label}: ${result.message}`;
        return { ok: false, message, status: buildStatus(modelId, "error", { error: message }) };
      }
      completedBytes += file.sizeBytes;
    }
    await writeFile(
      join(dir, "model.json"),
      JSON.stringify(
        {
          modelId,
          repository: model.repository,
          revision: model.revision,
          files: model.files.map((f) => ({ fileName: f.fileName, sha256: f.sha256 })),
          downloadSource: sourceId,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return { ok: true, status: await queryOneStatus(modelId) };
  } catch (error) {
    const message = `${source.label}: ${errorMessage(error)}`;
    return { ok: false, message, status: buildStatus(modelId, "error", { error: message }) };
  }
}

async function downloadOneFile(args: {
  modelId: StreamingAsrModelId;
  sourceId: StreamingAsrDownloadSourceId;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  maxBytes: number;
  target: string;
  baseBytes: number;
  totalBytes: number;
}): Promise<{ ok: true } | { ok: false; message: string; canceled: boolean }> {
  const tempPath = `${args.target}.download`;
  const controller = new AbortController();
  let timeoutMessage = `下载停滞超过 ${STALL_TIMEOUT_MS / 1000} 秒`;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = (): void => {
    if (connectTimer) clearTimeout(connectTimer);
    if (stallTimer) clearTimeout(stallTimer);
  };
  const resetStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      timeoutMessage = `下载停滞超过 ${STALL_TIMEOUT_MS / 1000} 秒`;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  // 必须在第一个 await 之前登记句柄，cancel 才不会漏掉建连的等待窗口。
  activeDownload = { modelId: args.modelId, controller, tempPath, canceled: false };
  try {
    connectTimer = setTimeout(() => {
      timeoutMessage = `连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）`;
      controller.abort();
    }, CONNECT_TIMEOUT_MS);
    const url = streamingAsrDownloadUrl(args.sourceId, args.modelId, args.fileName);
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent() },
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    connectTimer = undefined;
    resetStallTimer();
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    let fileBytes = 0;
    const startedAt = Date.now();
    const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    bodyStream.on("data", (chunk: Buffer) => {
      fileBytes += chunk.length;
      resetStallTimer();
      emitProgress({
        modelId: args.modelId,
        fileName: args.fileName,
        downloadedBytes: args.baseBytes + fileBytes,
        totalBytes: args.totalBytes,
        speedBytesPerSecond: fileBytes / Math.max(1, (Date.now() - startedAt) / 1000),
      });
      if (fileBytes > args.maxBytes) bodyStream.destroy(new Error("下载超过最大允许字节数"));
    });
    await pipeline(bodyStream, createWriteStream(tempPath));
    clearTimers();

    const info = await stat(tempPath);
    if (info.size !== args.sizeBytes) {
      throw new Error(`${args.fileName} 大小不符：期望 ${args.sizeBytes} 字节，实际 ${info.size} 字节`);
    }
    const actualHash = await fileSha256(tempPath);
    if (actualHash !== args.sha256) {
      throw new Error(`${args.fileName} sha256 校验失败：期望 ${args.sha256}，实际 ${actualHash}`);
    }
    await rename(tempPath, args.target);
    return { ok: true };
  } catch (error) {
    const canceled = activeDownload?.modelId === args.modelId && activeDownload.canceled;
    clearTimers();
    await rm(tempPath, { force: true }).catch(() => undefined);
    return { ok: false, message: describeError(error, timeoutMessage), canceled };
  } finally {
    if (activeDownload?.tempPath === tempPath) activeDownload = null;
  }
}

async function checkOneSource(
  model: StreamingAsrModel,
  source: StreamingAsrSource,
): Promise<StreamingAsrSourceStatus> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), SOURCE_CHECK_TIMEOUT_MS);
  try {
    // 用最小的 tokens.txt 探活，避免为探测拉起 181MB 的 encoder 连接。
    const probe = model.files.find((file) => file.role === "tokens") ?? model.files[0];
    const response = await fetch(streamingAsrDownloadUrl(source.id, model.id, probe.fileName), {
      method: "HEAD",
      headers: { Range: "bytes=0-0", "User-Agent": userAgent() },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    const available = response.status === 200 || response.status === 206;
    return {
      sourceId: source.id,
      label: source.label,
      state: available ? "available" : "unavailable",
      httpStatus: response.status,
      responseTimeMs: Date.now() - startedAt,
      message: available ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      sourceId: source.id,
      label: source.label,
      state: "unavailable",
      responseTimeMs: Date.now() - startedAt,
      message: describeError(error, `源检测超时（${SOURCE_CHECK_TIMEOUT_MS / 1000} 秒）`),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildStatus(
  modelId: StreamingAsrModelId,
  state: StreamingAsrModelStatus["state"],
  extra: Partial<StreamingAsrModelStatus> = {},
): StreamingAsrModelStatus {
  const model = streamingAsrModelById(modelId);
  return {
    modelId,
    label: model.label,
    sizeBytes: streamingAsrModelTotalBytes(modelId),
    resourceEstimate: { ...model.resourceEstimate },
    recommended: model.recommended,
    state,
    ...extra,
  };
}

function emitProgress(progress: StreamingAsrModelProgress): void {
  const percent = progress.totalBytes
    ? Math.min(100, (progress.downloadedBytes / progress.totalBytes) * 100)
    : undefined;
  lastProgress = { ...progress, percent };
  progressEmitter?.(lastProgress);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function userAgent(): string {
  try {
    return `CortexDesktop/${app.getVersion()} streaming-asr`;
  } catch {
    return "CortexDesktop/dev streaming-asr";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeError(error: unknown, timeoutMessage: string): string {
  const message = errorMessage(error);
  if (error instanceof Error && error.name === "AbortError") return timeoutMessage;
  if (/aborted|terminated|network|fetch failed|socket|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    return `网络连接中断: ${message}`;
  }
  return message;
}

function modelBaseDir(): string {
  return join(app.getPath("userData"), "models", "speech", "zipformer");
}

export function modelDir(modelId: StreamingAsrModelId): string {
  return join(modelBaseDir(), streamingAsrModelById(modelId).id);
}

/** 引擎按 role 定位具体文件；调用前须确认 status 为 ready。 */
export function modelFilePaths(modelId: StreamingAsrModelId): {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
} {
  const model = streamingAsrModelById(modelId);
  const pick = (role: string): string => {
    const file = model.files.find((f) => f.role === role);
    if (!file) throw new Error(`模型清单缺少 ${role} 文件: ${modelId}`);
    return join(modelDir(modelId), file.fileName);
  };
  return {
    encoder: pick("encoder"),
    decoder: pick("decoder"),
    joiner: pick("joiner"),
    tokens: pick("tokens"),
  };
}

export const _internals = {
  buildStatus,
  modelDir,
  resetState(): void {
    downloadPromise = null;
    progressEmitter = null;
    lastProgress = null;
    activeDownload = null;
  },
};
