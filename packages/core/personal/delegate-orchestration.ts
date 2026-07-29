import type { RoleConfig } from "../desktop/types";

export const AUTO_SUBAGENT_ROLE_ID = "subagent";

function delegateToolId(id: string): string {
  const safe = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "role";
}

/** 全局“子 agent 编排”使用与主会话相同的底层 agent，但运行在独立子会话中。 */
export function buildAutoSubagentRole(agent: string): RoleConfig {
  return {
    id: AUTO_SUBAGENT_ROLE_ID,
    label: "子 Agent",
    agent,
    systemPrompt: "",
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * 主会话编排约束：主 agent 自己持有原生会话历史；子 agent 只接收自包含任务，
 * 执行结果经 ask_* 的 tool_result 回到同一主会话，最终回答只能由主 agent 产出。
 */
export function buildDelegateOrchestrationGuide(
  roles: RoleConfig[],
  options: { requireDelegation: boolean },
): string {
  const roleList = roles.map((role) => `「${role.label}」(ask_${delegateToolId(role.id)})`).join("、");
  const requirement = options.requireDelegation
    ? "你必须先调用可用的 ask_ 工具，把适合独立执行的任务交给子 Agent。"
    : "需要协作时调用对应的 ask_ 工具。";
  return [
    "你是当前对话的主会话 Agent，原生会话历史和用户上下文由你持有。",
    `${requirement}本轮可用协作者：${roleList}。`,
    "子 Agent 是独立会话，看不到主会话历史；调用时必须把任务和必要材料写成自包含的 task。",
    "子 Agent 的执行结果会作为工具结果返回给主会话。收到结果后，由你结合主会话上下文总结并输出最终回答；不要把子 Agent 的原始输出直接当作最终回答。",
  ].join("\n");
}
