// cli.ts 子进程单测：三种 agent（claude/codex/pi）统一走 child_process.spawn(cmd, args);
// 以及 spawnEnvFor 的环境定制（pi 注入 CORTEX_PI_KEY、清 ELECTRON_RUN_AS_NODE）。
// electron / child_process 在测试环境整体 mock。

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();
const traceMock = vi.hoisted(() => vi.fn());
const streamDeltaMock = vi.hoisted(() => vi.fn());
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("./agent-trace", () => ({
  recordAgentTrace: (...args: unknown[]) => traceMock(...args),
  recordStreamDelta: (...args: unknown[]) => streamDeltaMock(...args),
}));

import {
  detectAgents,
  envForCommand,
  mergePathWithPreferredDirs,
  nvmBinDirs,
  resetAgentDetectionForTest,
  registerCliHandlers,
  startAgentProcess,
  spawnEnvFor,
} from "./cli";
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
  ipcHandlers.clear();
  traceMock.mockReset();
  streamDeltaMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("cli:start trace", () => {
  it("记录启动、解析事件、stderr 和退出 trace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-cli-trace-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    registerCliHandlers();
    const send = vi.fn();

    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        {
          runId: "run-1",
          sessionId: "session-1",
          agent: "pi",
          cwd,
          prompt: "hello",
        },
      );

      child.stdout.emit("data", JSON.stringify({ type: "session", id: "pi-session" }) + "\n");
      child.stdout.emit(
        "data",
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        }) + "\n",
      );
      child.stderr.emit("data", "warn line\n");
      child.emit("close", 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "start", runId: "run-1", sessionId: "session-1", agent: "pi" }),
    );
    // session → init 仍走普通 trace(phase:event);text 增量改走合并段(recordStreamDelta)。
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "event", runId: "run-1", sessionId: "session-1", agent: "pi" }),
    );
    expect(streamDeltaMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", segmentType: "text", delta: "hi", runId: "run-1", agent: "pi" }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "stderr", data: expect.objectContaining({ chunk: "warn line\n" }) }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "exit", data: expect.objectContaining({ code: 0 }) }),
    );
  });
});

describe("cli:oneshot trace", () => {
  it("记录 oneshot start/event/stderr/exit trace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-oneshot-trace-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    registerCliHandlers();

    try {
      const promise = ipcHandlers.get("cli:oneshot")?.(
        {},
        {
          agent: "pi",
          cwd,
          prompt: "生成标题",
        },
      ) as Promise<string>;
      await Promise.resolve();

      child.stdout.emit(
        "data",
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "标题" },
        }) + "\n",
      );
      child.stderr.emit("data", "warn\n");
      child.emit("close", 0);

      await expect(promise).resolves.toBe("标题");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", phase: "start", sessionId: "oneshot", agent: "pi" }),
    );
    // text 增量改走合并段(recordStreamDelta),不再每增量一条普通 trace。
    expect(streamDeltaMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", segmentType: "text", delta: "标题", sessionId: "oneshot", agent: "pi" }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", phase: "stderr", data: expect.objectContaining({ chunk: "warn\n" }) }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", phase: "exit", data: expect.objectContaining({ code: 0 }) }),
    );
  });
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

  it("spawn 带 detached(非 win)+ shell:false,用于进程组取消", () => {
    startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts).toMatchObject({ shell: false, detached: process.platform !== "win32" });
  });

  it("有 stdin 负载:stdio[0]=pipe,写入 prompt 并 end()(U4)", () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(child);
    startAgentProcess("claude", ["-p"], { cwd: "/p", env: {} as NodeJS.ProcessEnv, stdin: "PAYLOAD" });
    const [, , opts] = spawnMock.mock.calls[0] as [unknown, unknown, { stdio: unknown[] }];
    expect(opts.stdio[0]).toBe("pipe");
    expect(child.stdin.end).toHaveBeenCalledWith("PAYLOAD", "utf8");
  });

  it("无 stdin 负载:stdio[0]=ignore(pi,prompt 在 argv)", () => {
    startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    const [, , opts] = spawnMock.mock.calls[0] as [unknown, unknown, { stdio: unknown[] }];
    expect(opts.stdio[0]).toBe("ignore");
  });

  it("kill() 非 win 走进程组信号 process.kill(-pgid, SIGTERM);win 直接 child.kill", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    // mock process.kill 避免向真实进程/进程组发信号(fakeChild.pid=123)。
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const proc = startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    proc.kill();
    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      expect(killSpy).toHaveBeenCalledWith(-123, "SIGTERM"); // -pgid 杀整组
      expect(child.kill).not.toHaveBeenCalled();
    }
    child.emit("close", 0); // 清理 3s 兜底 SIGKILL timer
    killSpy.mockRestore();
  });

  it("kill() 进程组信号抛错(未成组/已退出)时回退到 child.kill", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const proc = startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    proc.kill();
    // 非 win:process.kill(-pgid) 抛错 → 回退 child.kill;win:本就直接 child.kill。
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 0);
    killSpy.mockRestore();
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

  it("PATH 上命中的 CLI 用绝对路径 spawn,避免 GUI 环境再次搜索失败", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-resolve-"));
    try {
      const codexBin = join(root, "node-bin");
      mkdirSync(codexBin);
      const codex = join(codexBin, "codex");
      writeFileSync(codex, "");

      startAgentProcess("codex", ["--version"], {
        cwd: "/proj",
        env: { PATH: codexBin } as NodeJS.ProcessEnv,
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(realpathSync(codex));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nvm 安装的 Node 脚本 CLI 用同目录 node 执行,避开 shebang ENOENT", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-node-script-"));
    try {
      const bin = join(root, "bin");
      const lib = join(root, "lib");
      mkdirSync(bin);
      mkdirSync(lib);
      const node = join(bin, "node");
      const script = join(lib, "codex.js");
      writeFileSync(node, "");
      writeFileSync(script, "#!/usr/bin/env node\nconsole.log('codex')\n");
      symlinkSync("../lib/codex.js", join(bin, "codex"));

      startAgentProcess("codex", ["--version"], {
        cwd: "/proj",
        env: { PATH: bin } as NodeJS.ProcessEnv,
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(node);
      expect(spawnMock.mock.calls[0]?.[1]).toEqual([realpathSync(script), "--version"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("symlink 到原生二进制的 CLI 用 realpath spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-realpath-"));
    try {
      const bin = join(root, "bin");
      const versions = join(root, "versions");
      mkdirSync(bin);
      mkdirSync(versions);
      const realClaude = join(versions, "claude-2.1");
      writeFileSync(realClaude, "");
      symlinkSync("../versions/claude-2.1", join(bin, "claude"));

      startAgentProcess("claude", ["--version"], {
        cwd: "/proj",
        env: { PATH: bin } as NodeJS.ProcessEnv,
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(realpathSync(realClaude));
      expect(spawnMock.mock.calls[0]?.[1]).toEqual(["--version"]);
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

describe("buildEnv helpers", () => {
  it("nvm bin 目录按版本从新到旧排序,避免旧 CLI wrapper 抢先", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-nvm-sort-"));
    try {
      mkdirSync(join(root, ".nvm", "versions", "node", "v20.19.4", "bin"), { recursive: true });
      mkdirSync(join(root, ".nvm", "versions", "node", "v20.19.5", "bin"), { recursive: true });
      mkdirSync(join(root, ".nvm", "versions", "node", "v24.15.0", "bin"), { recursive: true });

      expect(nvmBinDirs(root).map((dir) => dir.replace(`${root}/.nvm/versions/node/`, ""))).toEqual([
        "v24.15.0/bin",
        "v20.19.5/bin",
        "v20.19.4/bin",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PATH 合并时优先使用补齐的用户安装目录", () => {
    const merged = mergePathWithPreferredDirs("/stale-node/bin:/usr/bin", [
      "/Users/me/.local/bin",
      "/fresh-node/bin",
      "/usr/bin",
    ]);

    expect(merged.split(delimiter)).toEqual(["/Users/me/.local/bin", "/fresh-node/bin", "/usr/bin", "/stale-node/bin"]);
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
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["--version"]);
    expect(String(spawnMock.mock.calls[1]?.[0])).toMatch(/(^|[/\\])(codex|node)(\.cmd|\.exe|\.bat)?$/);
    expect(spawnMock.mock.calls[1]?.[1]).toContain("--version");
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
