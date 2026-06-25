// 工作流展示用纯函数：节点数摘要、状态标签/变体、相对时间、最近结果摘要。
// WorkflowList 与未来的 WorkflowDetail 共用,避免文案漂移。无 React 依赖。

import type { WorkflowRunStatus, WorkflowNode } from "@cortex-work/core";

// ── 触发器 chip ──────────────────────────────────────────────────────────────

/** 从节点列表推导触发器 chip 文本（展示在最近结果摘要前的来源标签）。
 *  取第一个触发器节点的种类映射为简短中文/英文标签；无触发器返回空串（不渲染 chip）。 */
export function formatTriggerChip(nodes: WorkflowNode[] | undefined): string {
  if (!nodes?.length) return "";
  for (const n of nodes) {
    switch (n.type) {
      case "manual-trigger":
        return "手动";
      case "schedule-trigger":
        return "定时";
      case "webhook-trigger":
        return "webhook";
    }
  }
  return "";
}

// ── 节点数摘要 ───────────────────────────────────────────────────────────────

/** 将节点数量格式化为简洁展示文本，如「5 个节点」。 */
export function formatNodeCount(count: number): string {
  if (count <= 0) return "0 个节点";
  return `${count} 个节点`;
}

// ── 运行状态 ─────────────────────────────────────────────────────────────────

export type StatusVariant = "success" | "error" | "pending" | "default";

/** 将 WorkflowRunStatus 转为展示标签与 pill 样式变体。
 *  变体名与 AutomationList 的 STATUS_CLASS 保持相同语义,方便日后统一样式。 */
export function formatWorkflowStatus(status: WorkflowRunStatus): {
  label: string;
  variant: StatusVariant;
} {
  switch (status) {
    case "running":
      return { label: "运行中", variant: "pending" };
    case "success":
      return { label: "成功", variant: "success" };
    case "error":
      return { label: "失败", variant: "error" };
    case "idle":
    default:
      return { label: "空闲", variant: "default" };
  }
}

// 变体 → CSS 类映射（与 automationFormat STATUS_CLASS 风格对齐）。
export const WORKFLOW_STATUS_CLASS: Record<StatusVariant, string> = {
  success: "is-ok",
  error: "is-err",
  pending: "is-running",
  default: "",
};

// ── 相对时间 ─────────────────────────────────────────────────────────────────

/** 将 ISO 8601 字符串或 Date 对象（或空值）转为中文相对时间。
 *  空值返回「—」;无效日期回退到 ISO 原文。 */
export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  // new Date("") 会产生 NaN
  if (!Number.isFinite(d.getTime())) return typeof date === "string" ? date : "—";

  const diff = Date.now() - d.getTime();
  // 未来时间（时钟漂移等）仍展示「刚刚」
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  if (day < 30) return `${Math.floor(day / 7)} 周前`;
  return `${Math.floor(day / 30)} 个月前`;
}

// ── 最近结果摘要 ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_LEN = 240;

/** 截断最近运行结果文本，超出 maxLen 追加省略号。空值返回空串。 */
export function formatRunResultSummary(
  result: string | null | undefined,
  maxLen: number = DEFAULT_MAX_LEN,
): string {
  if (!result) return "";
  const trimmed = result.trim();
  if (!trimmed) return "";
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}
