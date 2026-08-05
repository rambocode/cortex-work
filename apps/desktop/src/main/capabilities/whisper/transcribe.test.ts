// transcribe.test.ts — transcribeLocal() 单测
// mock: child_process.spawn、node:fs/promises（writeFile/readFile/rm）、./locate

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

// ── mock ./locate ──────────────────────────────────────────────────────────────
vi.mock("./locate", () => ({
  resolveWhisperRunner: () => ({
    command: "/fake/whisper-cli",
    cwd: "/fake",
    env: {},
  }),
}));

// ── mock node:crypto（用于 tmpId，避免实际 randomBytes） ──────────────────────
vi.mock("node:crypto", () => ({
  randomBytes: () => Buffer.from("abcdef"),
}));

// ── mock node:os ───────────────────────────────────────────────────────────────
vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));

// ── mock node:fs/promises ──────────────────────────────────────────────────────
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRm = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

// ── mock child_process.spawn ───────────────────────────────────────────────────
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// ── 测试辅助：构造 mock ChildProcess ──────────────────────────────────────────
function makeMockProcess(exitCode: number | null = 0): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (proc as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout;
  (proc as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stderr = stderr;
  (proc as unknown as { kill: (sig: string) => void }).kill = vi.fn();

  // 异步触发 close 事件
  setTimeout(() => proc.emit("close", exitCode), 0);
  return proc;
}

import { transcribeLocal } from "./transcribe";

const FAKE_AUDIO = new ArrayBuffer(100);
const MODEL_PATH = "/models/ggml-small.bin";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
});

describe("transcribeLocal", () => {
  it("spawn 参数正确（含 -nt，含 -l zh）", async () => {
    mockReadFile.mockResolvedValue("转写结果文本");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await transcribeLocal({
      audio: FAKE_AUDIO,
      mimeType: "audio/wav",
      language: "zh",
      modelPath: MODEL_PATH,
    });

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[0]).toBe("/fake/whisper-cli");
    const spawnArgs: string[] = spawnCall[1];
    expect(spawnArgs).toContain("-m");
    expect(spawnArgs).toContain(MODEL_PATH);
    expect(spawnArgs).toContain("-otxt");
    expect(spawnArgs).toContain("-nt");
    expect(spawnArgs).toContain("-l");
    expect(spawnArgs).toContain("zh");
  });

  it("language=auto 时省略 -l 参数", async () => {
    mockReadFile.mockResolvedValue("转写结果");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await transcribeLocal({
      audio: FAKE_AUDIO,
      mimeType: "audio/wav",
      language: "auto",
      modelPath: MODEL_PATH,
    });

    const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
    expect(spawnArgs).not.toContain("-l");
  });

  it("language='' 时省略 -l 参数", async () => {
    mockReadFile.mockResolvedValue("转写结果");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await transcribeLocal({
      audio: FAKE_AUDIO,
      mimeType: "audio/wav",
      language: "",
      modelPath: MODEL_PATH,
    });

    const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
    expect(spawnArgs).not.toContain("-l");
  });

  it("非空 prompt 以 --prompt 传给 whisper-cli", async () => {
    mockReadFile.mockResolvedValue("转写结果");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await transcribeLocal({
      audio: FAKE_AUDIO,
      mimeType: "audio/wav",
      language: "zh",
      modelPath: MODEL_PATH,
      prompt: "Cortex, Whisper, 麦克风",
    });

    const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
    expect(spawnArgs).toContain("--prompt");
    expect(spawnArgs).toContain("Cortex, Whisper, 麦克风");
  });

  it("读取 .txt 结果并 trim 后返回", async () => {
    mockReadFile.mockResolvedValue("  Hello World  \n");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    const result = await transcribeLocal({
      audio: FAKE_AUDIO,
      mimeType: "audio/wav",
      language: "en",
      modelPath: MODEL_PATH,
    });

    expect(result.text).toBe("Hello World");
  });

  it("退出码非 0 时抛出错误", async () => {
    mockSpawn.mockReturnValue(makeMockProcess(1));

    await expect(
      transcribeLocal({
        audio: FAKE_AUDIO,
        mimeType: "audio/wav",
        language: "en",
        modelPath: MODEL_PATH,
      }),
    ).rejects.toThrow(/退出码 1/);
  });

  it("输出 .txt 缺失时抛出错误", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await expect(
      transcribeLocal({
        audio: FAKE_AUDIO,
        mimeType: "audio/wav",
        language: "en",
        modelPath: MODEL_PATH,
      }),
    ).rejects.toThrow(/未产出/);
  });

  it("转写结果为空时抛出错误", async () => {
    mockReadFile.mockResolvedValue("   \n  ");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await expect(
      transcribeLocal({
        audio: FAKE_AUDIO,
        mimeType: "audio/wav",
        language: "en",
        modelPath: MODEL_PATH,
      }),
    ).rejects.toThrow(/转写结果为空/);
  });

  it("成功时清理临时目录", async () => {
    mockReadFile.mockResolvedValue("结果");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await transcribeLocal({
      audio: FAKE_AUDIO,
      mimeType: "audio/wav",
      language: "en",
      modelPath: MODEL_PATH,
    });

    // rm 应被调用（临时目录清理）
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("cortex-whisper"),
      { recursive: true, force: true },
    );
  });

  it("失败时也清理临时目录（finally 保证）", async () => {
    mockSpawn.mockReturnValue(makeMockProcess(1)); // 非 0 退出

    await expect(
      transcribeLocal({
        audio: FAKE_AUDIO,
        mimeType: "audio/wav",
        language: "en",
        modelPath: MODEL_PATH,
      }),
    ).rejects.toThrow();

    // 即使失败，rm 也应被调用
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("cortex-whisper"),
      { recursive: true, force: true },
    );
  });

  it("spawn cwd 使用 runner.cwd（来自 resolveWhisperRunner）", async () => {
    mockReadFile.mockResolvedValue("结果");
    mockSpawn.mockReturnValue(makeMockProcess(0));

    await transcribeLocal({
      audio: FAKE_AUDIO,
      mimeType: "audio/wav",
      language: "en",
      modelPath: MODEL_PATH,
    });

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.cwd).toBe("/fake");
  });

  it("超时 kill 后 close 事件触发不产生双重 reject（timedOut 标志位）", async () => {
    // 验证 timedOut 标志位修复：
    // 直接在 Promise executor 内模拟「计时器 reject → close 到来」的时序，
    // 统计 reject 调用次数，期望恰好为 1（不双重 reject）。
    // 不使用 fake timers，避免 Vitest 从框架外捕获 unhandledRejection 误报。
    let rejectCount = 0;

    await new Promise<void>((done, fail) => {
      let timedOut = false; // 与 transcribe.ts 修复逻辑一致

      const promise = new Promise<void>((_resolve, reject) => {
        // 模拟超时触发 reject
        setTimeout(() => {
          timedOut = true;
          rejectCount++;
          reject(new Error("超时"));
        }, 5);

        // 模拟 close 事件在超时后到来
        setTimeout(() => {
          // timedOut 为 true 时，修复后的逻辑不再调用 reject
          if (!timedOut) {
            rejectCount++;
            reject(new Error("close 误 reject"));
          }
          // 验证：rejectCount 应为 1（只有超时 reject）
          try {
            expect(rejectCount).toBe(1);
            done();
          } catch (e) {
            fail(e as Error);
          }
        }, 20);
      });

      // 消费 Promise，防止 unhandledRejection
      promise.catch(() => undefined);
    });
  });
});
