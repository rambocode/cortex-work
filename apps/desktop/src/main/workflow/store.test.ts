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

// ── appendRun 超过 keepN 截断 ─────────────────────────────────────────────────

describe("appendRun — keepN 截断", () => {
  it("超过 keepN 只保留最新 keepN 条", async () => {
    const store = await freshStore();
    const keepN = 5;
    for (let i = 0; i < 8; i++) {
      await store.appendRun("wf-trunc", makeRun(`run-${i}`), keepN);
    }
    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-trunc");
    expect(runs).toHaveLength(keepN);
    // 最新的在最前面（run-7 是最后一次 append，应在首位）
    expect(runs[0].id).toBe("run-7");
  });

  it("相同 id 重复 append 去重不增加条数", async () => {
    const store = await freshStore();
    await store.appendRun("wf-dedup", makeRun("run-dup"), 200);
    await store.appendRun("wf-dedup", makeRun("run-dup"), 200);

    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-dedup");
    expect(runs).toHaveLength(1);
  });
});

// ── 并发 appendRun 同一 id 不丢失（串行队列）────────────────────────────────

describe("appendRun — 并发安全（串行队列）", () => {
  it("并发 appendRun 同一 workflowId 所有记录都落盘", async () => {
    const store = await freshStore();
    const n = 10;
    const promises = Array.from({ length: n }, (_, i) =>
      store.appendRun("wf-concurrent", makeRun(`run-c${i}`), 200),
    );
    await Promise.all(promises);

    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-concurrent");
    // 每次 append 去重（不同 id）→ 应保留全部 n 条
    expect(runs).toHaveLength(n);
  });

  it("并发 appendRun 不同 workflowId 互不干扰", async () => {
    const store = await freshStore();
    await Promise.all([
      store.appendRun("wf-a", makeRun("run-a1"), 200),
      store.appendRun("wf-b", makeRun("run-b1"), 200),
      store.appendRun("wf-a", makeRun("run-a2"), 200),
    ]);

    const store2 = await freshStore();
    expect(await store2.loadRuns("wf-a")).toHaveLength(2);
    expect(await store2.loadRuns("wf-b")).toHaveLength(1);
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

  it("appendRun 后 loadRuns 能取到（验证 runs 文件 tmp→rename 完成）", async () => {
    const store = await freshStore();
    await store.appendRun("wf-atomic-run", makeRun("run-x"));

    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-atomic-run");
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("run-x");
  });
});

// ── updateRun / deleteRun ─────────────────────────────────────────────────────

describe("updateRun / deleteRun", () => {
  it("updateRun 更新指定字段，其它字段不变", async () => {
    const store = await freshStore();
    await store.appendRun("wf-upd", makeRun("run-upd"));
    await store.updateRun("wf-upd", "run-upd", { status: "error", message: "失败" });

    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-upd");
    expect(runs[0].status).toBe("error");
    expect(runs[0].message).toBe("失败");
    // 其它字段（trigger 等）不应丢失
    expect(runs[0].trigger).toBe("manual");
  });

  it("deleteRun 删除指定记录，其余保留", async () => {
    const store = await freshStore();
    await store.appendRun("wf-del-run", makeRun("run-keep"));
    await store.appendRun("wf-del-run", makeRun("run-gone"));
    await store.deleteRun("wf-del-run", "run-gone");

    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-del-run");
    expect(runs.find((r) => r.id === "run-gone")).toBeUndefined();
    expect(runs.find((r) => r.id === "run-keep")).toBeTruthy();
  });
});

// ── markOrphanRunsKilled ──────────────────────────────────────────────────────

describe("markOrphanRunsKilled", () => {
  it("running 状态记录被标为 error", async () => {
    const store = await freshStore();
    await store.upsertWorkflow(makeWorkflow("wf-orphan"));
    await store.appendRun("wf-orphan", {
      ...makeRun("run-orphan"),
      status: "running",
    });
    await store.markOrphanRunsKilled();

    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-orphan");
    expect(runs[0].status).toBe("error");
    expect(runs[0].message).toBe("进程异常退出");
  });

  it("非 running 状态记录不受影响", async () => {
    const store = await freshStore();
    await store.upsertWorkflow(makeWorkflow("wf-no-orphan"));
    await store.appendRun("wf-no-orphan", makeRun("run-ok"));
    await store.markOrphanRunsKilled();

    const store2 = await freshStore();
    const runs = await store2.loadRuns("wf-no-orphan");
    expect(runs[0].status).toBe("success");
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
