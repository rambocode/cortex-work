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
 * 主会话编排约束：主 agent 自己持有原生会话历史；子 agent 只接收自包含任务，
 * 执行结果经 ask_* 的 tool_result 回到同一主会话，最终回答只能由主 agent 产出。
 */
export function buildDelegateOrchestrationGuide(
  roles: RoleConfig[],
  options: { requireDelegation: boolean },
): string {
  const roleList = roles.map((role) => `「${role.label}」(${delegateToolName(role.id)})`).join("、");
  const requirement = options.requireDelegation
    ? "用户已显式点名协作者；你必须调用对应的协作者工具完成该委派。"
    : "实质性任务只要受益于专项能力、独立复核或多个互不依赖的工作流，就必须调用合适的协作者工具；" +
      "只有琐碎工作、紧密耦合的串行步骤，或主会话明显能更快完成的任务才直接处理。";
  const explorerGuide = roles.some((role) => role.id === "explore")
    ? [
        "任何仓库或项目探索都必须先调用 `explore_agent`，包括文件定位、代码或关键词搜索、符号与调用链追踪、架构或行为分析，以及修改前的上下文收集。",
        "复杂探索必须按互不重叠的范围动态拆成多个并行 `explore_agent` 调用，禁止把整仓调查塞进一次调用；每次调用都要给出 2-6 个词的简短 title 和范围明确、自包含的 query。",
        "拆分时采用 Kun 的非重叠证据面示例：one call for API wiring, another for UI, another for tests。整项目分析要先枚举所有适用的独立证据面，例如产品定位、后端或核心实现、前端交互、测试与完成度；不得为了减少调用次数把彼此独立的证据面合并。",
        "拆分数量由问题范围决定，不得固定调用次数；只有后一个问题依赖前一个结果时才按顺序调用。Repository Explorer 只读且不会修改文件。",
        "Repository Explorer 返回后，主会话只对未覆盖的窄问题做补充检查，并继续负责整合、修改和最终验证。",
      ]
    : [];
  return [
    "你是当前对话的主会话 Agent，原生会话历史和用户上下文由你持有。",
    `${requirement}本轮可用协作者：${roleList}。`,
    ...explorerGuide,
    "子 Agent 是独立会话，看不到主会话历史；调用时必须把任务和必要材料写成自包含的 task（Repository Explorer 使用 query）。",
    "子 Agent 的执行结果会作为工具结果返回给主会话。收到结果后，由你结合主会话上下文总结并输出最终回答；不要把子 Agent 的原始输出直接当作最终回答。",
  ].join("\n");
}
