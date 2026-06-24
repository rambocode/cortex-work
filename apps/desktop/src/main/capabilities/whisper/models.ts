// 本地 Whisper 模型管理（主进程）。
// 职责：模型状态查询、下载（含进度推送）、取消、删除、下载源检测。
// 不包含 runner spawn 转写（U8）。
//
// KTD11 安全收口：
//   - modelId 拼路径前必须通过清单白名单校验（isLocalWhisperModelId）
//   - 下载 URL 来自清单（whisperDownloadUrl），断言 https: 前缀，不接受网络重定向写入
//   - sha256/maxBytes 全从清单读取，不信任网络侧数据
//
// 并发约束（KTD5）：
//   - 同时只能运行一个下载（互斥锁 downloadPromise + activeDownload）
//   - 进度经 setWhisperProgressEmitter 回调推送，不写 Zustand

import { app } from "electron";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

import {
  WHISPER_DOWNLOAD_SOURCES,
  WHISPER_MODELS,
  isLocalWhisperModelId,
  isWhisperDownloadSourceId,
  whisperDownloadUrl,
  whisperModelById,
  whisperSourceById,
  WHISPER_DEFAULT_MODEL_ID,
  type LocalWhisperModelId,
  type LocalWhisperModelProgress,
  type LocalWhisperModelStatus,
  type LocalWhisperSourceStatus,
  type LocalWhisperSourcesResult,
  type WhisperDownloadSourceId,
} from "@cortex-work/core/whisper/models";

// ── 超时常量 ──────────────────────────────────────────────────────────────────
const CONNECT_TIMEOUT_MS = 20_000;  // 连接超时（与 Kun 对齐）
const STALL_TIMEOUT_MS = 30_000;    // 传输停滞超时
const SOURCE_CHECK_TIMEOUT_MS = 8_000; // 源检测超时

// ── 模块级单例 ────────────────────────────────────────────────────────────────

type LocalWhisperModel = (typeof WHISPER_MODELS)[number];
type LocalWhisperDownloadSource = (typeof WHISPER_DOWNLOAD_SOURCES)[number];

/** 当前正在进行的下载 Promise（互斥锁）。*/
let downloadPromise: Promise<WhisperDownloadResult> | null = null;

/** 进度推送回调（由 IPC 层注入）。不为 null 则下载中周期回调。*/
let progressEmitter: ((progress: LocalWhisperModelProgress) => void) | null = null;

/** 最后一次进度快照，供 getModelStatus 补拉（挂载前错过推送时）。*/
let lastProgress: LocalWhisperModelProgress | null = null;

/** 当前活跃下载句柄（用于 cancel + 错误判断）。*/
let activeDownload: {
  modelId: LocalWhisperModelId;
  controller: AbortController;
  tempPath: string;
  canceled: boolean;
} | null = null;

// ── 下载结果类型（与 Kun 对齐）────────────────────────────────────────────────

export type WhisperDownloadResult =
  | { ok: true; status: LocalWhisperModelStatus }
  | { ok: false; message: string; status?: LocalWhisperModelStatus };

// ── 进度 emitter ──────────────────────────────────────────────────────────────

/** 由 IPC 层（stt.ts）在注册时设置，把进度广播给 webContents。*/
export function setWhisperProgressEmitter(
  cb: ((progress: LocalWhisperModelProgress) => void) | null,
): void {
  progressEmitter = cb;
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 查询指定模型（或全部模型）的状态。
 * modelId 为 undefined → 返回所有模型状态。
 */
export async function getModelStatus(
  modelId?: unknown,
): Promise<LocalWhisperModelStatus | LocalWhisperModelStatus[]> {
  if (modelId === undefined || modelId === null) {
    // 返回全部模型状态
    return Promise.all(WHISPER_MODELS.map((m) => queryOneStatus(m.id)));
  }
  // KTD11：白名单校验
  if (!isLocalWhisperModelId(modelId)) {
    throw new Error(`无效的 modelId: ${String(modelId)}`);
  }
  return queryOneStatus(modelId);
}

/**
 * 下载指定模型（从指定源）。
 * 互斥：同时只允许一个下载进行，第二次调用直接返回同一 Promise。
 */
export async function downloadModel(args: {
  modelId: unknown;
  sourceId: unknown;
}): Promise<WhisperDownloadResult> {
  // KTD11：白名单校验
  if (!isLocalWhisperModelId(args.modelId)) {
    throw new Error(`无效的 modelId: ${String(args.modelId)}`);
  }
  const model = whisperModelById(args.modelId);

  // sourceId 允许使用默认源
  const sourceId: WhisperDownloadSourceId = isWhisperDownloadSourceId(args.sourceId)
    ? args.sourceId
    : "huggingface";

  const current = await queryOneStatus(model.id);
  if (current.state === "ready") return { ok: true, status: current };

  // 互斥锁：正在下载时直接复用
  if (downloadPromise) return downloadPromise;

  downloadPromise = runDownload(model.id, sourceId).finally(() => {
    downloadPromise = null;
    lastProgress = null;
  });
  return downloadPromise;
}

/**
 * 取消正在进行的下载（幂等）。
 * 清除临时文件，返回 missing 状态。
 */
export async function cancelDownload(
  modelId: unknown,
): Promise<WhisperDownloadResult> {
  if (!isLocalWhisperModelId(modelId)) {
    throw new Error(`无效的 modelId: ${String(modelId)}`);
  }
  const model = whisperModelById(modelId);
  if (!activeDownload || activeDownload.modelId !== model.id) {
    // 没有进行中的下载，幂等返回
    return { ok: true, status: await queryOneStatus(model.id) };
  }
  activeDownload.canceled = true;
  activeDownload.controller.abort();
  await rm(activeDownload.tempPath, { force: true }).catch(() => undefined);
  return { ok: true, status: buildStatus(model.id, "missing") };
}

/**
 * 删除已下载的模型文件 + model.json 元数据。
 */
export async function deleteModel(
  modelId: unknown,
): Promise<WhisperDownloadResult> {
  if (!isLocalWhisperModelId(modelId)) {
    throw new Error(`无效的 modelId: ${String(modelId)}`);
  }
  const model = whisperModelById(modelId);
  try {
    await rm(modelFilePath(model.id), { force: true });
    await rm(modelMetaPath(model.id), { force: true });
    return { ok: true, status: await queryOneStatus(model.id) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      status: await queryOneStatus(model.id),
    };
  }
}

/**
 * 检测各下载源对指定模型的可达性（并行 HEAD Range: bytes=0-0）。
 * modelId 为 undefined → 使用默认模型（只需要 fileName）。
 */
export async function checkSources(
  modelId: unknown = WHISPER_DEFAULT_MODEL_ID,
): Promise<LocalWhisperSourcesResult> {
  // 非法 modelId 回退默认模型（checkSources 不做转写，安全影响低）
  const model = isLocalWhisperModelId(modelId)
    ? whisperModelById(modelId)
    : whisperModelById(WHISPER_DEFAULT_MODEL_ID);

  const sources = await Promise.all(
    WHISPER_DOWNLOAD_SOURCES.map((src) => checkOneSource(model, src)),
  );
  return { modelId: model.id, sources };
}

// ── 内部：状态查询 ────────────────────────────────────────────────────────────

async function queryOneStatus(
  modelId: LocalWhisperModelId,
): Promise<LocalWhisperModelStatus> {
  const diskStatus = await readDiskStatus(modelId);
  if (diskStatus) return diskStatus;

  // 已取消的下载 → missing
  if (activeDownload?.modelId === modelId && activeDownload.canceled) {
    return buildStatus(modelId, "missing");
  }
  // 进行中 → 回填最后进度（补拉语义）
  if (downloadPromise && lastProgress?.modelId === modelId) {
    return buildStatus(modelId, "downloading", {
      downloadedBytes: lastProgress.downloadedBytes,
      totalBytes: lastProgress.totalBytes,
      speedBytesPerSecond: lastProgress.speedBytesPerSecond,
    });
  }
  return buildStatus(modelId, "missing");
}

async function readDiskStatus(
  modelId: LocalWhisperModelId,
): Promise<LocalWhisperModelStatus | null> {
  const path = modelFilePath(modelId);
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return buildStatus(modelId, "ready", {
      path,
      downloadedBytes: info.size,
      totalBytes: info.size,
    });
  } catch {
    return null;
  }
}

// ── 内部：下载 ────────────────────────────────────────────────────────────────

async function runDownload(
  modelId: LocalWhisperModelId,
  sourceId: WhisperDownloadSourceId,
): Promise<WhisperDownloadResult> {
  const model = whisperModelById(modelId);
  const source = whisperSourceById(sourceId);
  const target = modelFilePath(modelId);
  const tempPath = `${target}.download`;

  const controller = new AbortController();
  let timeoutMessage = `下载停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒`;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (connectTimer) clearTimeout(connectTimer);
    if (stallTimer) clearTimeout(stallTimer);
  };
  const resetStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      timeoutMessage = `下载停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒`;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  // ⚠️ 竞态修复（ADV-004）：必须在第一个 await（mkdir）之前同步设置 activeDownload。
  // 若在 await 之后设置，cancelDownload 在 mkdir 等待窗口内调用时，
  // 见到 activeDownload===null 会返回 ok:true 但实际什么都没中止，下载继续进行。
  activeDownload = { modelId, controller, tempPath, canceled: false };

  try {
    // 确保目录存在
    await mkdir(dirname(target), { recursive: true });

    // 连接超时守卫
    connectTimer = setTimeout(() => {
      timeoutMessage = `连接超时（${Math.round(CONNECT_TIMEOUT_MS / 1000)} 秒内未建立）`;
      controller.abort();
    }, CONNECT_TIMEOUT_MS);

    // KTD11：URL 从清单派生，含 https: 断言
    const url = whisperDownloadUrl(model.fileName, sourceId);
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent() },
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    connectTimer = undefined;
    resetStallTimer();

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const totalBytes = readContentLength(response.headers);
    if (totalBytes && totalBytes > model.maxBytes) {
      throw new Error(
        `模型大小超过限制（${Math.round(model.maxBytes / 1024 / 1024)} MB）`,
      );
    }

    let downloadedBytes = 0;
    const startedAt = Date.now();
    const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

    // 初始进度（0 字节）
    emitProgress({ modelId, downloadedBytes: 0, totalBytes, speedBytesPerSecond: 0 });

    bodyStream.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      resetStallTimer();
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
      emitProgress({
        modelId,
        downloadedBytes,
        totalBytes,
        speedBytesPerSecond: downloadedBytes / elapsedSeconds,
      });
      // maxBytes 上限防护（写盘前截断）
      if (downloadedBytes > model.maxBytes) {
        bodyStream.destroy(new Error("下载超过最大允许字节数"));
      }
    });

    await pipeline(bodyStream, createWriteStream(tempPath));
    clearTimers();

    // 精确大小校验
    const info = await stat(tempPath);
    if (info.size !== model.sizeBytes) {
      throw new Error(
        `文件大小不符：期望 ${model.sizeBytes} 字节，实际 ${info.size} 字节`,
      );
    }

    // sha256 校验（KTD11：hash 值从清单读取，不信任网络侧）
    const actualHash = await fileSha256(tempPath);
    if (actualHash !== model.sha256) {
      throw new Error(`sha256 校验失败：期望 ${model.sha256}，实际 ${actualHash}`);
    }

    // 原子重命名（覆盖旧文件安全）
    await rename(tempPath, target);

    // 写元数据 model.json
    await writeFile(
      modelMetaPath(modelId),
      JSON.stringify(
        {
          modelId: model.id,
          fileName: model.fileName,
          sha256: model.sha256,
          sizeBytes: info.size,
          downloadSource: sourceId,
          downloadSourceLabel: source.label,
          downloadUrl: url,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    return { ok: true, status: await queryOneStatus(modelId) };
  } catch (error) {
    const canceled =
      activeDownload?.modelId === modelId && activeDownload.canceled;
    clearTimers();
    // 失败清理临时文件
    await rm(tempPath, { force: true }).catch(() => undefined);

    if (canceled) {
      return { ok: true, status: buildStatus(modelId, "missing") };
    }

    const message = describeError(error, timeoutMessage);
    return {
      ok: false,
      message: `${source.label}: ${message}`,
      status: buildStatus(modelId, "error", {
        error: `${source.label}: ${message}`,
      }),
    };
  } finally {
    // 清除活跃下载句柄
    if (
      activeDownload?.modelId === modelId &&
      activeDownload.tempPath === tempPath
    ) {
      activeDownload = null;
    }
  }
}

// ── 内部：源检测 ──────────────────────────────────────────────────────────────

async function checkOneSource(
  model: LocalWhisperModel,
  source: LocalWhisperDownloadSource,
): Promise<LocalWhisperSourceStatus> {
  // KTD11：URL 从清单派生，含 https: 断言
  const url = whisperDownloadUrl(model.fileName, source.id as WhisperDownloadSourceId);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), SOURCE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        Range: "bytes=0-0",
        "User-Agent": userAgent(),
      },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    const responseTimeMs = Date.now() - startedAt;
    const available = response.status === 200 || response.status === 206;
    return {
      sourceId: source.id as WhisperDownloadSourceId,
      label: source.label,
      state: available ? "available" : "unavailable",
      httpStatus: response.status,
      responseTimeMs,
      message: available ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      sourceId: source.id as WhisperDownloadSourceId,
      label: source.label,
      state: "unavailable",
      responseTimeMs: Date.now() - startedAt,
      message: describeError(
        error,
        `源检测超时（${Math.round(SOURCE_CHECK_TIMEOUT_MS / 1000)} 秒）`,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 内部：工具函数 ────────────────────────────────────────────────────────────

/** 构造模型基础状态对象。*/
function buildStatus(
  modelId: LocalWhisperModelId,
  state: LocalWhisperModelStatus["state"],
  extra: Partial<LocalWhisperModelStatus> = {},
): LocalWhisperModelStatus {
  const model = whisperModelById(modelId);
  return {
    modelId: model.id,
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

function emitProgress(progress: LocalWhisperModelProgress): void {
  const percent =
    progress.totalBytes && progress.totalBytes > 0
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
    return `CortexDesktop/${app.getVersion()} local-whisper`;
  } catch {
    return "CortexDesktop/dev local-whisper";
  }
}

function readContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function describeError(error: unknown, timeoutMessage: string): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "AbortError") return timeoutMessage;
  if (
    /aborted|terminated|network|fetch failed|socket|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(
      msg,
    )
  ) {
    return `网络连接中断: ${msg}`;
  }
  return msg;
}

// ── 路径工具 ──────────────────────────────────────────────────────────────────

/** 存储根目录：<userData>/models/speech/whisper */
function whisperBaseDir(): string {
  return join(app.getPath("userData"), "models", "speech", "whisper");
}

/** 模型文件路径：<base>/<modelId>/<fileName> */
export function modelFilePath(modelId: LocalWhisperModelId): string {
  const model = whisperModelById(modelId);
  return join(whisperBaseDir(), model.id, model.fileName);
}

/** 元数据文件路径：<base>/<modelId>/model.json */
function modelMetaPath(modelId: LocalWhisperModelId): string {
  return join(whisperBaseDir(), modelId, "model.json");
}

// ── 测试内部钩子（仅供单测使用）────────────────────────────────────────────────
export const _internals = {
  fileSha256,
  checkOneSource,
  modelFilePath,
  modelMetaPath,
  buildStatus,
  /** 单测注入活跃下载状态，绕过真实 fetch。*/
  setDownloadStateForTest(
    progress: LocalWhisperModelProgress | null,
    tempPath = "/tmp/test.download",
  ): void {
    lastProgress = progress;
    if (progress) {
      activeDownload = {
        modelId: progress.modelId,
        controller: new AbortController(),
        tempPath,
        canceled: false,
      };
      downloadPromise = Promise.resolve({ ok: false as const, message: "test" });
    } else {
      activeDownload = null;
      downloadPromise = null;
    }
  },
  resetState(): void {
    downloadPromise = null;
    progressEmitter = null;
    lastProgress = null;
    activeDownload = null;
  },
};
