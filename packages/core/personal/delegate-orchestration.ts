import type { RoleConfig } from "../desktop/types";
import {
  enabledSubagentCatalog,
  normalizeSubagentSettings,
  type SubagentSettings,
} from "./subagents";

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
 * 把持久化的 Kun 角色目录解析成本轮 delegate 工具。
 *
 * “使用现有代理”关闭时保留 Cortex 旧行为：只暴露一个由主 Agent 即时定义任务的匿名角色；
 * 开启时则暴露所有可用目录角色，让主 Agent 按角色描述自行路由。设置只保存覆盖，名称、策略与
 * 默认提示始终取代码目录，升级后不会被旧存档冻结。
 */
export function buildConfiguredSubagentRoles(
  agent: string,
  value: Partial<SubagentSettings> | undefined,
): RoleConfig[] {
  const settings = normalizeSubagentSettings(value);
  if (!settings.useExistingAgents) return [buildAutoSubagentRole(agent)];
  return enabledSubagentCatalog(settings).map((entry) => {
    const override = settings.profiles[entry.id];
    const customPrompt = override?.systemPrompt?.trim();
    return {
      id: entry.id,
      label: entry.name,
      agent: override?.agent?.trim() || agent,
      model: override?.model?.trim() || undefined,
      effort: override?.effort?.trim() || undefined,
      toolPolicy: entry.toolPolicy,
      systemPrompt: [entry.description, customPrompt].filter(Boolean).join("\n\n"),
      color: entry.color,
      avatar: "🤖",
      createdAt: "",
      updatedAt: "",
    };
  });
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
    ? "用户已显式点名协作者；你必须调用对应的 ask_ 工具完成该委派。"
    : "你自行判断本轮是否需要协作、调用哪些协作者以及调用多少次；不需要时直接完成任务。";
  return [
    "你是当前对话的主会话 Agent，原生会话历史和用户上下文由你持有。",
    `${requirement}本轮可用协作者：${roleList}。`,
    "子 Agent 是独立会话，看不到主会话历史；调用时必须把任务和必要材料写成自包含的 task。",
    "子 Agent 的执行结果会作为工具结果返回给主会话。收到结果后，由你结合主会话上下文总结并输出最终回答；不要把子 Agent 的原始输出直接当作最终回答。",
  ].join("\n");
}
