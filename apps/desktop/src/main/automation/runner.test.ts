import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationMeta } from "../ipc/types";

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  startAgentProcess: vi.fn(),
  spawnEnvFor: vi.fn(),
  getAgentDef: vi.fn(),
  appendRun: vi.fn(),
  updateRun: vi.fn(),
  patchAutomation: vi.fn(),
  loadAutomations: vi.fn(),
  broadcastChanged: vi.fn(),
  broadcastRunEvent: vi.fn(),
  getWorkspaceRoot: vi.fn(),
  // scoped logger 桩:断言 start/finalize/timeout 生命周期埋点。
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));

vi.mock("../ipc/cli", () => ({
  detectAgents: mocks.detectAgents,
  startAgentProcess: mocks.startAgentProcess,
  spawnEnvFor: mocks.spawnEnvFor,
  spawnEnvForDef: vi.fn(() => ({}) as NodeJS.ProcessEnv),
  assertSpawnCwd: vi.fn(),
}));

vi.mock("../log", () => ({ createLogger: () => mocks.log, isDevEnv: () => true }));

vi.mock("../agents", () => ({
  parseLineEvents: vi.fn(() => []),
  getAgentDef: mocks.getAgentDef,
}));

vi.mock("../agents/pi-providers", () => ({
  writePiExtension: vi.fn(() => "/tmp/pi-extension.json"),
}));

vi.mock("../ipc/store", () => ({
  getPersistedState: vi.fn(async () => ({ providerSettings: { providers: [] } })),
  getWorkspaceRoot: mocks.getWorkspaceRoot,
}));

vi.mock("./events", () => ({
  broadcastChanged: mocks.broadcastChanged,
  broadcastRunEvent: mocks.broadcastRunEvent,
}));

vi.mock("./schedule-cron", () => ({
  computeNextRun: vi.fn(() => 123),
}));

vi.mock("./store", () => ({
  appendRun: mocks.appendRun,
  loadAutomations: mocks.loadAutomations,
  newRunId: vi.fn(() => "run-1"),
  patchAutomation: mocks.patchAutomation,
  updateRun: mocks.updateRun,
}));

import { runAutomation } from "./runner";

const meta: AutomationMeta = {
  id: "auto-1",
  name: "Daily",
  enabled: true,
  agent: "claude",
  prompt: "hello",
  schedule: { kind: "daily", hour: 9, minute: 30 },
  timezone: "Asia/Shanghai",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.detectAgents.mockResolvedValue({ claude: false, codex: true, pi: true });
  mocks.loadAutomations.mockResolvedValue([]);
  mocks.patchAutomation.mockResolvedValue({ ...meta, lastStatus: "error" });
  mocks.updateRun.mockResolvedValue(undefined);
  mocks.appendRun.mockResolvedValue(undefined);
  mocks.getWorkspaceRoot.mockResolvedValue("/workspace");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAutomation agent availability", () => {
  it("外部 agent 启动验证不可用时直接记录 error,不 spawn", async () => {
    const run = await runAutomation(meta, "manual");

    expect(run.status).toBe("error");
    expect(run.error).toContain("Claude Code 未安装或不可用");
    expect(mocks.startAgentProcess).not.toHaveBeenCalled();
    expect(mocks.getAgentDef).not.toHaveBeenCalled();
    expect(mocks.appendRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1", status: "error" }));
    expect(mocks.updateRun).toHaveBeenCalledWith("auto-1", "run-1", expect.objectContaining({ status: "error" }));
    expect(mocks.patchAutomation).toHaveBeenCalledWith("auto-1", expect.objectContaining({ lastStatus: "error" }));
    // 生命周期埋点:start(debug)与 finalize(info)成对落,unavailable 走 error 分支。
    expect(mocks.log.debug).toHaveBeenCalledWith(expect.stringContaining("start id=auto-1"));
    expect(mocks.log.info).toHaveBeenCalledWith(expect.stringContaining("status=error"));
    expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining("unavailable for auto-1"));
  });
});

describe("runAutomation 超时埋点", () => {
  it("看门狗超时 → log.warn 记 timeout,finalize 状态为 timeout", async () => {
    vi.useFakeTimers();
    try {
      // 该用例需 agent 可用 → 进入 spawn 路径。
      mocks.detectAgents.mockResolvedValue({ claude: true, codex: true, pi: true });
      mocks.getAgentDef.mockReturnValue({
        buildArgs: () => ({ cmd: "claude", args: ["-p"], stdin: undefined }),
      });
      // 捕获 onExit 回调:超时 timer 触发后由它模拟「被 kill 后子进程退出」。
      let exitCb: ((code: number | null) => void) | undefined;
      const proc = {
        pid: 1,
        stdout: { setEncoding: vi.fn(), on: vi.fn() },
        stderr: { setEncoding: vi.fn(), on: vi.fn() },
        onError: vi.fn(),
        onExit: vi.fn((cb: (code: number | null) => void) => { exitCb = cb; }),
        kill: vi.fn(),
      };
      mocks.startAgentProcess.mockReturnValue(proc);

      await runAutomation(meta, "manual");
      // 推进到 10min 看门狗:置 timedOut 并 kill。
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(proc.kill).toHaveBeenCalled();
      // 模拟子进程随后退出 → 走 settle 的 timeout 分支(同步 compute + 异步 finalize)。
      exitCb?.(null);
      // 冲刷 finalize 的微任务链(updateRun/patchAutomation/loadAutomations 均 mock 立即 resolve)。
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(mocks.log.warn).toHaveBeenCalledWith(expect.stringContaining("timeout for auto-1"));
      expect(mocks.updateRun).toHaveBeenCalledWith("auto-1", "run-1", expect.objectContaining({ status: "timeout" }));
      expect(mocks.log.info).toHaveBeenCalledWith(expect.stringContaining("status=timeout"));
    } finally {
      vi.useRealTimers();
    }
  });
});
