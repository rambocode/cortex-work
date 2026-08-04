// 领域层单测：重点钉住「校验 → 持久化 → 调度 → 广播」的四联动。
// 漏掉 scheduleOne 是本层最危险的回归（任务建好了但永远不触发，且完全静默），故每个写路径都断言。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationInput, AutomationMeta } from "../ipc/types";

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  patch: vi.fn(),
  getAutomation: vi.fn(),
  deleteStore: vi.fn(),
  scheduleOne: vi.fn(),
  unschedule: vi.fn(),
  broadcastChanged: vi.fn(),
  runAutomation: vi.fn(),
}));

vi.mock("./events", () => ({ broadcastChanged: h.broadcastChanged }));
vi.mock("./runner", () => ({ runAutomation: h.runAutomation }));
vi.mock("./scheduler", () => ({ scheduleOne: h.scheduleOne, unschedule: h.unschedule }));
vi.mock("./store", () => ({
  upsertAutomation: h.upsert,
  patchAutomation: h.patch,
  getAutomation: h.getAutomation,
  deleteAutomationStore: h.deleteStore,
  loadAutomations: vi.fn(async () => []),
  newAutomationId: () => "auto-test",
}));

import {
  createAutomation,
  deleteAutomation,
  runAutomationNow,
  setAutomationEnabled,
  updateAutomation,
} from "./service";

const baseInput: AutomationInput = {
  name: "每周周报",
  prompt: "汇总本周工作",
  agent: "claude",
  schedule: { kind: "daily", hour: 9, minute: 0 },
};

const existing: AutomationMeta = {
  ...baseInput,
  id: "auto-1",
  enabled: true,
  timezone: "UTC",
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.upsert.mockImplementation(async (m: AutomationMeta) => m);
  h.patch.mockImplementation(async (_id: string, p: Partial<AutomationMeta>) => ({ ...existing, ...p }));
  h.getAutomation.mockResolvedValue(existing);
});

describe("createAutomation", () => {
  it("四联动齐备：持久化 + 建调度 + 广播", async () => {
    const meta = await createAutomation(baseInput);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.scheduleOne).toHaveBeenCalledWith(meta);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it("算出 nextRunAt 并补上本机时区", async () => {
    const meta = await createAutomation(baseInput);
    expect(meta.timezone).toBeTruthy();
    expect(typeof meta.nextRunAt).toBe("number");
  });

  it("enabled:false 时不算 nextRunAt（避免「已暂停却有下次」的歧义态）", async () => {
    const meta = await createAutomation({ ...baseInput, enabled: false });
    expect(meta.nextRunAt).toBeUndefined();
  });

  it("notifyChannels 显式透传（回归：逐字段构造勿漏）", async () => {
    const meta = await createAutomation({ ...baseInput, notifyChannels: ["feishu", "internal"] });
    expect(meta.notifyChannels).toEqual(["feishu", "internal"]);
  });

  it("createdBy 默认 undefined（视为 user），传 agent 时落盘", async () => {
    expect((await createAutomation(baseInput)).createdBy).toBeUndefined();
    expect((await createAutomation(baseInput, "agent")).createdBy).toBe("agent");
  });

  it("schedule 非法直接抛错，且不落盘不建调度", async () => {
    await expect(
      createAutomation({ ...baseInput, schedule: { kind: "daily", hour: 99, minute: 0 } }),
    ).rejects.toThrow(/小时/);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.scheduleOne).not.toHaveBeenCalled();
  });
});

describe("updateAutomation", () => {
  it("id 不存在返回 null，不产生任何副作用", async () => {
    h.getAutomation.mockResolvedValue(undefined);
    expect(await updateAutomation("nope", { name: "x" })).toBeNull();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.scheduleOne).not.toHaveBeenCalled();
  });

  it("改 schedule 后重算 nextRunAt 并重建调度", async () => {
    const merged = await updateAutomation("auto-1", { schedule: { kind: "hourly", minute: 30 } });
    expect(merged?.schedule).toEqual({ kind: "hourly", minute: 30 });
    expect(typeof merged?.nextRunAt).toBe("number");
    expect(h.scheduleOne).toHaveBeenCalledTimes(1);
  });

  it("非法 schedule 抛错且不落盘", async () => {
    await expect(
      updateAutomation("auto-1", { schedule: { kind: "hourly", minute: 60 } }),
    ).rejects.toThrow(/分钟/);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("patch 不能顶掉 id", async () => {
    const merged = await updateAutomation("auto-1", { name: "改名" } as Partial<AutomationInput>);
    expect(merged?.id).toBe("auto-1");
    expect(merged?.name).toBe("改名");
  });
});

describe("setAutomationEnabled", () => {
  it("停用时清空 nextRunAt", async () => {
    const updated = await setAutomationEnabled("auto-1", false);
    expect(updated?.enabled).toBe(false);
    expect(h.patch).toHaveBeenCalledWith("auto-1", { enabled: false, nextRunAt: undefined });
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it("启用时重算 nextRunAt 并重建调度", async () => {
    await setAutomationEnabled("auto-1", true);
    expect(typeof (h.patch.mock.calls[0][1] as AutomationMeta).nextRunAt).toBe("number");
    expect(h.scheduleOne).toHaveBeenCalledTimes(1);
  });

  it("id 不存在返回 null", async () => {
    h.getAutomation.mockResolvedValue(undefined);
    expect(await setAutomationEnabled("nope", true)).toBeNull();
  });
});

describe("deleteAutomation", () => {
  it("先摘调度再删存储（顺序反了会让已建的 job 在文件删掉后继续触发）", async () => {
    await deleteAutomation("auto-1");
    expect(h.unschedule).toHaveBeenCalledWith("auto-1");
    expect(h.deleteStore).toHaveBeenCalledWith("auto-1");
    expect(h.unschedule.mock.invocationCallOrder[0]).toBeLessThan(
      h.deleteStore.mock.invocationCallOrder[0],
    );
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });
});

describe("runAutomationNow", () => {
  it("id 不存在返回 null，不触发执行", async () => {
    h.getAutomation.mockResolvedValue(undefined);
    expect(await runAutomationNow("nope")).toBeNull();
    expect(h.runAutomation).not.toHaveBeenCalled();
  });

  it("以 manual 触发已存在的自动化", async () => {
    await runAutomationNow("auto-1");
    expect(h.runAutomation).toHaveBeenCalledWith(existing, "manual");
  });
});
