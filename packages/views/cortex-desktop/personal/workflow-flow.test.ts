// workflow-flow.test.ts — 纯函数 toFlowNodes / toFlowEdges / flowToWorkflowGraph / createWorkflowNode 测试。
// 全部纯 Node 逻辑，无 React DOM 依赖，vitest 可直接运行。

import { describe, expect, it } from "vitest";
import {
  createWorkflowNode,
  flowToWorkflowGraph,
  toFlowEdges,
  toFlowNodes,
} from "./workflow-flow";
import type { WorkflowConnection } from "@cortex-work/core";

// ── 工具函数 ──────────────────────────────────────────────────────────────

function makeConnection(
  source: string,
  target: string,
  sourceHandle = "out",
  targetHandle = "in",
): WorkflowConnection {
  return { id: `e-${source}-${target}`, source, sourceHandle, target, targetHandle };
}

// ── createWorkflowNode ────────────────────────────────────────────────────

describe("createWorkflowNode", () => {
  it("生成唯一 id（前缀 node-）", () => {
    const a = createWorkflowNode("manual-trigger", { x: 0, y: 0 });
    const b = createWorkflowNode("manual-trigger", { x: 0, y: 0 });
    expect(a.id).toMatch(/^node-/);
    expect(a.id).not.toBe(b.id);
  });

  it("position 正确传入", () => {
    const node = createWorkflowNode("ai-agent", { x: 42, y: 99 });
    expect(node.position).toEqual({ x: 42, y: 99 });
  });

  it("manual-trigger：config.workspaceRoot 默认空串", () => {
    const node = createWorkflowNode("manual-trigger", { x: 0, y: 0 });
    expect(node.type).toBe("manual-trigger");
    expect((node.config as { workspaceRoot: string }).workspaceRoot).toBe("");
  });

  it("schedule-trigger：默认 cron schedule", () => {
    const node = createWorkflowNode("schedule-trigger", { x: 0, y: 0 });
    expect(node.type).toBe("schedule-trigger");
    expect((node.config as { schedule: { kind: string } }).schedule.kind).toBe("cron");
  });

  it("condition：默认 operator=contains, caseSensitive=false", () => {
    const node = createWorkflowNode("condition", { x: 0, y: 0 });
    expect(node.type).toBe("condition");
    const config = node.config as { operator: string; caseSensitive: boolean };
    expect(config.operator).toBe("contains");
    expect(config.caseSensitive).toBe(false);
  });

  it("switch：默认 1 条规则 + fallback=true", () => {
    const node = createWorkflowNode("switch", { x: 0, y: 0 });
    const config = node.config as { rules: unknown[]; fallback: boolean };
    expect(config.rules).toHaveLength(1);
    expect(config.fallback).toBe(true);
  });

  it("limit：默认 count=10, from=first", () => {
    const node = createWorkflowNode("limit", { x: 0, y: 0 });
    const config = node.config as { count: number; from: string };
    expect(config.count).toBe(10);
    expect(config.from).toBe("first");
  });

  it("loop：默认 maxIterations=10, mode=condition", () => {
    const node = createWorkflowNode("loop", { x: 0, y: 0 });
    const config = node.config as { maxIterations: number; mode: string };
    expect(config.maxIterations).toBe(10);
    expect(config.mode).toBe("condition");
  });

  it("question-classifier：默认 1 个分类", () => {
    const node = createWorkflowNode("question-classifier", { x: 0, y: 0 });
    const config = node.config as { categories: unknown[] };
    expect(config.categories).toHaveLength(1);
  });

  it("generate-image：含 outputDir", () => {
    const node = createWorkflowNode("generate-image", { x: 0, y: 0 });
    expect("outputDir" in node.config).toBe(true);
  });
});

// ── toFlowNodes ───────────────────────────────────────────────────────────

describe("toFlowNodes", () => {
  it("保留 id / type / position / data.node", () => {
    const node = createWorkflowNode("ai-agent", { x: 10, y: 20 });
    node.id = "fixed-id";
    const [rfNode] = toFlowNodes([node]);
    expect(rfNode!.id).toBe("fixed-id");
    expect(rfNode!.type).toBe("ai-agent");
    expect(rfNode!.position).toEqual({ x: 10, y: 20 });
    expect(rfNode!.data.node).toBe(node); // 同引用，无拷贝
  });

  it("空数组返回空数组", () => {
    expect(toFlowNodes([])).toHaveLength(0);
  });
});

// ── toFlowEdges ───────────────────────────────────────────────────────────

describe("toFlowEdges", () => {
  it("基本字段映射", () => {
    const conn = makeConnection("n1", "n2", "out", "in");
    const [edge] = toFlowEdges([conn]);
    expect(edge!.id).toBe(conn.id);
    expect(edge!.source).toBe("n1");
    expect(edge!.sourceHandle).toBe("out");
    expect(edge!.target).toBe("n2");
    expect(edge!.targetHandle).toBe("in");
  });

  it("running 时 animated=true", () => {
    const conn = makeConnection("n1", "n2");
    const [edge] = toFlowEdges([conn], { n1: "running" });
    expect(edge!.animated).toBe(true);
    expect(edge!.className).toBe("is-running");
  });

  it("非 running 时 animated=false", () => {
    const conn = makeConnection("n1", "n2");
    const [edge] = toFlowEdges([conn], { n1: "success" });
    expect(edge!.animated).toBe(false);
    expect(edge!.className).toBeUndefined();
  });

  it("无 runStatus 时 animated=false", () => {
    const conn = makeConnection("n1", "n2");
    const [edge] = toFlowEdges([conn]);
    expect(edge!.animated).toBe(false);
  });
});

// ── flowToWorkflowGraph ─────────────────────────────────────────────────

describe("flowToWorkflowGraph", () => {
  it("往返无损：节点 config 完整保留", () => {
    const node = createWorkflowNode("ai-agent", { x: 10.7, y: 20.3 });
    const rfNodes = toFlowNodes([node]);
    const { nodes } = flowToWorkflowGraph(rfNodes, []);
    // position 取整
    expect(nodes[0]!.position).toEqual({ x: 11, y: 20 });
    // 其他字段与原始节点一致（config/disabled/name/id/type）
    expect(nodes[0]!.id).toBe(node.id);
    expect(nodes[0]!.type).toBe(node.type);
    expect(nodes[0]!.disabled).toBe(false);
  });

  it("连接往返：sourceHandle/targetHandle 保留", () => {
    const conn = makeConnection("n1", "n2", "true", "in");
    const rfEdges = toFlowEdges([conn]);
    const { connections } = flowToWorkflowGraph([], rfEdges);
    expect(connections[0]!.sourceHandle).toBe("true");
    expect(connections[0]!.targetHandle).toBe("in");
  });

  it("sourceHandle 为 null 时回退 'out'", () => {
    const rfEdge = {
      id: "e1",
      source: "n1",
      sourceHandle: null, // React Flow edge 可能为 null
      target: "n2",
      targetHandle: "in",
    };
    const { connections } = flowToWorkflowGraph([], [rfEdge as never]);
    expect(connections[0]!.sourceHandle).toBe("out");
  });

  it("多节点：position 分别取整", () => {
    const n1 = createWorkflowNode("manual-trigger", { x: 1.1, y: 2.9 });
    const n2 = createWorkflowNode("ai-agent", { x: 300.5, y: 100.4 });
    const rfNodes = toFlowNodes([n1, n2]);
    const { nodes } = flowToWorkflowGraph(rfNodes, []);
    expect(nodes[0]!.position).toEqual({ x: 1, y: 3 });
    expect(nodes[1]!.position).toEqual({ x: 301, y: 100 });
  });

  it("多 handle 节点（condition）：sourceHandle 携带分支标签", () => {
    const condConn: WorkflowConnection = {
      id: "e1",
      source: "cond",
      sourceHandle: "true",
      target: "next",
      targetHandle: "in",
    };
    const rfEdges = toFlowEdges([condConn]);
    const { connections } = flowToWorkflowGraph([], rfEdges);
    expect(connections[0]!.sourceHandle).toBe("true");
  });
});
