// cli.ts 子进程分流单测：pi 走 Electron utilityProcess.fork、claude/codex 走
// child_process.spawn；以及 utilityProcess 的 exit + stdout-end 收尾协调（防丢末行）。
// electron / child_process 在测试环境不可用或有副作用,整体 mock。

import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";

const forkMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", isPackaged: false },
  ipcMain: { handle: vi.fn() },
  utilityProcess: { fork: (...args: unknown[]) => forkMock(...args) },
}));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { startAgentProcess, spawnEnvFor } from "./cli";
import { PI_KEY_ENV } from "../agents/pi-providers";

// utilityProcess.fork 返回值的最小替身：事件 + stdout/stderr 流 + kill。
function fakeUtility() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 456;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

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
  forkMock.mockReset();
  spawnMock.mockReset();
  forkMock.mockImplementation(() => fakeUtility());
  spawnMock.mockImplementation(() => fakeChild());
});

describe("startAgentProcess 分流", () => {
  it("pi → utilityProcess.fork(cli.js, 余下参数, stdio=pipe, serviceName=pi-agent),不走 spawn", () => {
    startAgentProcess("pi", process.execPath, ["/x/dist/cli.js", "--mode", "json", "-p", "hello"], {
      cwd: "/proj",
      env: { FOO: "1" } as NodeJS.ProcessEnv,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(forkMock).toHaveBeenCalledTimes(1);
    const [modulePath, childArgs, opts] = forkMock.mock.calls[0];
    expect(modulePath).toBe("/x/dist/cli.js"); // args[0] 作 modulePath
    expect(childArgs).toEqual(["--mode", "json", "-p", "hello"]); // 余下作 CLI 参数
    expect(opts).toMatchObject({ cwd: "/proj", stdio: "pipe", serviceName: "pi-agent" });
  });

  it("claude → child_process.spawn(cmd, args, stdio=[ignore,pipe,pipe]),不走 fork", () => {
    startAgentProcess("claude", "claude", ["-p", "hi"], { cwd: "/proj", env: {} as NodeJS.ProcessEnv });
    expect(forkMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "hi"]);
    expect(opts).toMatchObject({ cwd: "/proj", stdio: ["ignore", "pipe", "pipe"] });
  });

  it("codex → child_process.spawn（与 claude 同路径）", () => {
    startAgentProcess("codex", "codex", ["x"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    expect(forkMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("wrapUtility 收尾协调（防丢末行）", () => {
  it("onExit 仅在 exit 与 stdout end 都到达后触发一次,携带 exit code", () => {
    const child = fakeUtility();
    forkMock.mockReturnValueOnce(child);
    const proc = startAgentProcess("pi", process.execPath, ["/x/cli.js", "hi"], {
      cwd: "/p",
      env: {} as NodeJS.ProcessEnv,
    });
    const codes: (number | null)[] = [];
    proc.onExit((c) => codes.push(c));

    child.emit("exit", 0);
    expect(codes).toEqual([]); // stdout 尚未结束,暂不收尾（否则会丢末行）

    child.stdout.emit("end");
    expect(codes).toEqual([0]); // 两信号齐,收尾一次

    // 重复信号不应再次触发
    child.stdout.emit("close");
    child.emit("exit", 0);
    expect(codes).toEqual([0]);
  });

  it("收尾信号先于回调注册到达时,onExit 补发一次", () => {
    const child = fakeUtility();
    forkMock.mockReturnValueOnce(child);
    const proc = startAgentProcess("pi", process.execPath, ["/x/cli.js", "hi"], {
      cwd: "/p",
      env: {} as NodeJS.ProcessEnv,
    });
    child.emit("exit", 3);
    child.stdout.emit("end");
    const codes: (number | null)[] = [];
    proc.onExit((c) => codes.push(c)); // 信号已到,注册即补发
    expect(codes).toEqual([3]);
  });

  it("kill() 调用底层 child.kill（SIGTERM）", () => {
    const child = fakeUtility();
    forkMock.mockReturnValueOnce(child);
    const proc = startAgentProcess("pi", process.execPath, ["/x/cli.js", "hi"], {
      cwd: "/p",
      env: {} as NodeJS.ProcessEnv,
    });
    proc.kill();
    expect(child.kill).toHaveBeenCalled();
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
