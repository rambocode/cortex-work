// cli.ts 子进程单测：三种 agent（claude/codex/pi）统一走 child_process.spawn(cmd, args);
// 以及 spawnEnvFor 的环境定制（pi 注入 CORTEX_PI_KEY、清 ELECTRON_RUN_AS_NODE）。
// electron / child_process 在测试环境整体 mock。

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", isPackaged: false },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { detectAgents, envForCommand, resetAgentDetectionForTest, startAgentProcess, spawnEnvFor } from "./cli";
import { PI_KEY_ENV } from "../agents/pi-providers";

// child_process.spawn 返回值的最小替身。
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
}

beforeEach(() => {
  resetAgentDetectionForTest();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startAgentProcess", () => {
  it("pi → child_process.spawn(二进制, args, stdio=[ignore,pipe,pipe])", () => {
    startAgentProcess("/res/pi/pi", ["--mode", "json", "-p", "hello"], {
      cwd: "/proj",
      env: { FOO: "1" } as NodeJS.ProcessEnv,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("/res/pi/pi");
    expect(args).toEqual(["--mode", "json", "-p", "hello"]);
    expect(opts).toMatchObject({ cwd: "/proj", stdio: ["ignore", "pipe", "pipe"] });
  });

  it("claude → child_process.spawn(cmd, args)（与 pi 同路径）", () => {
    startAgentProcess("claude", ["-p", "hi"], { cwd: "/proj", env: {} as NodeJS.ProcessEnv });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "hi"]);
    expect(opts).toMatchObject({ cwd: "/proj", stdio: ["ignore", "pipe", "pipe"] });
  });

  it("kill() 调用底层 child.kill（SIGTERM）", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const proc = startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    proc.kill();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("把命中的 CLI 目录提到 PATH 最前，确保 shebang 使用同目录 node", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-path-"));
    try {
      const oldBin = join(root, "old-bin");
      const codexBin = join(root, "node20-bin");
      mkdirSync(oldBin);
      mkdirSync(codexBin);
      writeFileSync(join(oldBin, "node"), "");
      writeFileSync(join(codexBin, "node"), "");
      writeFileSync(join(codexBin, "codex"), "");

      const env = envForCommand("codex", {
        PATH: [oldBin, codexBin].join(delimiter),
      } as NodeJS.ProcessEnv);

      expect(env.PATH?.split(delimiter).slice(0, 2)).toEqual([codexBin, oldBin]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("绝对路径 CLI 也会把自身目录提到 PATH 最前", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-abs-"));
    try {
      const oldBin = join(root, "old-bin");
      const codexBin = join(root, "node20-bin");
      mkdirSync(oldBin);
      mkdirSync(codexBin);
      const codex = join(codexBin, "codex");
      writeFileSync(join(oldBin, "node"), "");
      writeFileSync(join(codexBin, "node"), "");
      writeFileSync(codex, "");

      const env = envForCommand(codex, {
        PATH: oldBin,
      } as NodeJS.ProcessEnv);

      expect(env.PATH?.split(delimiter).slice(0, 2)).toEqual([codexBin, oldBin]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spawnEnvFor", () => {
  it("pi:不注入 ELECTRON_RUN_AS_NODE,注入 PI key", () => {
    const env = spawnEnvFor({ agent: "pi", provider: { apiKey: "sk-test" } });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env[PI_KEY_ENV]).toBe("sk-test");
  });

  it("pi 无供应商:无 PI key,也无 ELECTRON_RUN_AS_NODE", () => {
    const env = spawnEnvFor({ agent: "pi" });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env[PI_KEY_ENV]).toBeUndefined();
  });

  it("claude:基础 env,不含 PI key", () => {
    const env = spawnEnvFor({ agent: "claude" });
    expect(env[PI_KEY_ENV]).toBeUndefined();
  });
});

describe("detectAgents", () => {
  it("claude/codex 都能 --version 退出 0 时标记可用,pi 恒可用", async () => {
    const claude = fakeChild();
    const codex = fakeChild();
    spawnMock.mockImplementationOnce(() => claude).mockImplementationOnce(() => codex);

    const resultPromise = detectAgents();
    claude.emit("close", 0);
    codex.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({ claude: true, codex: true, pi: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("claude");
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["--version"]);
    expect(spawnMock.mock.calls[1]?.[0]).toBe("codex");
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(["--version"]);
  });

  it("非 0 退出或 spawn error 时标记不可用", async () => {
    const claude = fakeChild();
    const codex = fakeChild();
    spawnMock.mockImplementationOnce(() => claude).mockImplementationOnce(() => codex);

    const resultPromise = detectAgents();
    claude.stderr.emit("data", "bad credentials\n");
    claude.emit("close", 1);
    codex.emit("error", new Error("ENOENT"));

    await expect(resultPromise).resolves.toEqual({ claude: false, codex: false, pi: true });
  });

  it("同一进程生命周期内缓存验证结果,后续 detect 不重复 spawn", async () => {
    const claude = fakeChild();
    const codex = fakeChild();
    spawnMock.mockImplementationOnce(() => claude).mockImplementationOnce(() => codex);

    const first = detectAgents();
    claude.emit("close", 0);
    codex.emit("close", 0);
    await expect(first).resolves.toEqual({ claude: true, codex: true, pi: true });

    await expect(detectAgents()).resolves.toEqual({ claude: true, codex: true, pi: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
