// CRE Session 状态机（spec §9、KTD8）。
//
// 定位：main 侧编排器、SQLite 持久化、renderer 的进度 UI 三方共用同一份转移规则。
// 状态枚举本身的真源在 ./types（ResearchSessionStatus），本文件只做「运行时集合 + 转移判定」，
// 刻意不重新声明 union，避免两处漂移。
import type { ResearchSessionStatus, ResearchStage } from "./types";

/// Session 生命周期状态（spec KTD8 逐字）。
///
/// **不存在额外的 "running" 状态**：运行中一律由具体阶段（planning/searching/fetching/
/// evaluating/reporting）表达，这样崩溃恢复时能精确知道该从哪一步续跑，UI 也不必再去猜
/// 「running 到底在干什么」。
export type { ResearchSessionStatus };

/// 全部状态的运行时数组，顺序即生命周期的自然顺序。
/// `satisfies` 保证这里不会多出 ./types 里没有的状态；下面 TRANSITIONS 的 Record 类型
/// 则保证不会少——两个方向都被编译期钉死。
export const RESEARCH_SESSION_STATUSES = [
  "created",
  "planning",
  "searching",
  "fetching",
  "evaluating",
  "reporting",
  "completed",
  "paused",
  "cancelled",
  "failed",
  "interrupted",
] as const satisfies readonly ResearchSessionStatus[];

/// 非终态：正在推进的 5 个运行阶段。它们是「应用重启后必须转 interrupted」的集合，
/// 也是唯一可以被 pause 的集合。注意 created / paused / interrupted 都不在其中——
/// 它们是静止态，既不在跑也不是终点。
export const NON_TERMINAL_RESEARCH_STATUSES = [
  "planning",
  "searching",
  "fetching",
  "evaluating",
  "reporting",
] as const satisfies readonly ResearchStage[];

/// 终态：不可再转出任何状态。想「重跑」只能新建 Session，
/// 这样报告与证据的因果链才不会被就地改写。
export const TERMINAL_RESEARCH_STATUSES = [
  "completed",
  "cancelled",
  "failed",
] as const satisfies readonly ResearchSessionStatus[];

/// 完整转移表（spec §9 状态图）。key 覆盖全部状态由 Record 类型强制，
/// 因此 ./types 新增状态时这里会立刻编译报错，不会出现「没人管的新状态」。
///
/// 与 spec §9 mermaid 图的一处刻意偏离：图里只画了 `paused --> interrupted: app restart`，
/// 但 spec §9 正文明确要求「应用启动时，所有非终态统一转为 interrupted」，验收项也要求
/// searching/fetching/reporting 中途退出后能进入 interrupted。因此 5 个运行阶段都补了
/// 一条指向 interrupted 的边——否则 statusOnAppRestart 产出的归一结果会被编排层的
/// canTransition 守卫拒绝落库，Session 将永远卡在「进程已死却显示进行中」。
const TRANSITIONS: Record<ResearchSessionStatus, readonly ResearchSessionStatus[]> = {
  created: ["planning", "cancelled"],
  planning: ["searching", "paused", "cancelled", "failed", "interrupted"],
  searching: ["fetching", "paused", "cancelled", "failed", "interrupted"],
  fetching: ["evaluating", "paused", "cancelled", "failed", "interrupted"],
  // evaluating 是唯一的分叉点：Gap Planner 的 search_more / fetch_more / finish 三种决策。
  evaluating: ["searching", "fetching", "reporting", "paused", "cancelled", "failed", "interrupted"],
  reporting: ["completed", "paused", "cancelled", "failed", "interrupted"],
  completed: [],
  // paused 只能走向 interrupted（应用重启）。恢复运行统一经 interrupted → 阶段这条边，
  // 让「暂停后恢复」和「崩溃后恢复」共用同一段续跑代码，不留第二条容易漏测的路径。
  paused: ["interrupted"],
  cancelled: [],
  failed: [],
  interrupted: ["planning", "searching", "fetching", "evaluating", "reporting"],
};

/// 应用启动时的状态归一：**全部非终态统一转 interrupted**。
///
/// 为什么不原样保留：进程已经死了，任何 planning/searching/... 都不再有对应的在途操作，
/// 保留它会让 UI 显示一个永远不动的「进行中」。终态与静止态（created/paused/interrupted）
/// 本来就没有在途工作，原样返回。
export function statusOnAppRestart(status: ResearchSessionStatus): ResearchSessionStatus {
  return (NON_TERMINAL_RESEARCH_STATUSES as readonly ResearchSessionStatus[]).includes(status)
    ? "interrupted"
    : status;
}

/// 判定一次状态转移是否合法。未知状态（来自被手改或跨版本的持久化数据）返回 false 而非抛错，
/// 让上层能把它当成「拒绝转移」处理，而不是整个恢复流程崩掉。
export function canTransition(from: ResearchSessionStatus, to: ResearchSessionStatus): boolean {
  const allowed = TRANSITIONS[from];
  return allowed === undefined ? false : allowed.includes(to);
}

/// 恢复一个中断会话时应回到的阶段：以「中断前的状态」为输入，返回续跑的目标状态。
///
/// 5 个运行阶段各自原地续跑（spec §9 的 interrupted → * 边）。
/// created / paused / interrupted 这三种情况缺少可靠的阶段信息，保守回到 planning——
/// 重新规划不会丢已提交的证据（证据按 contentHash 复用），比猜错阶段去续跑一个不存在的
/// 在途操作安全得多。终态无需恢复，原样返回。
export function resumeTargetFor(interruptedFrom: ResearchSessionStatus): ResearchSessionStatus {
  if ((NON_TERMINAL_RESEARCH_STATUSES as readonly ResearchSessionStatus[]).includes(interruptedFrom)) {
    return interruptedFrom;
  }
  if ((TERMINAL_RESEARCH_STATUSES as readonly ResearchSessionStatus[]).includes(interruptedFrom)) {
    return interruptedFrom;
  }
  return "planning";
}
