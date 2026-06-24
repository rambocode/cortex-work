// locate.test.ts — resolveWhisperRunner() 路径解析单测
// mock: electron app、fs.existsSync

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── mock electron ──────────────────────────────────────────────────────────────
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/fake/apps/desktop",
  },
}));

// ── mock node:fs ───────────────────────────────────────────────────────────────
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import { resolveWhisperRunner } from "./locate";

const mockExists = existsSync as ReturnType<typeof vi.fn>;

// dev 态 path（本地构建产出）
const DEV_PATH = "/fake/apps/desktop/resources/whisper/darwin-arm64/whisper-cli";

// process.resourcesPath 在 node 环境不一定存在，需要 mock
const origResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CORTEX_WHISPER_CLI;
  // 设置 process.resourcesPath
  Object.defineProperty(process, "resourcesPath", {
    value: "/fake/resourcesPath",
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  if (origResourcesPath !== undefined) {
    Object.defineProperty(process, "resourcesPath", {
      value: origResourcesPath,
      writable: true,
      configurable: true,
    });
  }
});

describe("resolveWhisperRunner", () => {
  it("优先使用环境变量 CORTEX_WHISPER_CLI", () => {
    const envPath = "/custom/whisper-cli";
    process.env.CORTEX_WHISPER_CLI = envPath;
    mockExists.mockImplementation((p: string) => p === envPath);

    const result = resolveWhisperRunner();

    expect(result.command).toBe(envPath);
    expect(result.cwd).toBe("/custom");
    expect(result.env).toEqual({});
  });

  it("dev 态：找到 appPath/resources/whisper/darwin-arm64/whisper-cli", async () => {
    // app.isPackaged = false（mock 已设置）
    mockExists.mockImplementation((p: string) => p === DEV_PATH);

    const result = resolveWhisperRunner();

    expect(result.command).toBe(DEV_PATH);
    expect(result.cwd).toBe("/fake/apps/desktop/resources/whisper/darwin-arm64");
    expect(result.env).toEqual({});
  });

  it("env 变量存在但文件不存在时，继续找 dev 路径", () => {
    process.env.CORTEX_WHISPER_CLI = "/nonexistent/whisper-cli";
    mockExists.mockImplementation((p: string) => p === DEV_PATH);

    const result = resolveWhisperRunner();

    expect(result.command).toBe(DEV_PATH);
  });

  it("所有路径均不存在时抛出含路径列表的错误", () => {
    mockExists.mockReturnValue(false);

    expect(() => resolveWhisperRunner()).toThrowError(/找不到 whisper-cli/);
    expect(() => resolveWhisperRunner()).toThrowError(/whisper-cli/);
  });

  it("抛出错误时包含候选路径信息（便于诊断）", () => {
    mockExists.mockReturnValue(false);

    let caught: Error | undefined;
    try {
      resolveWhisperRunner();
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    // 错误信息中应包含 prepare-whisper-runner 提示
    expect(caught!.message).toContain("prepare-whisper-runner");
  });

  it("darwin 不需要 LD_LIBRARY_PATH（env 为空对象）", () => {
    mockExists.mockImplementation((p: string) => p === DEV_PATH);

    const result = resolveWhisperRunner();

    // darwin 静态构建不需要额外 env
    expect(result.env).toEqual({});
  });
});
