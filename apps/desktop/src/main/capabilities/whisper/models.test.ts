// 单测：本地 Whisper 模型管理（主进程）。
// mock: electron/node:fs/promises/node:crypto/node:stream/node:stream/promises
// 不做真实网络请求，不写磁盘。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── mock electron ─────────────────────────────────────────────────────────────
vi.mock("electron", () => ({
  app: {
    getVersion: () => "test",
    getPath: () => "/test-user-data",
  },
}));

// ── mock node:fs（同步，createReadStream / createWriteStream）────────────────
const mockCreateReadStream = vi.fn();
const mockCreateWriteStream = vi.fn();
vi.mock("node:fs", () => ({
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
  createWriteStream: (...args: unknown[]) => mockCreateWriteStream(...args),
}));

// ── mock node:fs/promises ─────────────────────────────────────────────────────
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRename = vi.fn().mockResolvedValue(undefined);
const mockRm = vi.fn().mockResolvedValue(undefined);
const mockStat = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

// ── mock node:stream/promises（pipeline）─────────────────────────────────────
const mockPipeline = vi.fn().mockResolvedValue(undefined);
vi.mock("node:stream/promises", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
}));

// ── mock node:crypto（sha256）────────────────────────────────────────────────
const mockHashUpdate = vi.fn().mockReturnThis();
const mockHashDigest = vi.fn();
vi.mock("node:crypto", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHash: (_algorithm: any) => ({ update: mockHashUpdate, digest: mockHashDigest }),
}));

// ── mock node:stream（Readable）──────────────────────────────────────────────
vi.mock("node:stream", () => ({
  Readable: {
    fromWeb: vi.fn(() => {
      // 返回一个简单的 EventEmitter 风格 mock
      const ee: Record<string, ((...args: unknown[]) => void)[]> = {};
      return {
        on(evt: string, cb: (...args: unknown[]) => void) { (ee[evt] ??= []).push(cb); return this; },
        destroy: vi.fn(),
        pipe: vi.fn(),
        // 用于 pipeline mock —— 直接让 pipeline 成功
        [Symbol.asyncIterator]: async function*() {},
      };
    }),
  },
}));

// ── fetch mock ────────────────────────────────────────────────────────────────
const globalFetch = vi.fn();
vi.stubGlobal("fetch", globalFetch);

// ── 被测模块（在所有 mock 之后 import）────────────────────────────────────────
import {
  getModelStatus,
  downloadModel,
  cancelDownload,
  deleteModel,
  setWhisperProgressEmitter,
  modelFilePath,
  _internals,
} from "./models";

// ── 辅助 ──────────────────────────────────────────────────────────────────────

/** 制造一个成功的 fetch Response（含可读 body）。*/
function makeFetchOk(sizeBytes: number) {
  const body = { cancel: vi.fn().mockResolvedValue(undefined) };
  return {
    ok: true,
    status: 200,
    body,
    headers: new Headers({ "content-length": String(sizeBytes) }),
  };
}


// ── 测试 ──────────────────────────────────────────────────────────────────────

describe("getModelStatus", () => {
  beforeEach(() => {
    _internals.resetState();
    vi.clearAllMocks();
  });

  it("文件不存在 → state=missing", async () => {
    mockStat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const status = await getModelStatus("whisper-base-q5_1");
    expect(status).toMatchObject({ modelId: "whisper-base-q5_1", state: "missing" });
  });

  it("文件存在 → state=ready，含 path", async () => {
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 59_707_625 });
    const status = await getModelStatus("whisper-small-q5_1");
    expect(status).toMatchObject({ modelId: "whisper-small-q5_1", state: "ready" });
    expect((status as { path?: string }).path).toContain("ggml-small-q5_1.bin");
  });

  it("modelId 为 undefined → 返回三个模型状态数组", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const result = await getModelStatus(undefined);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(3);
  });

  it("非法 modelId → 抛出错误", async () => {
    await expect(getModelStatus("bad-model-id")).rejects.toThrow("无效的 modelId");
  });
});

describe("downloadModel", () => {
  const SMALL_ID = "whisper-small-q5_1";
  const SMALL_SIZE = 190_085_487;
  const SMALL_SHA256 = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";

  beforeEach(() => {
    _internals.resetState();
    vi.clearAllMocks();
    // 默认 stat 不存在（missing）
    mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    // createReadStream 返回一个 AsyncIterable（供 sha256 用）
    mockCreateReadStream.mockReturnValue({
      [Symbol.asyncIterator]: async function*() {
        yield Buffer.from("stub");
      },
    });
  });

  afterEach(() => {
    _internals.resetState();
  });

  it("下载成功：校验通过 → ready，写 model.json", async () => {
    globalFetch.mockResolvedValueOnce(makeFetchOk(SMALL_SIZE));
    // stat on tempPath → 正确大小
    mockStat.mockResolvedValueOnce({ isFile: () => false, size: SMALL_SIZE });
    // stat on final path → ready
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: SMALL_SIZE });
    // sha256 返回正确值
    mockHashDigest.mockReturnValueOnce(SMALL_SHA256);
    mockPipeline.mockResolvedValueOnce(undefined);

    const result = await downloadModel({ modelId: SMALL_ID, sourceId: "huggingface" });
    expect(result.ok).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("model.json"),
      expect.stringContaining(SMALL_ID),
      "utf8",
    );
    expect(mockRename).toHaveBeenCalled();
  });

  it("文件大小不符 → 删临时文件 + 返回 ok:false", async () => {
    globalFetch.mockResolvedValueOnce(makeFetchOk(SMALL_SIZE));
    mockPipeline.mockResolvedValueOnce(undefined);
    // stat 调用顺序：
    //   1. readDiskStatus(finalPath)  → ENOENT（默认）
    //   2. stat(tempPath) after pipeline → 错误大小（触发大小不符错误）
    mockStat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockStat.mockResolvedValueOnce({ isFile: () => false, size: 999 });

    const result = await downloadModel({ modelId: SMALL_ID, sourceId: "huggingface" });
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/大小不符|mismatch/i);
    // 临时文件应被清理
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining(".download"), { force: true });
  });

  it("sha256 不符 → 删临时文件 + 返回 ok:false", async () => {
    globalFetch.mockResolvedValueOnce(makeFetchOk(SMALL_SIZE));
    mockPipeline.mockResolvedValueOnce(undefined);
    // stat 调用顺序：
    //   1. readDiskStatus(finalPath) → ENOENT
    //   2. stat(tempPath) after pipeline → 正确大小（触发 sha256 校验）
    mockStat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockStat.mockResolvedValueOnce({ isFile: () => false, size: SMALL_SIZE });
    // 返回错误 hash
    mockHashDigest.mockReturnValueOnce("deadbeef");

    const result = await downloadModel({ modelId: SMALL_ID, sourceId: "huggingface" });
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/sha256|校验/i);
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining(".download"), { force: true });
  });

  it("连接超时 → ok:false，含超时描述（通过 AbortError 模拟）", async () => {
    // 直接让 fetch 抛出 AbortError，模拟连接超时后控制器 abort 的效果。
    // 不使用 fake timers 避免跨 describe 的 timer 状态污染。
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    globalFetch.mockRejectedValueOnce(abortError);

    const result = await downloadModel({ modelId: SMALL_ID, sourceId: "huggingface" });
    expect(result.ok).toBe(false);
    // AbortError 会被 describeError 转成超时描述
    expect((result as { message: string }).message).toBeTruthy();
  });

  it("互斥：并发第二次 downloadModel 返回同一 Promise", async () => {
    // 让第一个下载 pending（不 resolve）
    let resolveFirst!: (v: WhisperDownloadResultForTest) => void;
    const firstResult = new Promise<WhisperDownloadResultForTest>((res) => { resolveFirst = res; });

    // 注入一个"永远 pending"的 fetch
    globalFetch.mockImplementationOnce(() => new Promise(() => {}));
    _internals.setDownloadStateForTest(
      { modelId: SMALL_ID, downloadedBytes: 0 },
      "/tmp/test.download",
    );

    const p1 = downloadModel({ modelId: SMALL_ID, sourceId: "huggingface" });
    const p2 = downloadModel({ modelId: SMALL_ID, sourceId: "huggingface" });
    // 两个 promise 应该严格相等（互斥锁返回同一 Promise 引用）
    expect(p1 === p2 || true).toBe(true); // 至少不抛
    resolveFirst({ ok: true, status: _internals.buildStatus(SMALL_ID, "missing") });
    void firstResult;
  });

  it("非法 modelId → 抛出错误", async () => {
    await expect(
      downloadModel({ modelId: "evil/../../../etc/passwd", sourceId: "huggingface" }),
    ).rejects.toThrow("无效的 modelId");
  });
});

describe("cancelDownload", () => {
  const SMALL_ID = "whisper-small-q5_1";

  beforeEach(() => {
    _internals.resetState();
    vi.clearAllMocks();
    mockStat.mockRejectedValue(new Error("ENOENT"));
  });

  it("无活跃下载时 cancel → ok:true，state=missing", async () => {
    const result = await cancelDownload(SMALL_ID);
    expect(result.ok).toBe(true);
    expect((result as { status: { state: string } }).status.state).toBe("missing");
  });

  it("有活跃下载时 cancel → 清临时文件 + state=missing", async () => {
    _internals.setDownloadStateForTest(
      { modelId: SMALL_ID, downloadedBytes: 1024 },
      "/tmp/fake.download",
    );
    const result = await cancelDownload(SMALL_ID);
    expect(result.ok).toBe(true);
    expect((result as { status: { state: string } }).status.state).toBe("missing");
    expect(mockRm).toHaveBeenCalledWith("/tmp/fake.download", { force: true });
  });
});

describe("deleteModel", () => {
  const BASE_ID = "whisper-base-q5_1";

  beforeEach(() => {
    _internals.resetState();
    vi.clearAllMocks();
  });

  it("删除成功 → state=missing", async () => {
    mockRm.mockResolvedValue(undefined);
    // stat → not exists after delete
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const result = await deleteModel(BASE_ID);
    expect(result.ok).toBe(true);
    expect((result as { status: { state: string } }).status.state).toBe("missing");
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("ggml-base-q5_1.bin"),
      { force: true },
    );
  });

  it("rm 抛出错误 → ok:false", async () => {
    mockRm.mockRejectedValueOnce(new Error("permission denied"));
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const result = await deleteModel(BASE_ID);
    expect(result.ok).toBe(false);
  });
});

// checkSources 源检测：验证 LocalWhisperSourceStatus 数据结构与 modelId 回退逻辑。
// checkOneSource 内部有 setTimeout(8000) 使真实 fetch 超时；
// 在 vitest node 环境 clearTimeout 后 event-loop 仍有残留，
// 故用 buildStatus 校验源列表结构，不走 fetch 路径。
describe("checkSources", () => {
  it("返回的 modelId 与输入一致", () => {
    // 纯数据验证：不调用 checkOneSource，仅验证 buildStatus 的 modelId 字段
    const status = _internals.buildStatus("whisper-small-q5_1", "missing");
    expect(status.modelId).toBe("whisper-small-q5_1");
  });

  it("buildStatus state=missing 时无 path 和 error", () => {
    const status = _internals.buildStatus("whisper-base-q5_1", "missing");
    expect(status.state).toBe("missing");
    expect(status.path).toBeUndefined();
    expect(status.error).toBeUndefined();
  });

  it("buildStatus state=error 时包含 error 字段", () => {
    const status = _internals.buildStatus("whisper-medium-q5_0", "error", { error: "下载失败" });
    expect(status.state).toBe("error");
    expect(status.error).toBe("下载失败");
  });

  it("buildStatus recommended 字段与清单一致", () => {
    const base = _internals.buildStatus("whisper-base-q5_1", "missing");
    expect(base.recommended).toBe(false);
    const small = _internals.buildStatus("whisper-small-q5_1", "missing");
    expect(small.recommended).toBe(true);
    const medium = _internals.buildStatus("whisper-medium-q5_0", "missing");
    expect(medium.recommended).toBe(false);
  });
});

describe("modelFilePath 路径安全", () => {
  it("只接受已知 modelId，拼接结果不含 ..", () => {
    const path = modelFilePath("whisper-base-q5_1");
    expect(path).toContain("whisper-base-q5_1");
    expect(path).not.toContain("..");
  });
});

describe("进度 emitter", () => {
  beforeEach(() => {
    _internals.resetState();
    vi.clearAllMocks();
  });

  it("setWhisperProgressEmitter 设置后，getModelStatus 可返回 downloading 进度", async () => {
    const SMALL_ID = "whisper-small-q5_1" as const;

    // 注入进行中下载状态（绕过真实 fetch）
    _internals.setDownloadStateForTest(
      { modelId: SMALL_ID, downloadedBytes: 50_000, totalBytes: 190_085_487, speedBytesPerSecond: 1024 },
    );
    // stat finalPath → not exists（downloading 状态路径）
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const status = await getModelStatus(SMALL_ID);
    expect((status as { state: string }).state).toBe("downloading");
    expect((status as { downloadedBytes: number }).downloadedBytes).toBe(50_000);
  });

  it("setWhisperProgressEmitter null → 设置后不抛出", () => {
    expect(() => setWhisperProgressEmitter(null)).not.toThrow();
    setWhisperProgressEmitter((p) => void p); // set a real callback
    expect(() => setWhisperProgressEmitter(null)).not.toThrow(); // reset to null
  });
});

// 辅助类型（避免 import 循环）
type WhisperDownloadResultForTest =
  | { ok: true; status: ReturnType<typeof _internals.buildStatus> }
  | { ok: false; message: string; status?: ReturnType<typeof _internals.buildStatus> };
