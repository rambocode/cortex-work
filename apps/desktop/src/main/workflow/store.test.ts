// U2 Test scenarios — workflow/store.ts
// 测试隔离方案：vi.mock("../paths") 将 workflowsStorePath / workflowRunsDir
// 重定向到 mkdtempSync 创建的临时目录；每个 test 通过 vi.resetModules() + vi.doMock
// 清除模块级缓存，保证不同 test 间状态不泄漏。

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDef, WorkflowRun } from "./types";

// ── 临时目录 ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let workflowsFile: string;
let runsDir: string;

// vi.hoisted 在模块求值之前运行，共享临时路径变量供 vi.mock factory 使用。
const pathMocks = vi.hoisted(() => {
  let _workflowsFile = "";
  let _runsDir = "";
  return {
    setWorkflowsFile: (p: string) => { _workflowsFile = p; },
    setRunsDir: (p: string) => { _runsDir = p; },
    workflowsStorePath: () => _workflowsFile,
    workflowRunsDir: () => _runsDir,
  };
});

// 顶层 vi.mock：hoisted，确保 import("./store") 时 ../paths 已被替换。
vi.mock("../paths", () => ({
  workflowsStorePath: pathMocks.workflowsStorePath,
  workflowRunsDir: pathMocks.workflowRunsDir,
}));

// freshStore：每次测试前 vi.resetModules() 清除模块级 cache（let cache = null），
// 再用 vi.doMock 注册非 hoisted mock，最后 import 得到干净的 store 实例。
async function freshStore() {
  vi.resetModules();
  // vi.doMock 不被 hoisted，必须在 resetModules 之后、import 之前调用。
  vi.doMock("../paths", () => ({
    workflowsStorePath: pathMocks.workflowsStorePath,
    workflowRunsDir: pathMocks.workflowRunsDir,
  }));
  // normalize 依赖 ./types，一并 doMock 以防 resetModules 破坏类型引用（无副作用）
  return await import("./store");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cortex-wf-store-"));
  workflowsFile = join(tmpDir, "workflows.json");
  runsDir = join(tmpDir, "workflow-runs");
  pathMocks.setWorkflowsFile(workflowsFile);
  pathMocks.setRunsDir(runsDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

// ── 辅助：构造最小合法 WorkflowDef ───────────────────────────────────────────

function makeWorkflow(id: string, name = "Test"): WorkflowDef {
  return {
    id,
    name,
    enabled: true,
    callableByAgent: false,
    env: [],
    nodes: [],
    connections: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRunAt: "",
    nextRunAt: "",
    lastStatus: "idle",
    lastMessage: "",
    runs: [],
  };
}

function makeRun(id: string): WorkflowRun {
  return {
    id,
    trigger: "manual",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    message: "",
    nodeResults: [],
  };
}

// ── loadWorkflows / upsertWorkflow 往返 ───────────────────────────────────────

describe("upsert → load 往返", () => {
  it("upsert 后 load 能取回同一记录", async () => {
    const store = await freshStore();
    const wf = makeWorkflow("wf-001");
    await store.upsertWorkflow(wf);

    const store2 = await freshStore();
    const list = await store2.loadWorkflows();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("wf-001");
    expect(list[0].name).toBe("Test");
  });

  it("重复 upsert 同 id 不重复追加", async () => {
    const store = await freshStore();
    await store.upsertWorkflow(makeWorkflow("wf-dup"));
    await store.upsertWorkflow({ ...makeWorkflow("wf-dup"), name: "Updated" });

    const store2 = await freshStore();
    const list = await store2.loadWorkflows();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Updated");
  });

  it("文件不存在时 loadWorkflows 返回空数组不抛", async () => {
    const store = await freshStore();
    const list = await store.loadWorkflows();
    expect(list).toEqual([]);
  });
});

// ── patchWorkflow 部分字段不丢其它字段 ───────────────────────────────────────

describe("patchWorkflow — 部分字段合并", () => {
  it("patch name 不丢 enabled / nodes / env", async () => {
    const store = await freshStore();
    await store.upsertWorkflow({ ...makeWorkflow("wf-patch"), enabled: false });

    const store2 = await freshStore();
    const patched = await store2.patchWorkflow("wf-patch", { name: "Patched" });

    expect(patched).not.toBeNull();
    expect(patched!.name).toBe("Patched");
    // enabled 等字段未被覆盖
    expect(patched!.enabled).toBe(false);
  });

  it("patch 不存在的 id 返回 null", async () => {
    const store = await freshStore();
    const result = await store.patchWorkflow("non-existent", { name: "x" });
    expect(result).toBeNull();
  });
});

// ── deleteWorkflow ────────────────────────────────────────────────────────────

describe("deleteWorkflow", () => {
  it("删除后 load 不再返回该记录", async () => {
    const store = await freshStore();
    await store.upsertWorkflow(makeWorkflow("wf-del"));
    await store.deleteWorkflow("wf-del");

    const store2 = await freshStore();
    const list = await store2.loadWorkflows();
    expect(list.find((w) => w.id === "wf-del")).toBeUndefined();
  });
});

// ── getWorkflow ───────────────────────────────────────────────────────────────

describe("getWorkflow", () => {
  it("按 id 取到对应工作流", async () => {
    const store = await freshStore();
    await store.upsertWorkflow(makeWorkflow("wf-get"));
    const found = await store.getWorkflow("wf-get");
    expect(found?.id).toBe("wf-get");
  });

  it("不存在时返回 undefined", async () => {
    const store = await freshStore();
    const found = await store.getWorkflow("missing");
    expect(found).toBeUndefined();
  });
});

// ── 运行记录：持久化运行列表（保留最近 N 条，最新在前）──────────────────────────

describe("appendRun — 持久化运行列表（最近 N 条）", () => {
  it("多次 append 同一 workflowId 保留全部，最新在前", async () => {
    const store = await freshStore();
    for (let i = 0; i < 8; i++) {
      await store.appendRun("wf-latest", makeRun(`run-${i}`));
    }
    const runs = await store.loadRuns("wf-latest");
    expect(runs).toHaveLength(8);
    expect(runs[0].id).toBe("run-7"); // 最新在前
    expect(runs[7].id).toBe("run-0");
  });

  it("新实例（模拟进程重启）后仍能读回——已持久化落盘", async () => {
    const store = await freshStore();
    await store.appendRun("wf-persist", makeRun("run-1"));
    await store.appendRun("wf-persist", makeRun("run-2"));
    expect(await store.loadRuns("wf-persist")).toHaveLength(2);
    // freshStore 重新 import → 模块级内存 Map 全新，但磁盘文件仍在 → 重读盘
    const store2 = await freshStore();
    const reloaded = await store2.loadRuns("wf-persist");
    expect(reloaded).toHaveLength(2);
    expect(reloaded[0].id).toBe("run-2");
  });

  it("超过保留上限时丢弃最旧（keepN=3）", async () => {
    const store = await freshStore();
    for (let i = 0; i < 5; i++) {
      await store.appendRun("wf-cap", makeRun(`run-${i}`), 3);
    }
    const runs = await store.loadRuns("wf-cap");
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.id)).toEqual(["run-4", "run-3", "run-2"]);
  });
});

describe("appendRun — 并发（串行链保证不丢失）", () => {
  it("并发 append 同一 workflowId 全部保留（读-改-写串行）", async () => {
    const store = await freshStore();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.appendRun("wf-concurrent", makeRun(`run-c${i}`))),
    );
    expect(await store.loadRuns("wf-concurrent")).toHaveLength(10);
  });

  it("不同 workflowId 互不干扰", async () => {
    const store = await freshStore();
    await Promise.all([
      store.appendRun("wf-a", makeRun("run-a1")),
      store.appendRun("wf-b", makeRun("run-b1")),
      store.appendRun("wf-a", makeRun("run-a2")),
    ]);
    const aRuns = await store.loadRuns("wf-a");
    expect(aRuns).toHaveLength(2);
    expect(aRuns[0].id).toBe("run-a2"); // 最新在前
    expect(await store.loadRuns("wf-b")).toHaveLength(1);
  });

  it("updateRun 收尾运行（running → error）", async () => {
    const store = await freshStore();
    await store.appendRun("wf-upd", { ...makeRun("run-u"), status: "running" });
    await store.updateRun("wf-upd", "run-u", { status: "error", message: "x" });
    const runs = await store.loadRuns("wf-upd");
    expect(runs[0].status).toBe("error");
    expect(runs[0].message).toBe("x");
  });
});

// ── SAFE_ID 防路径穿越 ────────────────────────────────────────────────────────

describe("SAFE_ID 防路径穿越", () => {
  it("非法 workflowId 传入 loadRuns 抛出错误", async () => {
    const store = await freshStore();
    await expect(store.loadRuns("../../../etc/passwd")).rejects.toThrow("非法 workflow id");
  });

  it("非法 workflowId 传入 appendRun 抛出错误", async () => {
    const store = await freshStore();
    await expect(store.appendRun("../../evil", makeRun("r1"))).rejects.toThrow("非法 workflow id");
  });

  it("非法 workflowId 传入 updateRun 抛出错误", async () => {
    const store = await freshStore();
    await expect(store.updateRun("../secret", "r1", {})).rejects.toThrow("非法 workflow id");
  });

  it("非法 workflowId 传入 deleteRun 抛出错误", async () => {
    const store = await freshStore();
    await expect(store.deleteRun("./etc", "r1")).rejects.toThrow("非法 workflow id");
  });

  it("合法 id 不抛出", async () => {
    const store = await freshStore();
    await expect(store.appendRun("wf-safe-01", makeRun("r1"))).resolves.not.toThrow();
  });
});

// ── 原子写：写后能 load 回（tmp+rename）──────────────────────────────────────

describe("原子写 — 写后可读回", () => {
  it("upsertWorkflow 后直接 loadWorkflows 能取到（验证 tmp→rename 完成）", async () => {
    const store = await freshStore();
    await store.upsertWorkflow(makeWorkflow("wf-atomic"));
    // 同一 store 实例（cache 命中）和新实例（重读盘）都能取到
    expect((await store.loadWorkflows()).find((w) => w.id === "wf-atomic")).toBeTruthy();

    const store2 = await freshStore();
    expect((await store2.loadWorkflows()).find((w) => w.id === "wf-atomic")).toBeTruthy();
  });

  it("appendRun 后同实例 loadRuns 能取到（持久化落盘）", async () => {
    const store = await freshStore();
    await store.appendRun("wf-atomic-run", makeRun("run-x"));
    const runs = await store.loadRuns("wf-atomic-run");
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("run-x");
  });
});

// ── updateRun / deleteRun ─────────────────────────────────────────────────────

describe("updateRun / deleteRun", () => {
  it("updateRun 更新最新一条的字段，其它字段不变（同实例内存态）", async () => {
    const store = await freshStore();
    await store.appendRun("wf-upd", makeRun("run-upd"));
    await store.updateRun("wf-upd", "run-upd", { status: "error", message: "失败" });

    const runs = await store.loadRuns("wf-upd");
    expect(runs[0].status).toBe("error");
    expect(runs[0].message).toBe("失败");
    // 其它字段（trigger 等）不应丢失
    expect(runs[0].trigger).toBe("manual");
  });

  it("updateRun id 不匹配时忽略", async () => {
    const store = await freshStore();
    await store.appendRun("wf-upd2", makeRun("run-real"));
    await store.updateRun("wf-upd2", "run-other", { status: "error" });
    const runs = await store.loadRuns("wf-upd2");
    expect(runs[0].status).toBe("success"); // 未被改写
  });

  it("deleteRun 删除最新一条后 loadRuns 为空", async () => {
    const store = await freshStore();
    await store.appendRun("wf-del-run", makeRun("run-x"));
    await store.deleteRun("wf-del-run", "run-x");
    expect(await store.loadRuns("wf-del-run")).toHaveLength(0);
  });

  it("deleteRun id 不匹配时不影响最新记录", async () => {
    const store = await freshStore();
    await store.appendRun("wf-del-run2", makeRun("run-keep"));
    await store.deleteRun("wf-del-run2", "run-other");
    const runs = await store.loadRuns("wf-del-run2");
    expect(runs[0].id).toBe("run-keep");
  });
});

// ── markOrphanRunsKilled ──────────────────────────────────────────────────────
// 运行记录已持久化：进程重启后把残留 "running" 收尾为 error，避免历史永久「运行中」。

describe("markOrphanRunsKilled — 收尾孤儿运行", () => {
  it("重启后把残留的 running 标记为 error，终态记录不动", async () => {
    const store = await freshStore();
    await store.appendRun("wf-orphan", {
      ...makeRun("run-run"),
      status: "running",
      finishedAt: "",
    });
    await store.appendRun("wf-orphan", makeRun("run-done")); // 已终态
    // 模拟进程重启：新实例 + 自愈
    const store2 = await freshStore();
    await store2.markOrphanRunsKilled();
    const runs = await store2.loadRuns("wf-orphan");
    expect(runs.find((r) => r.id === "run-run")?.status).toBe("error");
    expect(runs.find((r) => r.id === "run-done")?.status).toBe("success");
  });

  it("没有 running 时不抛错且不改动", async () => {
    const store = await freshStore();
    await store.appendRun("wf-noorphan", makeRun("run-ok"));
    await expect(store.markOrphanRunsKilled()).resolves.toBeUndefined();
    expect((await store.loadRuns("wf-noorphan"))[0].status).toBe("success");
  });
});

// ── ID 生成 ───────────────────────────────────────────────────────────────────

describe("newWorkflowId / newRunId", () => {
  it("newWorkflowId 以 wf- 开头", async () => {
    const store = await freshStore();
    expect(store.newWorkflowId()).toMatch(/^wf-/);
  });

  it("newRunId 以 run- 开头", async () => {
    const store = await freshStore();
    expect(store.newRunId()).toMatch(/^run-/);
  });

  it("连续调用生成唯一 id", async () => {
    const store = await freshStore();
    const ids = new Set(Array.from({ length: 20 }, () => store.newWorkflowId()));
    expect(ids.size).toBe(20);
  });
});
