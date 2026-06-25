// DSL 导入/导出纯函数测试（U15）。
// 覆盖：脱敏导出、wrapped/裸两种格式导入、空 nodes 报错、导入强制 enabled=false。

import { describe, it, expect } from "vitest";
import { exportWorkflowDsl, parseWorkflowDsl, hasCodeNodes } from "./dsl";
import type { WorkflowDef } from "./types";

// ── 测试固件 ──────────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z";

/** 最小合法工作流（有一个 manual-trigger 节点）。 */
function makeWorkflow(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    id: "wf-test-1",
    name: "测试工作流",
    enabled: true,
    callableByAgent: true,
    env: [
      { key: "API_URL", value: "https://example.com", type: "string" },
      { key: "API_KEY", value: "super-secret-value", type: "secret" },
    ],
    nodes: [
      {
        id: "node-1",
        type: "manual-trigger",
        name: "手动触发",
        position: { x: 100, y: 100 },
        disabled: false,
        config: {},
      },
    ],
    connections: [],
    createdAt: NOW,
    updatedAt: NOW,
    lastRunAt: "2026-01-01T00:05:00.000Z",
    nextRunAt: "",
    lastStatus: "success",
    lastMessage: "运行成功",
    runs: [
      {
        id: "run-1",
        trigger: "manual",
        status: "success",
        startedAt: NOW,
        finishedAt: NOW,
        message: "ok",
        nodeResults: [],
      },
    ],
    ...overrides,
  };
}

// ── 导出测试 ──────────────────────────────────────────────────────────────────

describe("exportWorkflowDsl", () => {
  it("返回正确的 DSL 包装结构", () => {
    const wf = makeWorkflow();
    const dsl = exportWorkflowDsl(wf, NOW);
    expect(dsl.dsv).toBe(1);
    expect(dsl.kind).toBe("workflow");
    expect(dsl.app).toBe("Cortex Desktop");
    expect(dsl.exportedAt).toBe(NOW);
  });

  it("secret env value 置空，key 与 type 保留", () => {
    const wf = makeWorkflow();
    const dsl = exportWorkflowDsl(wf, NOW);
    const apiKey = dsl.workflow.env.find((e) => e.key === "API_KEY");
    expect(apiKey).toBeDefined();
    expect(apiKey!.type).toBe("secret");
    expect(apiKey!.value).toBe(""); // 脱敏后置空
  });

  it("普通 string env 原样保留", () => {
    const wf = makeWorkflow();
    const dsl = exportWorkflowDsl(wf, NOW);
    const apiUrl = dsl.workflow.env.find((e) => e.key === "API_URL");
    expect(apiUrl!.value).toBe("https://example.com");
  });

  it("enabled 强制为 false", () => {
    const wf = makeWorkflow({ enabled: true });
    const dsl = exportWorkflowDsl(wf, NOW);
    expect(dsl.workflow.enabled).toBe(false);
  });

  it("callableByAgent 强制为 false", () => {
    const wf = makeWorkflow({ callableByAgent: true });
    const dsl = exportWorkflowDsl(wf, NOW);
    expect(dsl.workflow.callableByAgent).toBe(false);
  });

  it("runs 清空", () => {
    const wf = makeWorkflow();
    const dsl = exportWorkflowDsl(wf, NOW);
    expect(dsl.workflow.runs).toEqual([]);
  });

  it("lastRunAt / nextRunAt / lastStatus / lastMessage 清空", () => {
    const wf = makeWorkflow();
    const dsl = exportWorkflowDsl(wf, NOW);
    expect(dsl.workflow.lastRunAt).toBe("");
    expect(dsl.workflow.nextRunAt).toBe("");
    expect(dsl.workflow.lastStatus).toBe("idle");
    expect(dsl.workflow.lastMessage).toBe("");
  });

  it("不修改原始 workflow 对象（无副作用）", () => {
    const wf = makeWorkflow();
    exportWorkflowDsl(wf, NOW);
    expect(wf.enabled).toBe(true); // 原始对象不受影响
    expect(wf.env[1]!.value).toBe("super-secret-value");
  });
});

// ── 导入测试 ──────────────────────────────────────────────────────────────────

describe("parseWorkflowDsl", () => {
  it("解析 wrapped DSL 格式（标准格式）", () => {
    const wf = makeWorkflow();
    const dsl = exportWorkflowDsl(wf, NOW);
    const result = parseWorkflowDsl(dsl, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.nodes).toHaveLength(1);
    }
  });

  it("解析裸工作流格式（有 nodes 数组）", () => {
    const wf = makeWorkflow();
    const result = parseWorkflowDsl(wf, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.nodes).toHaveLength(1);
    }
  });

  it("null 输入返回 unsupported", () => {
    expect(parseWorkflowDsl(null, NOW)).toEqual({ ok: false, error: "unsupported" });
  });

  it("字符串输入返回 unsupported", () => {
    expect(parseWorkflowDsl("not an object", NOW)).toEqual({ ok: false, error: "unsupported" });
  });

  it("数组输入返回 unsupported", () => {
    expect(parseWorkflowDsl([], NOW)).toEqual({ ok: false, error: "unsupported" });
  });

  it("无 nodes 的对象返回 unsupported（不是 wrapped 也不是裸格式）", () => {
    expect(parseWorkflowDsl({ foo: "bar" }, NOW)).toEqual({ ok: false, error: "unsupported" });
  });

  it("空 nodes 数组返回 empty", () => {
    const wf = makeWorkflow({ nodes: [] });
    // 裸格式，nodes 为空 → normalize 后仍为空 → error: empty
    const result = parseWorkflowDsl(wf, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("empty");
    }
  });

  it("wrapped 格式但内嵌 workflow.nodes 为空 → empty", () => {
    const wf = makeWorkflow({ nodes: [] });
    const dsl = exportWorkflowDsl(wf, NOW);
    const result = parseWorkflowDsl(dsl, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("empty");
    }
  });

  it("导入后 enabled 强制为 false", () => {
    // 即使 DSL 里 enabled=true（非标准 DSL），导入后也强制 false
    const wf = makeWorkflow({ enabled: true });
    const result = parseWorkflowDsl(wf, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.enabled).toBe(false);
    }
  });

  it("导入后 callableByAgent 强制为 false", () => {
    const wf = makeWorkflow({ callableByAgent: true });
    const result = parseWorkflowDsl(wf, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.callableByAgent).toBe(false);
    }
  });

  it("导入后 runs 强制清空", () => {
    const wf = makeWorkflow();
    // 先用裸格式导入（wf 含 runs）
    const result = parseWorkflowDsl(wf, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.runs).toEqual([]);
    }
  });

  it("不分配新 id（id 分配由 IPC 层完成）", () => {
    const wf = makeWorkflow({ id: "wf-original-id" });
    const result = parseWorkflowDsl(wf, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // parseWorkflowDsl 不改 id，由 IPC 层调用 newWorkflowId() 替换
      expect(result.workflow.id).toBe("wf-original-id");
    }
  });
});

// ── hasCodeNodes 测试 ─────────────────────────────────────────────────────────

describe("hasCodeNodes", () => {
  it("无代码节点返回 false", () => {
    const wf = makeWorkflow();
    expect(hasCodeNodes(wf)).toBe(false);
  });

  it("含 code 节点返回 true", () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: "n1",
          type: "code",
          name: "代码",
          position: { x: 0, y: 0 },
          disabled: false,
          config: { language: "javascript", code: "return {}" },
        },
      ],
    });
    expect(hasCodeNodes(wf)).toBe(true);
  });

  it("含 custom 节点返回 true", () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: "n1",
          type: "custom",
          name: "自定义",
          position: { x: 0, y: 0 },
          disabled: false,
          config: { moduleId: "mod-1", values: {} },
        },
      ],
    });
    expect(hasCodeNodes(wf)).toBe(true);
  });
});
