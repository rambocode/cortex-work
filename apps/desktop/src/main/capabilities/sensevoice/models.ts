// SenseVoiceSmall 本地模型管理：状态、受控下载、取消、删除和下载源探测。
//
// 安全边界：modelId/sourceId 必须命中 core 白名单；目标路径只由白名单派生；下载先写
// `.download` 临时文件，精确校验 size 与 SHA-256 后才原子重命名，原生 sidecar 永不加载
// 未完成或未校验的文件。

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";

import {
  LOCAL_ASR_DEFAULT_MODEL_ID,
  LOCAL_ASR_DOWNLOAD_SOURCES,
  LOCAL_ASR_MODELS,
  isLocalAsrDownloadSourceId,
  isLocalAsrModelId,
  localAsrDownloadUrl,
  localAsrModelById,
  localAsrSourceById,
  type LocalAsrDownloadSourceId,
  type LocalAsrModelId,
  type LocalAsrModelProgress,
  type LocalAsrModelStatus,
  type LocalAsrSourceStatus,
  type LocalAsrSourcesResult,
} from "@cortex-work/core/asr/local-models";

const CONNECT_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 30_000;
const SOURCE_CHECK_TIMEOUT_MS = 8_000;

type LocalAsrModel = (typeof LOCAL_ASR_MODELS)[number];
type LocalAsrSource = (typeof LOCAL_ASR_DOWNLOAD_SOURCES)[number];

export type LocalAsrDownloadResult =
  | { ok: true; status: LocalAsrModelStatus }
  | { ok: false; message: string; status?: LocalAsrModelStatus };

let downloadPromise: Promise<LocalAsrDownloadResult> | null = null;
let progressEmitter: ((progress: LocalAsrModelProgress) => void) | null = null;
let lastProgress: LocalAsrModelProgress | null = null;
let activeDownload: {
  modelId: LocalAsrModelId;
  controller: AbortController;
  tempPath: string;
  canceled: boolean;
} | null = null;

export function setLocalAsrProgressEmitter(
  cb: ((progress: LocalAsrModelProgress) => void) | null,
): void {
  progressEmitter = cb;
}

export async function getLocalAsrModelStatus(
  modelId?: unknown,
): Promise<LocalAsrModelStatus | LocalAsrModelStatus[]> {
  if (modelId === undefined || modelId === null) {
    return Promise.all(LOCAL_ASR_MODELS.map((model) => queryOneStatus(model.id)));
  }
  if (!isLocalAsrModelId(modelId)) throw new Error(`无效的 modelId: ${String(modelId)}`);
  return queryOneStatus(modelId);
}

export async function downloadLocalAsrModel(args: {
  modelId: unknown;
  sourceId: unknown;
}): Promise<LocalAsrDownloadResult> {
  if (!isLocalAsrModelId(args.modelId)) throw new Error(`无效的 modelId: ${String(args.modelId)}`);
  const sourceId: LocalAsrDownloadSourceId = isLocalAsrDownloadSourceId(args.sourceId)
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

export async function cancelLocalAsrDownload(modelId: unknown): Promise<LocalAsrDownloadResult> {
  if (!isLocalAsrModelId(modelId)) throw new Error(`无效的 modelId: ${String(modelId)}`);
  if (!activeDownload || activeDownload.modelId !== modelId) {
    return { ok: true, status: await queryOneStatus(modelId) };
  }
  activeDownload.canceled = true;
  activeDownload.controller.abort();
  await rm(activeDownload.tempPath, { force: true }).catch(() => undefined);
  return { ok: true, status: buildStatus(modelId, "missing") };
}

export async function deleteLocalAsrModel(modelId: unknown): Promise<LocalAsrDownloadResult> {
  if (!isLocalAsrModelId(modelId)) throw new Error(`无效的 modelId: ${String(modelId)}`);
  try {
    await rm(modelFilePath(modelId), { force: true });
    await rm(modelMetaPath(modelId), { force: true });
    return { ok: true, status: await queryOneStatus(modelId) };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error),
      status: await queryOneStatus(modelId),
    };
  }
}

export async function checkLocalAsrSources(
  modelId: unknown = LOCAL_ASR_DEFAULT_MODEL_ID,
): Promise<LocalAsrSourcesResult> {
  const model = isLocalAsrModelId(modelId)
    ? localAsrModelById(modelId)
    : localAsrModelById(LOCAL_ASR_DEFAULT_MODEL_ID);
  return {
    modelId: model.id,
    sources: await Promise.all(LOCAL_ASR_DOWNLOAD_SOURCES.map((source) => checkOneSource(model, source))),
  };
}

async function queryOneStatus(modelId: LocalAsrModelId): Promise<LocalAsrModelStatus> {
  try {
    const info = await stat(modelFilePath(modelId));
    if (info.isFile() && info.size === localAsrModelById(modelId).sizeBytes) {
      return buildStatus(modelId, "ready", {
        path: modelFilePath(modelId),
        downloadedBytes: info.size,
        totalBytes: info.size,
      });
    }
  } catch {
    // 文件不存在是正常的 missing 状态。
  }
  if (activeDownload?.modelId === modelId && activeDownload.canceled) {
    return buildStatus(modelId, "missing");
  }
  if (downloadPromise && lastProgress?.modelId === modelId) {
    return buildStatus(modelId, "downloading", {
      downloadedBytes: lastProgress.downloadedBytes,
      totalBytes: lastProgress.totalBytes,
      speedBytesPerSecond: lastProgress.speedBytesPerSecond,
    });
  }
  return buildStatus(modelId, "missing");
}

async function runDownload(
  modelId: LocalAsrModelId,
  sourceId: LocalAsrDownloadSourceId,
): Promise<LocalAsrDownloadResult> {
  const model = localAsrModelById(modelId);
  const source = localAsrSourceById(sourceId);
  const target = modelFilePath(modelId);
  const tempPath = `${target}.download`;
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

  // 必须在第一个 await 之前登记句柄，cancel 才不会漏掉 mkdir 的等待窗口。
  activeDownload = { modelId, controller, tempPath, canceled: false };
  try {
    await mkdir(dirname(target), { recursive: true });
    connectTimer = setTimeout(() => {
      timeoutMessage = `连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）`;
      controller.abort();
    }, CONNECT_TIMEOUT_MS);
    const url = localAsrDownloadUrl(sourceId, modelId);
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent() },
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    connectTimer = undefined;
    resetStallTimer();
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const totalBytes = readContentLength(response.headers);
    if (totalBytes && totalBytes > model.maxBytes) throw new Error("模型大小超过白名单上限");

    let downloadedBytes = 0;
    const startedAt = Date.now();
    const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    emitProgress({ modelId, downloadedBytes: 0, totalBytes, speedBytesPerSecond: 0 });
    bodyStream.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      resetStallTimer();
      emitProgress({
        modelId,
        downloadedBytes,
        totalBytes,
        speedBytesPerSecond: downloadedBytes / Math.max(1, (Date.now() - startedAt) / 1000),
      });
      if (downloadedBytes > model.maxBytes) bodyStream.destroy(new Error("下载超过最大允许字节数"));
    });
    await pipeline(bodyStream, createWriteStream(tempPath));
    clearTimers();

    const info = await stat(tempPath);
    if (info.size !== model.sizeBytes) {
      throw new Error(`文件大小不符：期望 ${model.sizeBytes} 字节，实际 ${info.size} 字节`);
    }
    const actualHash = await fileSha256(tempPath);
    if (actualHash !== model.sha256) {
      throw new Error(`sha256 校验失败：期望 ${model.sha256}，实际 ${actualHash}`);
    }
    await rename(tempPath, target);
    await writeFile(modelMetaPath(modelId), JSON.stringify({
      modelId,
      fileName: model.fileName,
      sha256: model.sha256,
      sizeBytes: info.size,
      downloadSource: sourceId,
      downloadedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    return { ok: true, status: await queryOneStatus(modelId) };
  } catch (error) {
    const canceled = activeDownload?.modelId === modelId && activeDownload.canceled;
    clearTimers();
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (canceled) return { ok: true, status: buildStatus(modelId, "missing") };
    const message = `${source.label}: ${describeError(error, timeoutMessage)}`;
    return { ok: false, message, status: buildStatus(modelId, "error", { error: message }) };
  } finally {
    if (activeDownload?.modelId === modelId && activeDownload.tempPath === tempPath) {
      activeDownload = null;
    }
  }
}

async function checkOneSource(
  model: LocalAsrModel,
  source: LocalAsrSource,
): Promise<LocalAsrSourceStatus> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), SOURCE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(localAsrDownloadUrl(source.id, model.id), {
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
  modelId: LocalAsrModelId,
  state: LocalAsrModelStatus["state"],
  extra: Partial<LocalAsrModelStatus> = {},
): LocalAsrModelStatus {
  const model = localAsrModelById(modelId);
  return {
    modelId,
    label: model.label,
    fileName: model.fileName,
    sha256: model.sha256,
    sizeBytes: model.sizeBytes,
    maxBytes: model.maxBytes,
    resourceEstimate: { ...model.resourceEstimate },
    qualityTier: model.qualityTier,
    recommended: model.recommended,
    state,
    ...extra,
  };
}

function emitProgress(progress: LocalAsrModelProgress): void {
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
    return `CortexDesktop/${app.getVersion()} sensevoice`;
  } catch {
    return "CortexDesktop/dev sensevoice";
  }
}

function readContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
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
  return join(app.getPath("userData"), "models", "speech", "sensevoice");
}

export function modelFilePath(modelId: LocalAsrModelId): string {
  const model = localAsrModelById(modelId);
  return join(modelBaseDir(), model.id, model.fileName);
}

function modelMetaPath(modelId: LocalAsrModelId): string {
  return join(modelBaseDir(), modelId, "model.json");
}

export const _internals = {
  fileSha256,
  buildStatus,
  modelFilePath,
  resetState(): void {
    downloadPromise = null;
    progressEmitter = null;
    lastProgress = null;
    activeDownload = null;
  },
};
