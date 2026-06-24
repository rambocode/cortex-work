// download.test.ts — 流式下载工具单测
// 核心断言：
//   - 正常下载写盘/收集 Buffer 正确
//   - 累计字节数超过 maxBytes 时立即 cancel + 抛错（不等全量读完）
//   - 写盘失败时清理半成品文件
//   - 非 https:// URL 被拒绝

import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamDownloadToFile, streamDownloadToBuffer } from "./download";

// ── vi.hoisted：在 vi.mock 提升前定义可在 factory 内引用的 mock 实例 ──────────
// 只暴露测试用例中会直接 expect() 的 mock；内部构造变量留在闭包内不暴露。

const { mockWriteStreamWrite, mockWriteStreamDestroy, mockCreateWriteStream, mockUnlink } = vi.hoisted(() => {
  const mockWriteStreamWrite = vi.fn(
    (_chunk: unknown, cb: (err?: Error | null) => void) => { cb(null); return true; }
  );
  const mockWriteStreamDestroy = vi.fn();
  const writeStream = {
    write: mockWriteStreamWrite,
    end: vi.fn((cb: (err?: Error | null) => void) => { cb(null); }),
    destroy: mockWriteStreamDestroy,
    once: vi.fn(),
  };
  const mockCreateWriteStream = vi.fn(() => writeStream);
  const mockUnlink = vi.fn(
    (_path: string, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)
  );
  return { mockWriteStreamWrite, mockWriteStreamDestroy, mockCreateWriteStream, mockUnlink };
});

// ── mock node:fs（createWriteStream / unlink） ────────────────────────────────

vi.mock("node:fs", () => ({
  createWriteStream: mockCreateWriteStream,
  unlink: mockUnlink,
}));

// ── mock node:fs/promises（mkdir） ────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── 辅助：构造 ReadableStream mock ────────────────────────────────────────────

type ReadResult = { done: boolean; value: Uint8Array | undefined };

function makeBodyStream(chunks: Uint8Array[]) {
  const reads: ReadResult[] = chunks.map((c) => ({ done: false, value: c }));
  reads.push({ done: true, value: undefined });
  const cancelMock = vi.fn();
  const releaseLockMock = vi.fn();
  return {
    body: {
      getReader: () => {
        let idx = 0;
        return {
          read: vi.fn(() => Promise.resolve(reads[idx++]!)),
          releaseLock: releaseLockMock,
          cancel: cancelMock,
        };
      },
    },
    cancelMock,
    releaseLockMock,
  };
}

const DEST = "/workspace/.cortex/media/video/test.mp4";
const SIGNAL = new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteStreamWrite.mockImplementation((_chunk, cb) => { cb(null); return true; });
});

// ── streamDownloadToFile ──────────────────────────────────────────────────────

describe("streamDownloadToFile", () => {
  it("正常下载：写入所有 chunk，返回总字节数", async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const { body, cancelMock } = makeBodyStream([chunk1, chunk2]);

    mockFetch.mockResolvedValueOnce({ ok: true, body });

    const bytes = await streamDownloadToFile("https://cdn.example.com/v.mp4", {
      signal: SIGNAL,
      maxBytes: 1000,
      destPath: DEST,
      modality: "video",
    });

    expect(bytes).toBe(5);
    // write 应被调用两次（每个 chunk 一次）
    expect(mockWriteStreamWrite).toHaveBeenCalledTimes(2);
    // 正常完成不应调用 cancel
    expect(cancelMock).not.toHaveBeenCalled();
    // 正常完成不应清理文件
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("超过 maxBytes 时立即 cancel + 清理文件 + 抛错", async () => {
    const chunk = new Uint8Array(new Array(10).fill(0xab));
    const { body, cancelMock } = makeBodyStream([chunk]);

    mockFetch.mockResolvedValueOnce({ ok: true, body });

    await expect(
      streamDownloadToFile("https://cdn.example.com/v.mp4", {
        signal: SIGNAL,
        maxBytes: 5, // chunk 有 10 字节，必然超限
        destPath: DEST,
        modality: "video",
      }),
    ).rejects.toThrow(/超过大小限制/);

    // 超限应立即 cancel reader
    expect(cancelMock).toHaveBeenCalled();
    // 应清理半成品文件
    expect(mockUnlink).toHaveBeenCalledWith(DEST, expect.any(Function));
    // WriteStream 应被 destroy（不再继续写）
    expect(mockWriteStreamDestroy).toHaveBeenCalled();
  });

  it("非 https:// URL 被拒绝（不发 fetch）", async () => {
    await expect(
      streamDownloadToFile("http://evil.com/v.mp4", {
        signal: SIGNAL,
        maxBytes: 1000,
        destPath: DEST,
        modality: "video",
      }),
    ).rejects.toThrow(/https:\/\//);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("HTTP 错误时抛出含状态码的错误", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, body: null });

    await expect(
      streamDownloadToFile("https://cdn.example.com/v.mp4", {
        signal: SIGNAL,
        maxBytes: 1000,
        destPath: DEST,
        modality: "video",
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("写盘失败时 destroy WriteStream + 清理文件 + 向上抛错", async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const { body } = makeBodyStream([chunk]);
    const writeError = new Error("磁盘写入失败");

    mockFetch.mockResolvedValueOnce({ ok: true, body });
    // 模拟写盘失败
    mockWriteStreamWrite.mockImplementation((_chunk, cb) => { cb(writeError); return true; });

    await expect(
      streamDownloadToFile("https://cdn.example.com/v.mp4", {
        signal: SIGNAL,
        maxBytes: 1000,
        destPath: DEST,
        modality: "video",
      }),
    ).rejects.toThrow(/磁盘写入失败/);

    expect(mockWriteStreamDestroy).toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(DEST, expect.any(Function));
  });

  it("响应缺少 body 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, body: null });

    await expect(
      streamDownloadToFile("https://cdn.example.com/v.mp4", {
        signal: SIGNAL,
        maxBytes: 1000,
        destPath: DEST,
        modality: "video",
      }),
    ).rejects.toThrow(/ReadableStream/);
  });
});

// ── streamDownloadToBuffer ────────────────────────────────────────────────────

describe("streamDownloadToBuffer", () => {
  it("正常下载：返回合并 Buffer", async () => {
    const chunk1 = new Uint8Array([10, 20]);
    const chunk2 = new Uint8Array([30]);
    const { body } = makeBodyStream([chunk1, chunk2]);

    mockFetch.mockResolvedValueOnce({ ok: true, body });

    const buf = await streamDownloadToBuffer("https://cdn.example.com/img.png", {
      signal: SIGNAL,
      maxBytes: 1000,
      modality: "image",
    });

    expect(buf).toBeInstanceOf(Buffer);
    expect(Array.from(buf)).toEqual([10, 20, 30]);
  });

  it("超过 maxBytes 时立即 cancel + 抛错（不继续读剩余内容）", async () => {
    const bigChunk = new Uint8Array(new Array(100).fill(0xff));
    const { body, cancelMock } = makeBodyStream([bigChunk]);

    mockFetch.mockResolvedValueOnce({ ok: true, body });

    await expect(
      streamDownloadToBuffer("https://cdn.example.com/img.png", {
        signal: SIGNAL,
        maxBytes: 50, // 100 字节 chunk 超出 50 字节限制
        modality: "image",
      }),
    ).rejects.toThrow(/超过大小限制/);

    expect(cancelMock).toHaveBeenCalled();
  });

  it("非 https:// URL 被拒绝", async () => {
    await expect(
      streamDownloadToBuffer("ftp://cdn.example.com/img.png", {
        signal: SIGNAL,
        maxBytes: 1000,
        modality: "image",
      }),
    ).rejects.toThrow(/https:\/\//);
  });
});
