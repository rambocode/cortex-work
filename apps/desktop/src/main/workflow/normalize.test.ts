// 规范化器单测 (Vitest)。
// 覆盖 U1 的 Test scenarios:
//   · 每种 kind 缺省 → 默认值
//   · 越界数值钳制
//   · 超上限截断
//   · 未知 kind / 损坏节点安全丢弃

import { describe, expect, it } from "vitest";
import {
  normalizeWorkflow,
  normalizeWorkflowNode,
  normalizeWorkflowInputSchema,
  MAX_WORKFLOW_RUNS,
} from "./normalize";

// ── 辅助 ─────────────────────────────────────────────────────────────────────

const NOW = "2026-06-25T00:00:00.000Z";

/** 最小合法节点骨架（仅 type 和 config）。 */
function node(type: string, config: Record<string, unknown> = {}) {
  return { type, config };
}

// ── 未知 kind / 损坏节点 ──────────────────────────────────────────────────────

describe("normalizeWorkflowNode — 未知/损坏节点安全丢弃", () => {
  it("未知 kind 返回 null", () => {
    expect(normalizeWorkflowNode({ type: "non-existent", config: {} }, 0)).toBeNull();
  });

  it("非对象输入返回 null", () => {
    expect(normalizeWorkflowNode(null, 0)).toBeNull();
    expect(normalizeWorkflowNode("string", 0)).toBeNull();
    expect(normalizeWorkflowNode(42, 0)).toBeNull();
  });

  it("type 缺失返回 null", () => {
    expect(normalizeWorkflowNode({}, 0)).toBeNull();
  });

  it("type 合法但 config 损坏时不抛出，使用默认值", () => {
    // manual-trigger 不需要强制 config 字段
    const result = normalizeWorkflowNode({ type: "manual-trigger", config: null }, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("manual-trigger");
  });
});

// ── 节点 id 生成 ───────────────────────────────────────────────────────────────

describe("normalizeWorkflowNode — 基础字段", () => {
  it("id 缺失时用 fallback", () => {
    const r = normalizeWorkflowNode(node("delay"), 3);
    expect(r?.id).toBe("node-4");
  });

  it("保留已有 id", () => {
    const r = normalizeWorkflowNode({ ...node("delay"), id: "my-id" }, 0);
    expect(r?.id).toBe("my-id");
  });

  it("position 缺失 → {x:0, y:0}", () => {
    const r = normalizeWorkflowNode(node("delay"), 0);
    expect(r?.position).toEqual({ x: 0, y: 0 });
  });
});

// ── manual-trigger ────────────────────────────────────────────────────────────

describe("manual-trigger", () => {
  it("空 config → workspaceRoot=''，无 inputSchema，自动生成 runToken", () => {
    const r = normalizeWorkflowNode(node("manual-trigger"), 0);
    expect(r?.type).toBe("manual-trigger");
    if (r?.type !== "manual-trigger") return;
    expect(r.config.workspaceRoot).toBe("");
    expect(r.config.inputSchema).toBeUndefined();
    // 本地 API 触发令牌自动生成（非空字符串）
    expect(typeof r.config.runToken).toBe("string");
    expect(r.config.runToken).toBeTruthy();
  });

  it("已有 runToken 原样保留", () => {
    const r = normalizeWorkflowNode(
      node("manual-trigger", { runToken: "fixed-token-xyz" }),
      0,
    );
    if (r?.type !== "manual-trigger") throw new Error("wrong type");
    expect(r.config.runToken).toBe("fixed-token-xyz");
  });

  it("有效 inputSchema 被保留", () => {
    const r = normalizeWorkflowNode(
      node("manual-trigger", {
        inputSchema: [
          { key: "q", label: "Question", type: "text", required: true },
        ],
      }),
      0,
    );
    if (r?.type !== "manual-trigger") throw new Error("wrong type");
    expect(r.config.inputSchema?.length).toBe(1);
    expect(r.config.inputSchema?.[0].key).toBe("q");
  });

  it("inputSchema key 为空的条目被过滤", () => {
    const r = normalizeWorkflowNode(
      node("manual-trigger", {
        inputSchema: [{ key: "", label: "X", type: "text" }],
      }),
      0,
    );
    if (r?.type !== "manual-trigger") throw new Error("wrong type");
    expect(r.config.inputSchema).toBeUndefined();
  });
});

// ── schedule-trigger ──────────────────────────────────────────────────────────

describe("schedule-trigger", () => {
  it("daily schedule 保留 hour/minute", () => {
    const r = normalizeWorkflowNode(
      node("schedule-trigger", { schedule: { kind: "daily", hour: 8, minute: 30 } }),
      0,
    );
    if (r?.type !== "schedule-trigger") throw new Error("wrong type");
    expect(r.config.schedule.kind).toBe("daily");
    // @ts-expect-error — 运行时 kind=daily 有 hour 字段
    expect(r.config.schedule.hour).toBe(8);
  });

  it("未知 schedule kind 降级为 cron（兼容 Kun interval/at，U15 再处理）", () => {
    const r = normalizeWorkflowNode(
      node("schedule-trigger", { schedule: { kind: "interval", everyMinutes: 5 } }),
      0,
    );
    if (r?.type !== "schedule-trigger") throw new Error("wrong type");
    expect(r.config.schedule.kind).toBe("cron");
  });

  it("cron 表达式透传", () => {
    const r = normalizeWorkflowNode(
      node("schedule-trigger", {
        schedule: { kind: "cron", expression: "0 9 * * *" },
      }),
      0,
    );
    if (r?.type !== "schedule-trigger") throw new Error("wrong type");
    if (r.config.schedule.kind !== "cron") throw new Error("not cron");
    expect(r.config.schedule.expression).toBe("0 9 * * *");
  });
});

// ── webhook-trigger ───────────────────────────────────────────────────────────

describe("webhook-trigger", () => {
  it("path 缺失 → /webhook", () => {
    const r = normalizeWorkflowNode(node("webhook-trigger"), 0);
    if (r?.type !== "webhook-trigger") throw new Error("wrong type");
    expect(r.config.path).toBe("/webhook");
  });

  it("path 无前导斜杠自动补全", () => {
    const r = normalizeWorkflowNode(
      node("webhook-trigger", { path: "my-hook" }),
      0,
    );
    if (r?.type !== "webhook-trigger") throw new Error("wrong type");
    expect(r.config.path).toBe("/my-hook");
  });

  it("method 缺失 → ANY", () => {
    const r = normalizeWorkflowNode(node("webhook-trigger"), 0);
    if (r?.type !== "webhook-trigger") throw new Error("wrong type");
    expect(r.config.method).toBe("ANY");
  });

  it("非法 method 降级为 ANY", () => {
    const r = normalizeWorkflowNode(
      node("webhook-trigger", { method: "INVALID" }),
      0,
    );
    if (r?.type !== "webhook-trigger") throw new Error("wrong type");
    expect(r.config.method).toBe("ANY");
  });
});

// ── condition ─────────────────────────────────────────────────────────────────

describe("condition", () => {
  it("caseSensitive 默认 false", () => {
    const r = normalizeWorkflowNode(node("condition"), 0);
    if (r?.type !== "condition") throw new Error("wrong type");
    expect(r.config.caseSensitive).toBe(false);
  });

  it("非法 operator 降级为 contains", () => {
    const r = normalizeWorkflowNode(
      node("condition", { operator: "banana" }),
      0,
    );
    if (r?.type !== "condition") throw new Error("wrong type");
    expect(r.config.operator).toBe("contains");
  });
});

// ── switch ────────────────────────────────────────────────────────────────────

describe("switch", () => {
  it("fallback 默认 true", () => {
    const r = normalizeWorkflowNode(node("switch"), 0);
    if (r?.type !== "switch") throw new Error("wrong type");
    expect(r.config.fallback).toBe(true);
  });

  it("rules 超过 20 条截断", () => {
    const rules = Array.from({ length: 25 }, (_, i) => ({
      leftExpr: `x${i}`,
      operator: "equals",
      rightValue: "v",
      caseSensitive: false,
    }));
    const r = normalizeWorkflowNode(node("switch", { rules }), 0);
    if (r?.type !== "switch") throw new Error("wrong type");
    expect(r.config.rules.length).toBe(20);
  });
});

// ── limit ─────────────────────────────────────────────────────────────────────

describe("limit", () => {
  it("count 缺失 → 默认 10", () => {
    const r = normalizeWorkflowNode(node("limit"), 0);
    if (r?.type !== "limit") throw new Error("wrong type");
    expect(r.config.count).toBe(10);
  });

  it("count 0（越下界）→ 钳制为 10（fallback）", () => {
    const r = normalizeWorkflowNode(node("limit", { count: 0 }), 0);
    if (r?.type !== "limit") throw new Error("wrong type");
    expect(r.config.count).toBe(10);
  });

  it("count 100001（越上界）→ 钳制为 10（fallback）", () => {
    const r = normalizeWorkflowNode(node("limit", { count: 100_001 }), 0);
    if (r?.type !== "limit") throw new Error("wrong type");
    expect(r.config.count).toBe(10);
  });

  it("count 合法 50 保留", () => {
    const r = normalizeWorkflowNode(node("limit", { count: 50 }), 0);
    if (r?.type !== "limit") throw new Error("wrong type");
    expect(r.config.count).toBe(50);
  });

  it("from 缺失 → first", () => {
    const r = normalizeWorkflowNode(node("limit"), 0);
    if (r?.type !== "limit") throw new Error("wrong type");
    expect(r.config.from).toBe("first");
  });
});

// ── loop ──────────────────────────────────────────────────────────────────────

describe("loop", () => {
  it("maxIterations 缺失 → 10", () => {
    const r = normalizeWorkflowNode(node("loop"), 0);
    if (r?.type !== "loop") throw new Error("wrong type");
    expect(r.config.maxIterations).toBe(10);
  });

  it("maxIterations 0 → 10（fallback）", () => {
    const r = normalizeWorkflowNode(node("loop", { maxIterations: 0 }), 0);
    if (r?.type !== "loop") throw new Error("wrong type");
    expect(r.config.maxIterations).toBe(10);
  });

  it("maxIterations 101（越上界）→ 10（fallback）", () => {
    const r = normalizeWorkflowNode(node("loop", { maxIterations: 101 }), 0);
    if (r?.type !== "loop") throw new Error("wrong type");
    expect(r.config.maxIterations).toBe(10);
  });

  it("concurrency 超上界 9 → 4（fallback）", () => {
    const r = normalizeWorkflowNode(node("loop", { concurrency: 9 }), 0);
    if (r?.type !== "loop") throw new Error("wrong type");
    expect(r.config.concurrency).toBe(4);
  });

  it("mode 默认 condition", () => {
    const r = normalizeWorkflowNode(node("loop"), 0);
    if (r?.type !== "loop") throw new Error("wrong type");
    expect(r.config.mode).toBe("condition");
  });
});

// ── http-request ──────────────────────────────────────────────────────────────

describe("http-request", () => {
  it("timeoutMs 缺失 → 30000", () => {
    const r = normalizeWorkflowNode(node("http-request"), 0);
    if (r?.type !== "http-request") throw new Error("wrong type");
    expect(r.config.timeoutMs).toBe(30_000);
  });

  it("timeoutMs 999（低于下界 1000）→ 30000（fallback）", () => {
    const r = normalizeWorkflowNode(node("http-request", { timeoutMs: 999 }), 0);
    if (r?.type !== "http-request") throw new Error("wrong type");
    expect(r.config.timeoutMs).toBe(30_000);
  });

  it("timeoutMs 600001（超上界）→ 30000（fallback）", () => {
    const r = normalizeWorkflowNode(
      node("http-request", { timeoutMs: 600_001 }),
      0,
    );
    if (r?.type !== "http-request") throw new Error("wrong type");
    expect(r.config.timeoutMs).toBe(30_000);
  });

  it("headers 超过 50 条截断", () => {
    const headers = Array.from({ length: 55 }, (_, i) => ({
      key: `h${i}`,
      value: "v",
    }));
    const r = normalizeWorkflowNode(node("http-request", { headers }), 0);
    if (r?.type !== "http-request") throw new Error("wrong type");
    expect(r.config.headers.length).toBe(50);
  });
});

// ── delay ─────────────────────────────────────────────────────────────────────

describe("delay", () => {
  it("delayMs 缺失 → 1000", () => {
    const r = normalizeWorkflowNode(node("delay"), 0);
    if (r?.type !== "delay") throw new Error("wrong type");
    expect(r.config.delayMs).toBe(1_000);
  });

  it("delayMs 0 合法（无延迟）", () => {
    const r = normalizeWorkflowNode(node("delay", { delayMs: 0 }), 0);
    if (r?.type !== "delay") throw new Error("wrong type");
    expect(r.config.delayMs).toBe(0);
  });

  it("delayMs 86400001（越上界）→ 1000（fallback）", () => {
    const r = normalizeWorkflowNode(
      node("delay", { delayMs: 86_400_001 }),
      0,
    );
    if (r?.type !== "delay") throw new Error("wrong type");
    expect(r.config.delayMs).toBe(1_000);
  });
});

// ── question-classifier ───────────────────────────────────────────────────────

describe("question-classifier", () => {
  it("categories 超过 20 条截断", () => {
    const categories = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`,
      label: `Cat ${i}`,
    }));
    const r = normalizeWorkflowNode(
      node("question-classifier", { categories }),
      0,
    );
    if (r?.type !== "question-classifier") throw new Error("wrong type");
    expect(r.config.categories.length).toBe(20);
  });
});

// ── human-approval ────────────────────────────────────────────────────────────

describe("human-approval", () => {
  it("timeoutMs 0 合法（无限等待）", () => {
    const r = normalizeWorkflowNode(
      node("human-approval", { timeoutMs: 0 }),
      0,
    );
    if (r?.type !== "human-approval") throw new Error("wrong type");
    expect(r.config.timeoutMs).toBe(0);
  });

  it("onTimeout 缺失 → rejected", () => {
    const r = normalizeWorkflowNode(node("human-approval"), 0);
    if (r?.type !== "human-approval") throw new Error("wrong type");
    expect(r.config.onTimeout).toBe("rejected");
  });
});

// ── code ──────────────────────────────────────────────────────────────────────

describe("code", () => {
  it("language 缺失 → javascript", () => {
    const r = normalizeWorkflowNode(node("code"), 0);
    if (r?.type !== "code") throw new Error("wrong type");
    expect(r.config.language).toBe("javascript");
  });

  it("非法 language → javascript", () => {
    const r = normalizeWorkflowNode(node("code", { language: "ruby" }), 0);
    if (r?.type !== "code") throw new Error("wrong type");
    expect(r.config.language).toBe("javascript");
  });
});

// ── normalizeWorkflow ─────────────────────────────────────────────────────────

describe("normalizeWorkflow", () => {
  it("空对象产生合法默认工作流", () => {
    const wf = normalizeWorkflow({}, 0, NOW);
    expect(wf.id).toBe("workflow-1");
    expect(wf.name).toBe("Workflow 1");
    expect(wf.enabled).toBe(true);
    expect(wf.callableByAgent).toBe(false);
    expect(wf.nodes).toEqual([]);
    expect(wf.connections).toEqual([]);
    expect(wf.runs).toEqual([]);
    expect(wf.lastStatus).toBe("idle");
    expect(wf.createdAt).toBe(NOW);
  });

  it("损坏节点被安全丢弃", () => {
    const wf = normalizeWorkflow(
      {
        nodes: [
          { type: "bad-kind", config: {} },
          { type: "delay", config: { delayMs: 500 } },
        ] as never,
      },
      0,
      NOW,
    );
    expect(wf.nodes.length).toBe(1);
    expect(wf.nodes[0].type).toBe("delay");
  });

  it("悬空边被过滤", () => {
    const wf = normalizeWorkflow(
      {
        nodes: [{ type: "delay", id: "n1", config: {} }] as never,
        connections: [
          { id: "e1", source: "n1", sourceHandle: "out", target: "ghost", targetHandle: "in" },
        ],
      },
      0,
      NOW,
    );
    expect(wf.connections).toHaveLength(0);
  });

  it("有效连接保留", () => {
    const wf = normalizeWorkflow(
      {
        nodes: [
          { type: "manual-trigger", id: "n1", config: {} },
          { type: "delay", id: "n2", config: {} },
        ] as never,
        connections: [
          { id: "e1", source: "n1", sourceHandle: "out", target: "n2", targetHandle: "in" },
        ],
      },
      0,
      NOW,
    );
    expect(wf.connections).toHaveLength(1);
  });

  it(`运行历史超过 MAX_WORKFLOW_RUNS=${MAX_WORKFLOW_RUNS} 时保留最新 N 条`, () => {
    const runs = Array.from({ length: MAX_WORKFLOW_RUNS + 5 }, (_, i) => ({
      id: `r${i}`,
      trigger: "manual",
      status: "success",
      startedAt: "",
      finishedAt: "",
      message: "",
      nodeResults: [],
    }));
    const wf = normalizeWorkflow({ runs: runs as never }, 0, NOW);
    expect(wf.runs.length).toBe(MAX_WORKFLOW_RUNS);
    // 保留最新（最后 N 条）
    expect(wf.runs[wf.runs.length - 1].id).toBe(`r${MAX_WORKFLOW_RUNS + 4}`);
  });
});

// ── normalizeWorkflowInputSchema ──────────────────────────────────────────────

describe("normalizeWorkflowInputSchema", () => {
  it("非数组 → []", () => {
    expect(normalizeWorkflowInputSchema(null)).toEqual([]);
    expect(normalizeWorkflowInputSchema("x")).toEqual([]);
  });

  it("非法 type 降级为 text", () => {
    const schema = normalizeWorkflowInputSchema([
      { key: "x", label: "X", type: "color" },
    ]);
    expect(schema[0].type).toBe("text");
  });

  it("key 为空的条目被过滤", () => {
    const schema = normalizeWorkflowInputSchema([
      { key: "", label: "Empty", type: "text" },
      { key: "name", label: "Name", type: "text" },
    ]);
    expect(schema.length).toBe(1);
    expect(schema[0].key).toBe("name");
  });
});

// ── 所有 25 种 kind 均可规范化 ────────────────────────────────────────────────

describe("所有 25 种 kind 均不抛出", () => {
  const allKinds = [
    "manual-trigger",
    "schedule-trigger",
    "webhook-trigger",
    "ai-agent",
    "generate-image",
    "condition",
    "switch",
    "filter",
    "set-fields",
    "code",
    "sort",
    "limit",
    "aggregate",
    "http-request",
    "merge",
    "subworkflow",
    "loop",
    "delay",
    "template",
    "json",
    "output",
    "parameter-extractor",
    "question-classifier",
    "human-approval",
    "custom",
  ] as const;

  allKinds.forEach((kind) => {
    it(`${kind} 空 config 不抛`, () => {
      expect(() => normalizeWorkflowNode(node(kind), 0)).not.toThrow();
    });
  });
});
