// download.ts — 流式 URL 下载工具（主进程）。
//
// 为什么需要流式 + 早停（KTD11 / ADV-006）：
//   res.arrayBuffer() 会把整个响应体一次性读进 V8 堆。视频最大限制为 500MB，
//   若遭遇恶意/异常大响应，堆将在 assertResponseSize 执行前就已耗尽或严重膨胀。
//   正确做法是边读边计数：累计字节数超过 maxBytes 时立即 reader.cancel() 并抛错，
//   不再继续读取；同时所有数据直接落盘，避免大 Buffer 常驻内存。
//
// 两个公开 API：
//   - streamDownloadToFile  — 直接写盘（视频/音乐/语音 URL 下载推荐）
//   - streamDownloadToBuffer — 收集到内存（小图片 URL 下载可接受；上限靠 maxBytes 保证）

import { createWriteStream, unlink } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ── 内部：从响应流边读边计数，超限立即中止 ────────────────────────────────────

/**
 * 从 Response.body（WHATWG ReadableStream）流式读取，按 chunk 累加字节数。
 * 超过 maxBytes 时立即 reader.cancel() + 抛出大小超限错误。
 * 每个 chunk 通过 onChunk 回调交给调用方（写盘/收集 Buffer 均可）。
 *
 * @returns 实际读取的总字节数
 */
async function drainStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  modality: string,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const reader = body.getReader();
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;

      // 边读边计数，超限立即取消，不继续读剩余内容（防止大响应占满堆）
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new Error(
          `[${modality}] 响应体超过大小限制（已读 ${bytesRead} > ${maxBytes} bytes），下载已中止`,
        );
      }

      await onChunk(value);
    }
  } finally {
    // 确保 reader 总能释放（cancel 幂等，重复调用无副作用）
    reader.releaseLock();
  }

  return bytesRead;
}

// ── streamDownloadToFile ─────────────────────────────────────────────────────

export interface StreamDownloadToFileOptions {
  /** fetch AbortSignal（超时 / 取消均可中止下载）。*/
  signal: AbortSignal;
  /** 响应体字节数上限；超过立即中止，不等到全量读完。*/
  maxBytes: number;
  /** 写入目标文件的绝对路径；若目录不存在会自动创建。*/
  destPath: string;
  /** 模态名称（用于错误信息，如 'video' / 'music'）。*/
  modality: string;
}

/**
 * 流式下载 URL 并直接落盘，避免整块响应进堆。
 *
 * - 使用 WHATWG ReadableStream reader 按 chunk 读取
 * - 累计字节数超过 maxBytes 时立即 reader.cancel() + 清理半成品文件 + 抛错
 * - AbortSignal 串联到 fetch：超时 / 外部取消均能真正中止下载
 * - 写盘失败时也会清理半成品文件
 *
 * @returns 写入的总字节数
 */
export async function streamDownloadToFile(
  url: string,
  opts: StreamDownloadToFileOptions,
): Promise<number> {
  const { signal, maxBytes, destPath, modality } = opts;

  // 安全：只允许 https://（与原 downloadHttpsUrl / downloadUrl 保持一致）
  if (!url.startsWith("https://")) {
    throw new Error(`[${modality}] 下载 URL 必须为 https://，当前: ${url}`);
  }

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`[${modality}] 下载失败 HTTP ${res.status}: ${url}`);
  }

  if (!res.body) {
    throw new Error(`[${modality}] 响应缺少 body（ReadableStream），无法流式下载`);
  }

  // 确保目标目录存在（调用方也会 mkdir，但这里做一次防御）
  await mkdir(dirname(destPath), { recursive: true });

  // 用 node:fs createWriteStream 写盘（WriteStream 不是 WHATWG，不能 pipeTo，手动 drain）
  const writeStream = createWriteStream(destPath);

  let bytesWritten = 0;
  try {
    bytesWritten = await drainStream(res.body, maxBytes, modality, async (chunk) => {
      // node WriteStream.write 是同步写入底层 buffer，此处 wrap 成 Promise 保证背压
      await new Promise<void>((resolve, reject) => {
        const ok = writeStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
        // 若内部 buffer 已满（ok===false），等待 drain 事件再继续
        if (!ok) {
          writeStream.once("drain", resolve);
        }
      });
    });
  } catch (err) {
    // 下载失败 / 超限 / signal abort → 关闭并删除半成品文件
    writeStream.destroy();
    await tryUnlink(destPath);
    throw err;
  }

  // 正常完成：关闭 WriteStream，等待 finish 确认落盘
  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return bytesWritten;
}

// ── streamDownloadToBuffer ────────────────────────────────────────────────────

export interface StreamDownloadToBufferOptions {
  /** fetch AbortSignal（超时 / 取消均可中止下载）。*/
  signal: AbortSignal;
  /** 响应体字节数上限；超过立即中止，不等到全量读完。*/
  maxBytes: number;
  /** 模态名称（用于错误信息）。*/
  modality: string;
}

/**
 * 流式下载 URL 并收集到 Buffer（适合已有 maxBytes 保证的小图片场景）。
 *
 * 相比 res.arrayBuffer()，此版本在累计超过 maxBytes 时立即 reader.cancel() 中止，
 * 不会把超大响应全量加载进堆后才抛错。
 *
 * @returns 下载内容的 Buffer
 */
export async function streamDownloadToBuffer(
  url: string,
  opts: StreamDownloadToBufferOptions,
): Promise<Buffer> {
  const { signal, maxBytes, modality } = opts;

  if (!url.startsWith("https://")) {
    throw new Error(`[${modality}] 下载 URL 必须为 https://，当前: ${url}`);
  }

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`[${modality}] 下载失败 HTTP ${res.status}: ${url}`);
  }

  if (!res.body) {
    throw new Error(`[${modality}] 响应缺少 body（ReadableStream），无法流式下载`);
  }

  const chunks: Uint8Array[] = [];
  await drainStream(res.body, maxBytes, modality, async (chunk) => {
    chunks.push(chunk);
  });

  return Buffer.concat(chunks);
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

/** 安静删除文件，忽略不存在等错误（用于清理半成品）。*/
async function tryUnlink(path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    unlink(path, () => resolve());
  });
}
