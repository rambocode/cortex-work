// workflow-flow.ts — 纯函数：WorkflowDef ↔ @xyflow/react 数据互转。
// 无副作用、无 React 依赖，可在 Node 环境 / vitest 直接跑。
// 对应 Kun workflow-types.ts 的 toFlowNodes / toFlowEdges / flowToWorkflowGraph / createWorkflowNode。
//
// ⚠️ 跨层约束：
//   1. 本文件仅依赖 @cortex-work/core 和 @xyflow/react/system 类型（无 React DOM）。
//   2. @xyflow/react 的 MarkerType 通过字符串常量规避 SSR 问题（动态 import 只在 WorkflowCanvas 用）。
//   3. flowToWorkflowGraph 是无损往返的：node.data.node 保持原始引用，仅更新 position（取整）。

import type { ReactElement } from "react";
import type { Edge, Node } from "@xyflow/react";
import { Icon, type IconProps } from "@cortex-work/ui/icons";
import type {
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowConnection,
  WorkflowNodeRunStatus,
} from "@cortex-work/core";

// ── 节点 kind → 图标映射 ──────────────────────────────────────────────────────
// 放在本 SSR 安全模块（仅 type-import xyflow），供 palette(WorkflowEditorView) 与
// 画布节点(WorkflowNodes) 共用——对齐 Kun：菜单/节点用图标而非首字母徽章。
export type NodeIconComponent = (p: IconProps) => ReactElement;
export const NODE_ICONS: Record<WorkflowNodeKind, NodeIconComponent> = {
  "manual-trigger": Icon.Hand,
  "schedule-trigger": Icon.Clock,
  "webhook-trigger": Icon.Webhook,
  "ai-agent": Icon.Bot,
  "generate-image": Icon.Image,
  condition: Icon.GitBranch,
  switch: Icon.Split,
  filter: Icon.Filter,
  "set-fields": Icon.Code,
  code: Icon.Code,
  sort: Icon.Sort,
  limit: Icon.Scissors,
  aggregate: Icon.Sigma,
  "http-request": Icon.Globe,
  merge: Icon.Merge,
  subworkflow: Icon.Workflow,
  loop: Icon.Retry,
  delay: Icon.Clock,
  template: Icon.Type,
  json: Icon.File,
  output: Icon.LogOut,
  "parameter-extractor": Icon.Task,
  "question-classifier": Icon.Tags,
  "human-approval": Icon.Users,
  custom: Icon.Workflow,
};

// ── 类型别名 ────────────────────────────────────────────────────────────────

export type WorkflowFlowNodeData = {
  node: WorkflowNode;
  [key: string]: unknown;
};

export type WorkflowFlowNode = Node<WorkflowFlowNodeData>;
export type WorkflowFlowEdge = Edge;

// ── Palette 分组（对齐 Kun WORKFLOW_PALETTE_GROUPS + action 组补充 subworkflow/delay/output）──

export const WORKFLOW_PALETTE_GROUPS: ReadonlyArray<{
  id: string;
  kinds: readonly WorkflowNodeKind[];
}> = [
  { id: "trigger", kinds: ["manual-trigger", "schedule-trigger", "webhook-trigger"] },
  { id: "ai", kinds: ["ai-agent", "generate-image", "parameter-extractor"] },
  { id: "flow", kinds: ["condition", "switch", "question-classifier", "filter", "merge", "loop", "human-approval"] },
  { id: "data", kinds: ["set-fields", "template", "json", "code", "sort", "limit", "aggregate"] },
  { id: "action", kinds: ["http-request", "subworkflow", "delay", "output"] },
];

export const TRIGGER_KINDS: ReadonlySet<WorkflowNodeKind> = new Set([
  "manual-trigger",
  "schedule-trigger",
  "webhook-trigger",
]);

// ── Edge 默认样式常量（MarkerType.ArrowClosed 的字符串值为 "arrowclosed"）──
const EDGE_MARKER_END = { type: "arrowclosed" as const, width: 16, height: 16 };

// ── uid 生成（前缀 + crypto.randomUUID 或降级）─────────────────────────────

function uid(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return `${prefix}-${random}`;
}

// ── createWorkflowNode ──────────────────────────────────────────────────────
// 1:1 对齐 Kun workflow-types.ts createWorkflowNode，但 config 使用 cortex-work 的
// WorkflowNode 类型（ScheduleSpec 字段名与 Kun 略有差异，已对齐本仓库 core 类型）。

export function createWorkflowNode(
  kind: WorkflowNodeKind,
  position: { x: number; y: number },
): WorkflowNode {
  const base = { id: uid("node"), name: "", position, disabled: false };

  switch (kind) {
    case "manual-trigger":
      return { ...base, type: "manual-trigger", config: { workspaceRoot: "" } };

    case "schedule-trigger":
      return {
        ...base,
        type: "schedule-trigger",
        config: {
          // ScheduleSpec 对齐 core/desktop/workflow-types.ts（kind=cron 为默认）
          schedule: { kind: "cron", expression: "0 9 * * *" },
          workspaceRoot: "",
        },
      };

    case "webhook-trigger":
      return {
        ...base,
        type: "webhook-trigger",
        config: { path: "/webhook", method: "ANY", workspaceRoot: "" },
      };

    case "ai-agent":
      return {
        ...base,
        type: "ai-agent",
        config: {
          prompt: "",
          workspaceRoot: "",
          providerId: "",
          model: "",
          reasoningEffort: "medium",
          mode: "agent",
        },
      };

    case "generate-image":
      return {
        ...base,
        type: "generate-image",
        config: { prompt: "", providerId: "", model: "", size: "", outputDir: "" },
      };

    case "condition":
      return {
        ...base,
        type: "condition",
        config: { leftExpr: "", operator: "contains", rightValue: "", caseSensitive: false },
      };

    case "switch":
      return {
        ...base,
        type: "switch",
        config: {
          rules: [{ leftExpr: "", operator: "contains", rightValue: "", caseSensitive: false }],
          fallback: true,
        },
      };

    case "filter":
      return {
        ...base,
        type: "filter",
        config: { leftExpr: "", operator: "contains", rightValue: "", caseSensitive: false },
      };

    case "set-fields":
      return {
        ...base,
        type: "set-fields",
        config: { fields: [{ key: "", value: "" }], keepIncoming: false, scope: "payload" },
      };

    case "sort":
      return { ...base, type: "sort", config: { field: "", order: "asc", numeric: false } };

    case "limit":
      return { ...base, type: "limit", config: { count: 10, from: "first" } };

    case "aggregate":
      return { ...base, type: "aggregate", config: { mode: "count", field: "", separator: ", " } };

    case "code":
      return {
        ...base,
        type: "code",
        config: { language: "javascript", code: "return $json" },
      };

    case "merge":
      return { ...base, type: "merge", config: { mode: "array" } };

    case "subworkflow":
      return { ...base, type: "subworkflow", config: { workflowId: "" } };

    case "loop":
      return {
        ...base,
        type: "loop",
        config: {
          workflowId: "",
          mode: "condition",
          arraySource: "",
          execution: "sequential",
          concurrency: 4,
          continueOnError: false,
          maxIterations: 10,
          leftExpr: "json.done",
          operator: "equals",
          rightValue: "true",
          caseSensitive: false,
        },
      };

    case "http-request":
      return {
        ...base,
        type: "http-request",
        config: {
          method: "GET",
          url: "",
          headers: [],
          body: "",
          timeoutMs: 30_000,
          parseJson: false,
        },
      };

    case "delay":
      return { ...base, type: "delay", config: { delayMs: 1_000 } };

    case "template":
      return { ...base, type: "template", config: { template: "", outputMode: "text" } };

    case "json":
      return { ...base, type: "json", config: { mode: "parse", strict: false } };

    case "output":
      return { ...base, type: "output", config: { mode: "auto", textTemplate: "", jsonPath: "" } };

    case "parameter-extractor":
      return {
        ...base,
        type: "parameter-extractor",
        config: {
          source: "",
          instruction: "",
          fields: [],
          providerId: "",
          model: "",
          reasoningEffort: "medium",
        },
      };

    case "question-classifier":
      return {
        ...base,
        type: "question-classifier",
        config: {
          source: "",
          instruction: "",
          categories: [{ id: "cat-1", label: "" }],
          providerId: "",
          model: "",
          reasoningEffort: "medium",
        },
      };

    case "human-approval":
      return {
        ...base,
        type: "human-approval",
        config: { title: "", instruction: "", timeoutMs: 0, onTimeout: "rejected" },
      };

    case "custom":
      return { ...base, type: "custom", config: { moduleId: "", values: {} } };

    default: {
      // 防御：未知 kind 降级为 manual-trigger
      const _exhaustive: never = kind;
      void _exhaustive;
      return { ...base, type: "manual-trigger", config: {} };
    }
  }
}

// ── toFlowNodes ─────────────────────────────────────────────────────────────
// WorkflowNode[] → WorkflowFlowNode[]（无损）。
// 每个 FlowNode 的 data.node 保持对原始对象的引用（flowToWorkflowGraph 重建时取出）。

export function toFlowNodes(nodes: WorkflowNode[]): WorkflowFlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    // React Flow nodeTypes key 与 node.type 同名（workflowNodeTypes 映射保证覆盖全部 25 种）
    type: node.type,
    position: node.position,
    data: { node },
  }));
}

// ── toFlowEdges ─────────────────────────────────────────────────────────────
// WorkflowConnection[] → WorkflowFlowEdge[]。
// 可选传入 runStatus：source 节点 'running' 时边加 animated 动画，与 Kun 对齐。

export function toFlowEdges(
  connections: WorkflowConnection[],
  runStatus?: Record<string, WorkflowNodeRunStatus>,
): WorkflowFlowEdge[] {
  return connections.map((conn) => {
    const sourceRunning = runStatus?.[conn.source] === "running";
    return {
      id: conn.id,
      source: conn.source,
      sourceHandle: conn.sourceHandle || "out",
      target: conn.target,
      targetHandle: conn.targetHandle || "in",
      type: "default",
      markerEnd: EDGE_MARKER_END,
      // running 时加边动画以直观反映执行进度（对齐 Kun toFlowEdges）
      animated: sourceRunning,
      className: sourceRunning ? "is-running" : undefined,
    };
  });
}

// ── flowToWorkflowGraph ─────────────────────────────────────────────────────
// WorkflowFlowNode[] + WorkflowFlowEdge[] → { nodes, connections }
// 无损往返保证：
//   - 节点数据取自 rfNode.data.node（完整 WorkflowNode，保持所有 config/inputs/onError 字段）
//   - 仅更新 position（Math.round 取整，防止 px 累积偏移）
//   - 连接从 edge 的 sourceHandle/targetHandle 读回（默认 'out'/'in'）

export function flowToWorkflowGraph(
  rfNodes: WorkflowFlowNode[],
  rfEdges: WorkflowFlowEdge[],
): { nodes: WorkflowNode[]; connections: WorkflowConnection[] } {
  const nodes: WorkflowNode[] = rfNodes.map((rfNode) => ({
    ...rfNode.data.node,
    position: {
      x: Math.round(rfNode.position.x),
      y: Math.round(rfNode.position.y),
    },
  }));

  const connections: WorkflowConnection[] = rfEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    // sourceHandle 不能为 null（React Flow edge 里可能为 null，显式回退 'out'）
    sourceHandle: edge.sourceHandle ?? "out",
    target: edge.target,
    targetHandle: edge.targetHandle ?? "in",
  }));

  return { nodes, connections };
}
