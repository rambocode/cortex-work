import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationMeta } from "../ipc/types";

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  startAgentProcess: vi.fn(),
  spawnEnvFor: vi.fn(),
  getAdapter: vi.fn(),
  appendRun: vi.fn(),
  updateRun: vi.fn(),
  patchAutomation: vi.fn(),
  loadAutomations: vi.fn(),
  broadcastChanged: vi.fn(),
  broadcastRunEvent: vi.fn(),
  getWorkspaceRoot: vi.fn(),
}));

vi.mock("../ipc/cli", () => ({
  detectAgents: mocks.detectAgents,
  startAgentProcess: mocks.startAgentProcess,
  spawnEnvFor: mocks.spawnEnvFor,
}));

vi.mock("../agents", () => ({
  getAdapter: mocks.getAdapter,
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
    expect(mocks.getAdapter).not.toHaveBeenCalled();
    expect(mocks.appendRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1", status: "error" }));
    expect(mocks.updateRun).toHaveBeenCalledWith("auto-1", "run-1", expect.objectContaining({ status: "error" }));
    expect(mocks.patchAutomation).toHaveBeenCalledWith("auto-1", expect.objectContaining({ lastStatus: "error" }));
  });
});
