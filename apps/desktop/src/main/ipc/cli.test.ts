// cli.ts 子进程单测：三种 agent（claude/codex/pi）统一走 child_process.spawn(cmd, args);
// 以及 spawnEnvFor 的环境定制（pi 注入 CORTEX_PI_KEY、清 ELECTRON_RUN_AS_NODE）。
// electron / child_process 在测试环境整体 mock。

import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", isPackaged: false },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { startAgentProcess, spawnEnvFor } from "./cli";
import { PI_KEY_ENV } from "../agents/pi-providers";

// child_process.spawn 返回值的最小替身。
function fakeChild() {
  return {
    pid: 123,
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    on: vi.fn(),
    kill: vi.fn(),
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
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
