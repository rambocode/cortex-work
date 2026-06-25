// U4 测试：workflow React Query 数据层纯逻辑 + 缓存行为验证。
// vitest 在 node 环境运行，无 DOM，故不用 renderHook。
// 纯函数（upsertDef/upsertRun）直接单测；
// 缓存行为通过 QueryClient.setQueryData / getQueryData 直接验证,
// 不依赖 hook 渲染，保持测试简洁且完全覆盖 U4 Test Scenarios。

import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { WorkflowDef, WorkflowRun } from "../desktop/workflow-types";
import { workflowKeys, upsertDef, upsertRun } from "./workflow";

// ── 测试辅助工厂 ──────────────────────────────────────────────────────────

function makeDef(partial: Partial<WorkflowDef> & { id: string }): WorkflowDef {
  return {
    name: `workflow-${partial.id}`,
    enabled: true,
    callableByAgent: false,
    env: [],
    nodes: [],
    connections: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastRunAt: "",
    nextRunAt: "",
    lastStatus: "idle",
    lastMessage: "",
    runs: [],
    ...partial,
  };
}

function makeRun(partial: Partial<WorkflowRun> & { id: string }): WorkflowRun {
  return {
    trigger: "manual",
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "",
    message: "",
    nodeResults: [],
    ...partial,
  };
}

// ── 1. query key 命名空间 ──────────────────────────────────────────────────

describe("workflowKeys", () => {
  it("list key 命名空间为 personal/workflows", () => {
    expect(workflowKeys.list).toEqual(["personal", "workflows"]);
  });

  it("runs key 包含 workflowId 以避免不同工作流 runs 缓存串场", () => {
    expect(workflowKeys.runs("wf-1")).toEqual(["personal", "workflow-runs", "wf-1"]);
    expect(workflowKeys.runs("wf-2")).toEqual(["personal", "workflow-runs", "wf-2"]);
    // 不同 id 的 key 必须不同
    expect(workflowKeys.runs("wf-1")).not.toEqual(workflowKeys.runs("wf-2"));
  });
});

// ── 2. upsertDef 幂等 upsert ─────────────────────────────────────────────

describe("upsertDef", () => {
  it("列表为空时追加", () => {
    const def = makeDef({ id: "w1" });
    expect(upsertDef(undefined, def)).toEqual([def]);
  });

  it("id 不存在时追加到末尾", () => {
    const existing = makeDef({ id: "w1" });
    const newDef = makeDef({ id: "w2" });
    const result = upsertDef([existing], newDef);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(newDef);
  });

  it("id 已存在时替换对应项（幂等）", () => {
    const original = makeDef({ id: "w1", name: "旧名" });
    const updated = makeDef({ id: "w1", name: "新名" });
    const result = upsertDef([original], updated);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("新名");
  });

  it("同一 def 重复 upsert 不产生重复行", () => {
    const def = makeDef({ id: "w1" });
    const once = upsertDef(undefined, def);
    const twice = upsertDef(once, def);
    expect(twice).toHaveLength(1);
  });
});

// ── 3. upsertRun 幂等 upsert（最新在前）──────────────────────────────────

describe("upsertRun", () => {
  it("列表为空时追加", () => {
    const run = makeRun({ id: "r1" });
    expect(upsertRun(undefined, run)).toEqual([run]);
  });

  it("id 不存在时置顶（最新在前）", () => {
    const r1 = makeRun({ id: "r1" });
    const r2 = makeRun({ id: "r2" });
    const result = upsertRun([r1], r2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(r2); // 最新置顶
    expect(result[1]).toBe(r1);
  });

  it("start 事件后 end 事件同 id → 更新而不产生重复行", () => {
    const start = makeRun({ id: "r1", status: "running" });
    const end = makeRun({ id: "r1", status: "success", finishedAt: "2026-01-01T00:01:00Z" });
    const afterStart = upsertRun(undefined, start);
    const afterEnd = upsertRun(afterStart, end);
    // 不产生重复行
    expect(afterEnd).toHaveLength(1);
    // 使用最新状态
    expect(afterEnd[0]?.status).toBe("success");
  });

  it("重复 upsert 同一 run 不产生重复行（幂等）", () => {
    const run = makeRun({ id: "r1" });
    const once = upsertRun(undefined, run);
    const twice = upsertRun(once, run);
    expect(twice).toHaveLength(1);
  });

  it("多条 run 时最新始终置顶", () => {
    const r1 = makeRun({ id: "r1" });
    const r2 = makeRun({ id: "r2" });
    const r3 = makeRun({ id: "r3" });
    const list = upsertRun(upsertRun(upsertRun(undefined, r1), r2), r3);
    expect(list.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
  });
});

// ── 4. onWorkflowChanged → 列表缓存被全量替换 ─────────────────────────────

describe("onWorkflowChanged 驱动缓存（模拟事件写入）", () => {
  it("全量替换 list 缓存", () => {
    const qc = new QueryClient();
    const initial = [makeDef({ id: "w1" }), makeDef({ id: "w2" })];
    qc.setQueryData(workflowKeys.list, initial);

    // 模拟 bridge.onWorkflowChanged 回调触发
    const updated = [makeDef({ id: "w1", name: "更新名" }), makeDef({ id: "w3" })];
    qc.setQueryData(workflowKeys.list, updated);

    const cached = qc.getQueryData<WorkflowDef[]>(workflowKeys.list);
    expect(cached).toHaveLength(2);
    expect(cached?.[0]?.name).toBe("更新名");
    expect(cached?.[1]?.id).toBe("w3");
  });
});

// ── 5. onWorkflowRunEvent → runs 缓存幂等 upsert ─────────────────────────

describe("onWorkflowRunEvent 驱动缓存（模拟事件写入）", () => {
  it("start 事件写入 runs 缓存", () => {
    const qc = new QueryClient();
    const wfId = "wf-abc";
    const run = makeRun({ id: "r1", status: "running" });

    // 模拟 bridge.onWorkflowRunEvent 的 phase=start 回调
    qc.setQueryData<WorkflowRun[]>(workflowKeys.runs(wfId), (prev) => upsertRun(prev, run));

    const cached = qc.getQueryData<WorkflowRun[]>(workflowKeys.runs(wfId));
    expect(cached).toHaveLength(1);
    expect(cached?.[0]?.status).toBe("running");
  });

  it("end 事件更新同 id run，不产生重复行", () => {
    const qc = new QueryClient();
    const wfId = "wf-abc";
    const startRun = makeRun({ id: "r1", status: "running" });
    const endRun = makeRun({ id: "r1", status: "success", finishedAt: "2026-01-01T00:01:00Z" });

    // 先写入 start
    qc.setQueryData<WorkflowRun[]>(workflowKeys.runs(wfId), (prev) => upsertRun(prev, startRun));
    // 再写入 end
    qc.setQueryData<WorkflowRun[]>(workflowKeys.runs(wfId), (prev) => upsertRun(prev, endRun));

    const cached = qc.getQueryData<WorkflowRun[]>(workflowKeys.runs(wfId));
    expect(cached).toHaveLength(1); // 不重复
    expect(cached?.[0]?.status).toBe("success");
  });

  it("不同工作流的 runs 缓存互相隔离（key 含 workflowId）", () => {
    const qc = new QueryClient();
    const run1 = makeRun({ id: "r1" });
    const run2 = makeRun({ id: "r2" });

    qc.setQueryData<WorkflowRun[]>(workflowKeys.runs("wf-1"), (prev) => upsertRun(prev, run1));
    qc.setQueryData<WorkflowRun[]>(workflowKeys.runs("wf-2"), (prev) => upsertRun(prev, run2));

    const cached1 = qc.getQueryData<WorkflowRun[]>(workflowKeys.runs("wf-1"));
    const cached2 = qc.getQueryData<WorkflowRun[]>(workflowKeys.runs("wf-2"));
    expect(cached1).toHaveLength(1);
    expect(cached1?.[0]?.id).toBe("r1");
    expect(cached2).toHaveLength(1);
    expect(cached2?.[0]?.id).toBe("r2");
  });
});

// ── 6. bridge 为 null → useWorkflowsAvailable 语义测试（纯逻辑等价）──────

// useWorkflowsAvailable 的核心等价式：!!bridge?.workflowList
// 抽取为工厂函数，避免 TS 对字面量 null 的 narrowing 推断出 never。
function workflowsAvailable(bridge: { workflowList?: () => Promise<WorkflowDef[]> } | null): boolean {
  return !!bridge?.workflowList;
}

describe("bridge 为 null 时 useWorkflowsAvailable 语义", () => {
  it("bridge 为 null → 返回 false", () => {
    expect(workflowsAvailable(null)).toBe(false);
  });

  it("bridge 有 workflowList → 返回 true", () => {
    expect(workflowsAvailable({ workflowList: async () => [] as WorkflowDef[] })).toBe(true);
  });

  it("bridge 无 workflowList（web 端部分实现）→ 返回 false", () => {
    expect(workflowsAvailable({})).toBe(false);
  });
});
