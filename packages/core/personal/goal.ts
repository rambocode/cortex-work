import type { ThreadGoal, ThreadGoalStatus } from "../desktop/types";

export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
export const MAX_AUTOMATIC_GOAL_TURNS = 5;
export const GOAL_CONTINUATION_PROMPT = "继续推进当前活动目标。先检查现状，再执行下一步；不要只描述计划。";

export type GoalCommand =
  | { action: "menu" }
  | { action: "set"; objective: string }
  | { action: "pause" | "resume" | "clear" };

/** 解析 `/goal` 命令；非 goal 输入返回 false，供普通发送链继续处理。 */
export function parseGoalCommand(input: string): GoalCommand | false {
  const value = input.trim();
  if (!/^\/goal(?:\s|$)/i.test(value)) return false;
  const tail = value.slice(5).trim();
  if (!tail) return { action: "menu" };
  const control = tail.toLowerCase();
  if (control === "pause" || control === "resume" || control === "clear") {
    return { action: control };
  }
  return { action: "set", objective: normalizeGoalObjective(tail) };
}

export function normalizeGoalObjective(value: string): string {
  return value.trim().slice(0, MAX_GOAL_OBJECTIVE_LENGTH);
}

export function createThreadGoal(
  threadId: string,
  objective: string,
  previous?: ThreadGoal,
  now = new Date(),
): ThreadGoal {
  const normalized = normalizeGoalObjective(objective);
  if (!normalized) throw new Error("目标不能为空");
  const timestamp = now.toISOString();
  return {
    threadId,
    objective: normalized,
    status: "active",
    tokenBudget: previous?.tokenBudget ?? null,
    tokensUsed: previous?.tokensUsed ?? 0,
    timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    autoTurnCount: 0,
  };
}

export function updateThreadGoalStatus(
  goal: ThreadGoal,
  status: ThreadGoalStatus,
  now = new Date(),
): ThreadGoal {
  return {
    ...goal,
    status,
    updatedAt: now.toISOString(),
    ...(status === "active" ? { autoTurnCount: 0 } : {}),
  };
}

/**
 * 给模型的隐藏目标契约。完成/阻塞使用 HTML comment 回报，Markdown 不展示该控制标记；
 * Cortex 在回合收尾解析它并停止续跑。这样三种 CLI/RPC agent 都能共享同一协议。
 */
export function buildGoalSystemPrompt(goal: ThreadGoal): string | undefined {
  if (goal.status !== "active") return undefined;
  const budget = goal.tokenBudget == null
    ? "未设置 token 上限"
    : `token 上限 ${goal.tokenBudget}，已使用 ${goal.tokensUsed}`;
  return [
    "<active_goal>",
    `目标：${goal.objective}`,
    `预算：${budget}`,
    "这是跨回合持久目标，不要把它缩小成当前一轮能完成的替代任务。",
    "每一轮都应检查真实状态并采取可验证的下一步；不要只复述计划或承诺稍后继续。",
    "目标全部完成并验证后，在最终回复末尾加入：<!-- cortex_goal:complete -->。",
    "仅当同一阻塞条件已连续出现且当前无法继续时，在最终回复末尾加入：<!-- cortex_goal:blocked -->。",
    "目标尚未完成时不要输出上述控制标记，宿主会自动发起下一轮继续推进。",
    "</active_goal>",
  ].join("\n");
}

export function goalStatusFromAssistantText(text: string): "complete" | "blocked" | undefined {
  const matches = [...text.matchAll(/<!--\s*cortex_goal:(complete|blocked)\s*-->/gi)];
  return matches.at(-1)?.[1]?.toLowerCase() as "complete" | "blocked" | undefined;
}

export function goalCanAutoContinue(goal: ThreadGoal | undefined): boolean {
  return !!goal && goal.status === "active" && (goal.autoTurnCount ?? 0) < MAX_AUTOMATIC_GOAL_TURNS;
}
