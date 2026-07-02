// 项目阶段/进度派生纯逻辑（参照 IFocus 项目详情头部与阶段 tab）。
// 进度 = done 任务数 / 未丢弃任务总数（dropped 不计入分母——丢弃的任务不再是目标，
// 计入会让进度永远到不了 100%）；total=0 → 0%。纯函数无 IO，单测见 projectStages.test.ts。

import type { ProjectStage, ProjectStageStatus, TaskMeta } from "../desktop/tasks-types";

export interface ProjectProgress {
  done: number;
  total: number; // 不含 dropped
  percent: number; // 0-100 四舍五入整数
}

// 项目进度：入参为该项目下全部任务（含子任务）。
export function projectProgress(tasks: Pick<TaskMeta, "status">[]): ProjectProgress {
  const counted = tasks.filter((t) => t.status !== "dropped");
  const done = counted.filter((t) => t.status === "done").length;
  const total = counted.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, percent };
}

// 阶段按 order 升序（order 相同保持原序，Array.prototype.sort 已稳定）。返回新数组不改入参。
export function sortStages(stages: ProjectStage[]): ProjectStage[] {
  return [...stages].sort((a, b) => a.order - b.order);
}

// 阶段状态 → 语义 token（views 层映射到 pw-stage-dot--* 颜色类；集中一处防各组件硬编码漂移）。
export const STAGE_STATUS_META: readonly { value: ProjectStageStatus; label: string }[] = [
  { value: "not-started", label: "未开始" },
  { value: "active", label: "进行中" },
  { value: "done", label: "已完成" },
];

export function stageStatusLabel(status: ProjectStageStatus): string {
  return STAGE_STATUS_META.find((m) => m.value === status)?.label ?? status;
}
