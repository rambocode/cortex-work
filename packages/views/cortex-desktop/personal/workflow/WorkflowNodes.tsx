// WorkflowNodes.tsx — 工作流画布节点组件（@xyflow/react 自定义节点）。
// 对齐 Kun WorkflowNodes.tsx：单一节点壳 WorkflowCanvasNode 渲染全部 25 种节点，
// 多 handle 节点（condition / switch / human-approval / question-classifier）
// 分别渲染对应的右侧 source handle。
//
// ⚠️ 本文件静态 import @xyflow/react（Handle/NodeToolbar/Position/NodeProps），
//    因此只能在 WorkflowCanvas.tsx 内通过动态 import 加载，不可在顶层静态引入。
//    WorkflowCanvas.tsx 负责 SSR 隔离（views 包被 Next.js 使用）。

import type { ComponentType, ReactElement } from "react";
import { createContext, useContext } from "react";
import {
  Handle,
  NodeToolbar,
  Position,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { Icon } from "@cortex-work/ui/icons";
import type {
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeRunStatus,
} from "@cortex-work/core";
import { WORKFLOW_NODE_KINDS } from "@cortex-work/core";
import { NODE_ICONS, nodeCategory } from "./workflow-flow";
import type { WorkflowFlowNodeData } from "./workflow-flow";
import { StickyNoteNode } from "./StickyNoteNode";

// ── Context：节点运行状态 & 操作回调 ─────────────────────────────────────────

/** 画布所有节点的运行状态（nodeId → status），由 WorkflowCanvas 提供。 */
export const WorkflowRunStatusContext = createContext<
  Record<string, WorkflowNodeRunStatus>
>({});

export type WorkflowNodeActions = {
  runNode: (nodeId: string) => void;
  toggleDisabled: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  /**
   * 用整个更新后的节点替换原节点（画布内编辑用，目前便签的双击改文本/改色走此路）。
   * 与右面板 NodeConfigPanel 的 onNodeChange 同语义，便签改完即时回写并随保存持久化。
   */
  updateNode: (node: WorkflowNode) => void;
};

export const WorkflowNodeActionsContext = createContext<WorkflowNodeActions>({
  runNode: () => {},
  toggleDisabled: () => {},
  deleteNode: () => {},
  updateNode: () => {},
});

// ── 节点图标映射（对齐 Kun NODE_ICONS，25 种全覆盖）────────────────────────
// 使用 @cortex-work/ui 内联 SVG 图标集（Icon.*），替代 lucide-react，保持全仓视觉统一。
// kind → Icon 映射说明：
//   manual-trigger   → Hand（手形，代表人工启动）
//   schedule-trigger → Clock（时钟，代表定时）
//   webhook-trigger  → Webhook（网络钩子）
//   ai-agent         → Bot（AI 机器人）
//   generate-image   → Image（图片）
//   condition        → GitBranch（分支判断）
//   switch           → Split（一路变多路）
//   filter           → Filter（漏斗过滤）
//   set-fields       → Code（花括号，代表字段映射）
//   code             → Code（代码块）
//   sort             → Sort（双向箭头排序）
//   limit            → Scissors（截取/剪切）
//   aggregate        → Sigma（Σ 聚合）
//   http-request     → Globe（全球网络请求）
//   merge            → Merge（GitMerge 语义）
//   subworkflow      → Workflow（子工作流）
//   loop             → Retry（循环箭头）
//   delay            → Clock（延迟/等待）
//   template         → Type（文字模板）
//   json             → File（JSON 文件）
//   output           → LogOut（输出/导出）
//   parameter-extractor → Task（带 checklist，参数提取）
//   question-classifier → Tags（多标签分类）
//   human-approval   → Users（人工审批，多人）
//   custom           → Workflow（通用/自定义，复用 Workflow 形状）

// NODE_ICONS 已移至 ./workflow-flow（SSR 安全，供 palette 与画布共用），此处直接复用。

// ── 节点标签（中文展示，不走 i18n）──────────────────────────────────────────

const NODE_LABELS: Record<WorkflowNodeKind, string> = {
  "manual-trigger": "手动触发",
  "schedule-trigger": "定时触发",
  "webhook-trigger": "Webhook",
  "ai-agent": "AI 智能体",
  "generate-image": "生成图片",
  condition: "条件",
  switch: "分支",
  filter: "过滤",
  "set-fields": "设置字段",
  code: "代码",
  sort: "排序",
  limit: "限制",
  aggregate: "聚合",
  "http-request": "HTTP 请求",
  merge: "合并",
  subworkflow: "子工作流",
  loop: "循环",
  delay: "延迟",
  template: "模板",
  json: "JSON",
  output: "输出",
  "parameter-extractor": "参数提取",
  "question-classifier": "问题分类",
  "human-approval": "人工审批",
  custom: "自定义",
  "sticky-note": "便签",
};

// ── 节点状态指示点 ────────────────────────────────────────────────────────
// 对齐 mockup：成功/失败/运行中的点带一圈同色软光晕(box-shadow ring)，
// idle/跳过为无光晕的灰点。运行中额外脉冲动画。

function statusDotClass(status: WorkflowNodeRunStatus | undefined): string {
  switch (status) {
    case "running":
      return "bg-amber-500 shadow-[0_0_0_3px_rgba(217,119,6,0.18)] animate-pulse";
    case "success":
      return "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,163,74,0.16)]";
    case "error":
      return "bg-red-500 shadow-[0_0_0_3px_rgba(220,38,38,0.16)]";
    case "skipped":
      return "bg-ds-border";
    default:
      return "bg-ds-faint/40";
  }
}

// ── 节点摘要文本（节点卡片副标题，对齐 Kun nodeSummary）────────────────────

type AnyConfig = Record<string, unknown>;

function nodeSummary(node: {
  type: WorkflowNodeKind;
  config: AnyConfig;
}): string {
  const cfg = node.config;
  switch (node.type) {
    case "schedule-trigger": {
      const s = cfg["schedule"] as
        | { kind: string; expression?: string; minute?: number }
        | undefined;
      if (!s) return "";
      if (s.kind === "cron") return s.expression || "cron";
      if (s.kind === "hourly")
        return `每小时 :${String(s.minute ?? 0).padStart(2, "0")}`;
      if (s.kind === "daily") return "每天";
      if (s.kind === "weekly") return "每周";
      if (s.kind === "once") return "单次";
      return "定时";
    }
    case "webhook-trigger":
      return `${cfg["method"] ?? ""} ${cfg["path"] ?? ""}`.trim();
    case "ai-agent":
      return (
        String(cfg["prompt"] ?? "")
          .trim()
          .slice(0, 60) ||
        String(cfg["model"] ?? "") ||
        "AI 任务"
      );
    case "generate-image":
      return (
        String(cfg["prompt"] ?? "")
          .trim()
          .slice(0, 60) || "图片"
      );
    case "condition":
      return `${cfg["leftExpr"] || "text"} ${cfg["operator"]} ${cfg["rightValue"]}`.trim();
    case "switch": {
      const rules = (cfg["rules"] as unknown[]) ?? [];
      const fallback = cfg["fallback"] ? " + 兜底" : "";
      return `${rules.length} 条规则${fallback}`;
    }
    case "filter":
      return `${cfg["leftExpr"] || "text"} ${cfg["operator"]} ${cfg["rightValue"]}`.trim();
    case "set-fields": {
      const fields = (cfg["fields"] as Array<{ key: string }>) ?? [];
      return fields
        .map((f) => f.key)
        .filter(Boolean)
        .join(", ");
    }
    case "code": {
      const lang = String(cfg["language"] ?? "javascript");
      return lang === "python" ? "Python" : lang === "bash" ? "Shell" : "JS";
    }
    case "sort":
      return `${cfg["field"] || "item"} ${cfg["order"]}`;
    case "limit":
      return `${cfg["from"]} ${cfg["count"]}`;
    case "aggregate":
      return cfg["field"]
        ? `${cfg["mode"]}(${cfg["field"]})`
        : String(cfg["mode"] ?? "");
    case "http-request":
      return `${cfg["method"]} ${cfg["url"]}`.trim();
    case "merge":
      return String(cfg["mode"] ?? "");
    case "loop":
      return cfg["mode"] === "foreach"
        ? `foreach${cfg["execution"] === "parallel" ? ` ∥${cfg["concurrency"] ?? 4}` : ""}`
        : `≤${cfg["maxIterations"]}×`;
    case "delay":
      return `${Math.round(Number(cfg["delayMs"] ?? 1000) / 1000)}s`;
    case "template":
      return (
        String(cfg["template"] ?? "")
          .trim()
          .slice(0, 40) || String(cfg["outputMode"] ?? "")
      );
    case "json":
      return String(cfg["mode"] ?? "");
    case "output": {
      const mode = String(cfg["mode"] ?? "auto");
      const path = String(cfg["jsonPath"] ?? "").trim();
      return mode === "json" && path ? `json: ${path}` : mode;
    }
    case "parameter-extractor": {
      const fields = (cfg["fields"] as unknown[]) ?? [];
      return `${fields.length} 个字段`;
    }
    case "question-classifier": {
      const cats = (cfg["categories"] as unknown[]) ?? [];
      return `${cats.length} 个分类`;
    }
    case "human-approval":
      return String(cfg["title"] ?? "").trim() || "暂停";
    default:
      return "";
  }
}

// ── 工具栏按钮样式 ────────────────────────────────────────────────────────

// 尺寸/圆角/布局走 Tailwind(不被全局 button reset 抹平)；颜色与 hover 背景由未分层
// .wf-node-tb 提供(Tailwind 的 hover:bg-*/text-* 会被 button reset 抹平，见其 CSS 注释)。
// nodrag/nopan 仅作 xyflow 行为标记。删除按钮额外加 danger(hover 变红)。
const TOOLBAR_BTN =
  "nodrag nopan flex h-[30px] w-[30px] items-center justify-center rounded-lg transition wf-node-tb";

// ── 主节点组件（单一壳，渲染全部 25 种节点）──────────────────────────────────

function WorkflowCanvasNode({ id, data, selected }: NodeProps): ReactElement {
  const runStatus = useContext(WorkflowRunStatusContext);
  const actions = useContext(WorkflowNodeActionsContext);
  // data 是 WorkflowFlowNodeData，通过 as 转换（@xyflow/react NodeProps 的 data 为 unknown）
  const node = (data as WorkflowFlowNodeData).node;
  const NodeIcon = NODE_ICONS[node.type];
  const status = runStatus[id];

  const isTrigger =
    node.type === "manual-trigger" ||
    node.type === "schedule-trigger" ||
    node.type === "webhook-trigger";

  const summary = nodeSummary({
    type: node.type,
    config: node.config as AnyConfig,
  });

  // 5 色分类：图标芯片用 .wf-cat-{category} 着色（分类仅由图标颜色体现，不再显示文字标签）。
  const category = nodeCategory(node.type);
  const trimmedName = node.name.trim();
  const title = trimmedName || NODE_LABELS[node.type] || node.type;
  // 副标题：显示节点属性摘要(如 HTTP 的 GET、定时的 cron)，取代原「所属分类」文字。
  // 无摘要时：标题为自定义名 → 回退展示节点类型名；默认名且无摘要 → 留空。
  const subtitle =
    summary || (trimmedName ? NODE_LABELS[node.type] || node.type : "");

  const ring = selected
    ? "border-accent ring-2 ring-accent/30"
    : "border-ds-border";
  const disabled = node.disabled ? "opacity-50" : "";

  // switch/question-classifier 的动态 handle 数取自 config
  const switchRules =
    node.type === "switch"
      ? ((node.config as { rules: unknown[] }).rules ?? [])
      : [];
  const hasSwitchFallback =
    node.type === "switch"
      ? (node.config as { fallback: boolean }).fallback
      : false;
  const classifierCategories =
    node.type === "question-classifier"
      ? ((node.config as { categories: Array<{ id: string; label: string }> })
          .categories ?? [])
      : [];

  return (
    <div
      className={`relative w-[216px] rounded-[8px] border bg-ds-card shadow-sm ${ring} ${disabled}`}
    >
      {/* 选中时展示节点操作工具栏（运行 / 禁用 / 删除）*/}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
        <div className="flex items-center gap-1 rounded-lg border border-ds-border bg-ds-card p-1.5 shadow-md">
          {/* 触发器节点不支持单节点运行 */}
          {!isTrigger ? (
            <button
              type="button"
              className={TOOLBAR_BTN}
              title="运行此节点"
              aria-label="运行此节点"
              onClick={() => actions.runNode(id)}
            >
              <Icon.Run size={14} sw={1.9} />
            </button>
          ) : null}
          <button
            type="button"
            className={TOOLBAR_BTN}
            title={node.disabled ? "启用节点" : "禁用节点"}
            aria-label={node.disabled ? "启用节点" : "禁用节点"}
            onClick={() => actions.toggleDisabled(id)}
          >
            <Icon.Power size={14} sw={1.9} />
          </button>
          <button
            type="button"
            className={`${TOOLBAR_BTN} danger`}
            title="删除节点"
            aria-label="删除节点"
            onClick={() => actions.deleteNode(id)}
          >
            <Icon.Trash size={14} sw={1.9} />
          </button>
        </div>
      </NodeToolbar>

      {/* 非触发器节点需要左侧输入 handle */}
      {!isTrigger ? (
        <Handle type="target" position={Position.Left} id="in" />
      ) : null}

      {/* 头部：分类着色图标 + 标题/kind 副标题 + 运行状态点（对齐 mockup node-head）*/}
      <div className="flex items-center gap-2.5 px-3 pb-2 pt-2.5">
        <span
          className={`wf-ic wf-cat-${category} flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]`}
        >
          <NodeIcon size={16} sw={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ds-ink">
            {title}
          </div>
          {subtitle ? (
            <div className="truncate text-[11px] text-ds-faint">{subtitle}</div>
          ) : null}
        </div>
        {/* 运行状态指示点 */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(status)}`}
        />
      </div>

      {/* 输出 handle：按节点类型分支渲染 */}
      {node.type === "condition" ? (
        // condition：true / false 两路输出
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{ top: "38%" }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{ top: "70%" }}
          />
          <div className="pointer-events-none absolute right-1 top-[30%] text-[9px] font-medium text-emerald-600">
            是
          </div>
          <div className="pointer-events-none absolute right-1 top-[62%] text-[9px] font-medium text-red-500">
            否
          </div>
        </>
      ) : node.type === "switch" ? (
        // switch：动态 case-N handle + 可选 fallback handle
        <>
          {switchRules.map((_, index) => {
            const total = switchRules.length + (hasSwitchFallback ? 1 : 0);
            const top = ((index + 1) / (total + 1)) * 100;
            return (
              <div key={`case-${index}`}>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`case-${index}`}
                  style={{ top: `${top}%` }}
                />
                <div
                  className="pointer-events-none absolute right-1 text-[9px] font-medium text-ds-faint"
                  style={{ top: `calc(${top}% - 7px)` }}
                >
                  {index + 1}
                </div>
              </div>
            );
          })}
          {hasSwitchFallback ? (
            <Handle
              type="source"
              position={Position.Right}
              id="fallback"
              style={{ top: "88%" }}
            />
          ) : null}
        </>
      ) : node.type === "human-approval" ? (
        // human-approval：approved / rejected 两路
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="approved"
            style={{ top: "38%" }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="rejected"
            style={{ top: "70%" }}
          />
          <div className="pointer-events-none absolute right-1 top-[30%] text-[9px] font-medium text-emerald-600">
            批准
          </div>
          <div className="pointer-events-none absolute right-1 top-[62%] text-[9px] font-medium text-red-500">
            拒绝
          </div>
        </>
      ) : node.type === "question-classifier" ? (
        // question-classifier：每个分类一路 handle，id = category.id
        <>
          {classifierCategories.map((cat, index) => {
            const top = ((index + 1) / (classifierCategories.length + 1)) * 100;
            return (
              <div key={cat.id}>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={cat.id}
                  style={{ top: `${top}%` }}
                />
                <div
                  className="pointer-events-none absolute right-1 max-w-[60px] truncate text-[9px] font-medium text-ds-faint"
                  style={{ top: `calc(${top}% - 7px)` }}
                >
                  {cat.label || index + 1}
                </div>
              </div>
            );
          })}
        </>
      ) : node.type === "output" ? null : ( // output 是终态节点，无输出 handle
        // 其余节点：单一输出 handle 'out'
        <Handle type="source" position={Position.Right} id="out" />
      )}
    </div>
  );
}

// 单一组件渲染全部 25 种节点（对齐 Kun：用 ComponentType<NodeProps> 规避 TS 泛型约束）
const sharedNode = WorkflowCanvasNode as ComponentType<NodeProps>;

/**
 * workflowNodeTypes：@xyflow/react 的 nodeTypes 映射。
 * 从 WORKFLOW_NODE_KINDS 派生，防止漏掉新增节点 kind（否则 RF 会用默认无样式节点渲染）。
 */
export const workflowNodeTypes: NodeTypes = {
  ...Object.fromEntries(WORKFLOW_NODE_KINDS.map((kind) => [kind, sharedNode])),
  // 便签用专属组件（彩色卡片 + Markdown + 缩放 + 无 handle），覆盖共享壳。
  "sticky-note": StickyNoteNode as ComponentType<NodeProps>,
};
