// 真任务系统的 core 层：纯逻辑（状态/日期派生、tag 规范化、状态迁移矩阵）。
// React Query 读写 hooks 由 U4 追加于本文件底部；结构化触发 hook 由 U6 追加。
// 纯函数无 React/IO 依赖，便于表驱动单测（见 tasks.test.ts）。
// 数据类型定义在 ../desktop/types（与 apps/desktop/src/main/ipc/types.ts 逐字镜像）。

import type { TaskMeta, TaskStatus } from "../desktop/types";

// 可执行的状态集：仅这两态视为「可用/可执行」，defer 门控叠加其上。
const ACTIONABLE: readonly TaskStatus[] = ["active", "in-progress"];

// 把 Date 格式化为本地日历日 YYYY-MM-DD（零填充）。
// 用本地日而非 UTC：任务的 due/defer 是用户心智里的「哪一天」，跨时区/DST 以本地日历为准。
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// available（可执行/可用）是派生属性：状态可执行 且 未被 defer 到未来。
// today 由调用方传入（本地日 YYYY-MM-DD），保持纯函数可测。
export function isAvailable(task: Pick<TaskMeta, "status" | "deferDate">, today: string): boolean {
  if (!ACTIONABLE.includes(task.status)) return false;
  if (task.deferDate && task.deferDate > today) return false;
  return true;
}

// Today 资格（KTD7）：状态门控统一前置；三条 OR 子句（今天到期/逾期、defer≤today、已 flag）；
// defer>due 时 due 优先（逾期/今天到期任务无视未来 defer 仍进）。
export function isTodayEligible(
  task: Pick<TaskMeta, "status" | "deferDate" | "dueDate" | "flagged">,
  today: string,
): boolean {
  if (!ACTIONABLE.includes(task.status)) return false;
  const dueReached = !!task.dueDate && task.dueDate <= today;
  const deferReached = !!task.deferDate && task.deferDate <= today;
  const deferInFuture = !!task.deferDate && task.deferDate > today;
  // defer 到未来：只有已逾期/今天到期的 due 能压过它，否则整条任务被 defer 压住不进 Today。
  if (deferInFuture) return dueReached;
  return dueReached || deferReached || !!task.flagged;
}

// 标签规范化：trim + 小写归一；空/纯空白返回 null（调用方据此丢弃）。
// 归一是为了 @Email 与 @email 视为同一标签、Tags 视图不被近重复撑爆。
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  return t.length ? t : null;
}

// 状态迁移矩阵。关键不变式：任何「到达 in-progress」的迁移仅 agent 驱动（用户不可手动置）。
// 成功委派经 in-progress→done（用户确认）；waiting→done 无直接边（成功先归一化到 in-progress）。
const USER_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  active: ["waiting", "done", "dropped"], // 交给 agent(→waiting)、手动完成、放弃
  waiting: ["active", "dropped"], // 取消委派/回退、放弃
  "in-progress": ["done", "dropped"], // 确认 done、放弃(取消 session)
  done: ["active"], // 恢复
  dropped: ["active"], // 恢复
};
// 唯一的 agent 驱动边：waiting→in-progress（实际拉起）、in-progress→waiting（失败/取消回退）。
// 成功不走 agent 直达 done——先归一化到 in-progress，再由用户确认（in-progress→done，用户边）。
const AGENT_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  active: [],
  waiting: ["in-progress"],
  "in-progress": ["waiting"],
  done: [],
  dropped: [],
};

// 校验一次状态迁移是否合法。by 区分用户手动 vs agent 驱动。
export function canTransition(from: TaskStatus, to: TaskStatus, by: "user" | "agent"): boolean {
  if (from === to) return false;
  const table = by === "agent" ? AGENT_TRANSITIONS : USER_TRANSITIONS;
  return table[from].includes(to);
}
