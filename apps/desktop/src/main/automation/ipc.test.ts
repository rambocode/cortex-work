import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationInput, AutomationMeta } from "../ipc/types";

// 捕获注册的 IPC handler;mock 副作用依赖,放行纯函数(schedule-cron 校验/算下次)。
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  upsert: vi.fn(),
  getAutomation: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(ch, fn) },
}));
vi.mock("./events", () => ({ broadcastChanged: vi.fn() }));
vi.mock("./runner", () => ({ runAutomation: vi.fn() }));
vi.mock("./scheduler", () => ({ scheduleOne: vi.fn(), unschedule: vi.fn() }));
vi.mock("./store", () => ({
  upsertAutomation: h.upsert,
  loadAutomations: vi.fn(async () => []),
  newAutomationId: () => "auto-test",
  getAutomation: h.getAutomation,
  patchAutomation: vi.fn(),
  deleteAutomationStore: vi.fn(),
  deleteRun: vi.fn(),
  loadRuns: vi.fn(),
}));

import { registerAutomationHandlers } from "./ipc";

const baseInput: AutomationInput = {
  name: "每周周报",
  prompt: "汇总本周工作",
  agent: "claude",
  schedule: { kind: "daily", hour: 9, minute: 0 },
};

beforeEach(() => {
  h.handlers.clear();
  h.upsert.mockReset().mockImplementation(async (m: AutomationMeta) => m);
  h.getAutomation.mockReset();
  registerAutomationHandlers();
});

describe("automation:create notifyChannels 透传(回归:逐字段构造勿漏)", () => {
  it("create 把 input.notifyChannels 落入持久化 meta", async () => {
    const create = h.handlers.get("automation:create")!;
    await create({}, { ...baseInput, notifyChannels: ["feishu", "internal"] });
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect((h.upsert.mock.calls[0][0] as AutomationMeta).notifyChannels).toEqual(["feishu", "internal"]);
  });

  it("create 未传 notifyChannels 时为 undefined(默认不通知)", async () => {
    const create = h.handlers.get("automation:create")!;
    await create({}, { ...baseInput });
    expect((h.upsert.mock.calls[0][0] as AutomationMeta).notifyChannels).toBeUndefined();
  });
});

describe("automation:update notifyChannels 透传", () => {
  it("update patch notifyChannels 经 ...patch 落盘", async () => {
    h.getAutomation.mockResolvedValue({
      ...baseInput,
      id: "auto-1",
      enabled: true,
      notifyChannels: [],
      timezone: "UTC",
      createdAt: 0,
      updatedAt: 0,
    } as AutomationMeta);
    const update = h.handlers.get("automation:update")!;
    await update({}, "auto-1", { notifyChannels: ["dingtalk"] });
    expect((h.upsert.mock.calls[0][0] as AutomationMeta).notifyChannels).toEqual(["dingtalk"]);
  });
});
