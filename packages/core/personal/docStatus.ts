// 把文档 frontmatter 的自由文本状态（多语种、带括号补注）归一为规范的 TaskStatus 五态。
// 实测值域 {completed, active, ready, 待执行, 待评审, ∅} 跨 YAML/inline 两套编码。
// 策略：剥括号补注 → 小写 → 查同义词表 → 命中失败按 kind 兜底（plan→todo，其余→idea）。
// 纯函数，词表外置便于扩展与测试。

import type { DocKind } from "./docMeta";

export type TaskStatus = "idea" | "todo" | "review" | "active" | "done";

// 规范态展示顺序（UI 分组列即按此序）。
export const TASK_STATUS_ORDER: TaskStatus[] = ["idea", "todo", "review", "active", "done"];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  idea: "构思",
  todo: "待执行",
  review: "待评审",
  active: "进行中",
  done: "已完成",
};

// 同义词表（键为规范态，值为去补注+小写后应命中的词）。中英混合，可扩展。
export const STATUS_SYNONYMS: Record<TaskStatus, string[]> = {
  done: ["completed", "complete", "done", "已完成", "已落地", "已合并"],
  active: ["active", "in-progress", "in progress", "doing", "进行中", "实现中"],
  review: ["待评审", "review", "in-review", "in review", "reviewing"],
  todo: ["ready", "待执行", "planned", "todo", "pending", "待办"],
  idea: ["idea", "draft", "草稿", "构思", "ideation"],
};

// 去掉括号补注（中英括号），用于匹配前的清洗。
export function stripStatusAnnotation(raw: string): string {
  return raw.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
}

const LOOKUP: Map<string, TaskStatus> = (() => {
  const m = new Map<string, TaskStatus>();
  for (const status of Object.keys(STATUS_SYNONYMS) as TaskStatus[]) {
    for (const word of STATUS_SYNONYMS[status]) m.set(word.toLowerCase(), status);
  }
  return m;
})();

// kind 默认态：plan 默认待执行；ideation/brainstorm 默认构思。
export function defaultStatusForKind(kind: DocKind): TaskStatus {
  return kind === "plan" ? "todo" : "idea";
}

// 归一单个 status 文本。命中失败时返回 kind 兜底态（调用方另行保留原文 statusRaw 供 tooltip）。
export function normalizeStatus(raw: string | undefined, kind: DocKind): TaskStatus {
  if (!raw || !raw.trim()) return defaultStatusForKind(kind);
  const cleaned = stripStatusAnnotation(raw).toLowerCase();
  return LOOKUP.get(cleaned) ?? defaultStatusForKind(kind);
}
