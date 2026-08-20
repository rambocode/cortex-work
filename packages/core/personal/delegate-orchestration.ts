import type { RoleConfig } from "../desktop/types";
import {
  enabledSubagentCatalog,
  normalizeSubagentSettings,
  normalizeSubagentSurfaces,
  subagentAvailableOnSurface,
  type SubagentSettings,
  type SubagentSurface,
} from "./subagents";

export const AUTO_SUBAGENT_ROLE_ID = "subagent";

function delegateToolId(id: string): string {
  const safe = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "role";
}

/** Repository Explorer 对齐 Kun 的一等工具名，其余角色继续使用通用 ask_<id> 契约。 */
export function delegateToolName(id: string): string {
  return id === "explore" ? "explore_agent" : `ask_${delegateToolId(id)}`;
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
  surface: Exclude<SubagentSurface, 'shared'> = 'code',
): RoleConfig[] {
  const settings = normalizeSubagentSettings(value);
  if (!settings.useExistingAgents) return [buildAutoSubagentRole(agent)];
  const builtinRoles = enabledSubagentCatalog(settings).flatMap((entry) => {
    const override = settings.profiles[entry.id];
    const automatic = entry.id === "code-reviewer" ? settings.automaticRoles.codeReview : undefined;
    const fallbackSurfaces = entry.surfaces.length ? entry.surfaces : entry.recommendedSurfaces;
    const surfaces = normalizeSubagentSurfaces(override?.surfaces, fallbackSurfaces);
    if (!subagentAvailableOnSurface(surfaces, surface)) return [];
    const customPrompt = override?.systemPrompt?.trim();
    return [{
      id: entry.id,
      label: entry.name,
      agent: override?.agent?.trim() || automatic?.agent || agent,
      model: override?.model?.trim() || automatic?.model?.trim() || undefined,
      effort: override?.effort?.trim() || automatic?.effort || undefined,
      toolPolicy: entry.toolPolicy,
      systemPrompt: [entry.description, customPrompt].filter(Boolean).join("\n\n"),
      color: entry.color,
      avatar: "🤖",
      createdAt: "",
      updatedAt: "",
    }];
  });
  const customRoles = settings.customProfiles.flatMap((profile) => {
    if (!profile.enabled || !subagentAvailableOnSurface(profile.surfaces, surface)) return [];
    return [{
      id: profile.id,
      label: profile.name,
      agent: profile.agent?.trim() || agent,
      model: profile.model?.trim() || undefined,
      effort: profile.effort?.trim() || undefined,
      toolPolicy: profile.toolPolicy,
      systemPrompt: [profile.description, profile.systemPrompt].filter(Boolean).join("\n\n"),
      color: profile.color ?? "#3b82d8",
      createdAt: "",
      updatedAt: "",
    } satisfies RoleConfig];
  });
  return [...builtinRoles, ...customRoles];
}

/**
 * 主会话编排约束：主 agent 自己持有原生会话历史；子 agent 只接收校验后的结构化合同，
 * 执行结果经 ask_* 的 tool_result 回到同一主会话，最终回答只能由主 agent 产出。
 */
export function buildDelegateOrchestrationGuide(
  roles: RoleConfig[],
  options: { requireDelegation: boolean },
): string {
  const roleList = roles.map((role) => `"${role.label}" (${delegateToolName(role.id)})`).join(", ");
  const requirement = options.requireDelegation
    ? "The user explicitly named a collaborator, so you must use the matching delegation tool."
    : "Use an appropriate collaborator whenever substantive work benefits from specialist capability, independent review, " +
      "or parallel independent workflows. Handle only trivial work, tightly coupled serial steps, or clearly faster direct work yourself.";
  const explorerGuide = roles.some((role) => role.id === "explore")
    ? [
        "Use `explore_agent` first for repository or project exploration, including file location, code or keyword search, symbol/call-path tracing, architecture or behavior analysis, and context gathering before edits.",
        "Every `explore_agent` call must name a known absolute target.rootPath. If the target is unknown, resolve it in the parent session or ask the user; never delegate path guessing or broad parent/home-directory scans.",
        "Split complex exploration into parallel calls with non-overlapping evidence scopes, such as API wiring, UI, and tests. Never pack a whole-repository investigation into one call merely to reduce call count.",
        "Choose the number of calls from the real scope. Run calls sequentially only when a later scope depends on an earlier result. Repository Explorer is read-only.",
        "After Repository Explorer returns, perform only narrow checks for uncovered gaps, then retain responsibility for synthesis, edits, and final verification.",
      ]
    : [];
  return [
    "You are the parent agent for the current conversation and hold its native history and user context.",
    `${requirement} Available collaborators for this turn: ${roleList}.`,
    "Every delegation call must provide the complete structured task contract required by the tool: title, objective, target, inScope, outOfScope, constraints, context, deliverable, doneWhen, and blockedWhen.",
    "A child session cannot see this conversation. Do not delegate until the target, required work, forbidden work, supplied evidence, expected output, completion criteria, and blocker conditions are concrete and self-contained.",
    "Access mode is enforced by the selected role. Do not attempt to broaden a read-only role through contract text.",
    ...explorerGuide,
    "The child result returns as a tool result. Combine it with parent context and produce the final answer yourself; never present raw child output as the final answer.",
  ].join("\n");
}
