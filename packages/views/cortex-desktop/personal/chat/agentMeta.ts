// 个人工作区 agent 元数据与共享小工具：供会话头（PersonalTopBar）与会话区（PersonalChatArea）复用，
// 避免 AGENT_LABEL / AGENT_AVATAR / agentContact / switchAgent 在两处重复。

import { AGENT_LABEL, DEFAULT_MODEL, mapThinkingAcrossAgents, usePersonalStore } from "@cortex-work/core";
import type { AgentKind, DerivedAgentMeta, ProviderSettings, SessionMeta } from "@cortex-work/core";
import type { Contact } from "@cortex-work/core/types";

// 显示名真源在 core（packages/core/desktop/types.ts）——core 侧的 typing 指示器等也要用同一份，
// 而 core 不能反向依赖 views。这里只做透传，方便 views 内既有的 import 路径不变。
export { AGENT_LABEL };

// 各 agent 头像视觉（claude/codex 沿用原值）。pi 对用户呈现为 "Cortex"，故用首字母 "C" + 靛蓝底；
// 不用 "CX"——那是 Codex 的缩写，两者并列时会撞车。
export const AGENT_AVATAR: Record<AgentKind, { initials: string; bg: string }> = {
  claude: { initials: "CC", bg: "#c96442" },
  codex: { initials: "CX", bg: "#1a1916" },
  pi: { initials: "C", bg: "#4338ca" },
};

const BUILT_IN: readonly string[] = ["claude", "codex", "pi"];

// 把「内置 kind 或派生新 id」解析为其内置 base(U7)。内置→自身;派生→其 base;未知→兜底 "claude"。
// 用于模型/头像等只识内置语义的索引。
export function baseAgentOf(idOrKind: string, derived: DerivedAgentMeta[] | undefined): AgentKind {
  if (idOrKind === "claude" || idOrKind === "codex" || idOrKind === "pi") return idOrKind;
  return derived?.find((d) => d.id === idOrKind)?.base ?? "claude";
}

// 「派生优先、base 兜底」的展示名(U7)。派生→其 label(缺省用 id);内置→AGENT_LABEL[kind];未知 id 直接显示。
export function agentDisplayLabel(idOrKind: string, derived: DerivedAgentMeta[] | undefined): string {
  if (BUILT_IN.includes(idOrKind)) return AGENT_LABEL[idOrKind as AgentKind];
  const meta = derived?.find((d) => d.id === idOrKind);
  if (meta) return meta.label ?? meta.id;
  return AGENT_LABEL[idOrKind as AgentKind] ?? idOrKind;
}

// 展示头像(U7)。M1 派生复用其 base 头像(自定义头像随 FR-M3-4);内置用各自头像。
export function agentDisplayAvatar(
  idOrKind: string,
  derived: DerivedAgentMeta[] | undefined,
): { initials: string; bg: string } {
  return AGENT_AVATAR[baseAgentOf(idOrKind, derived)];
}

// MessageStream 需要 Contact/Conversation 形状,为 CLI agent 合成一份。
export function agentContact(agent: AgentKind): Contact {
  return {
    id: agent,
    name: AGENT_LABEL[agent],
    group: "shared",
    avatar: AGENT_AVATAR[agent],
    agentStatus: "online",
    statusText: "",
    last: "",
    time: "",
    unread: 0,
  };
}

// 切 agent 即换上下文：清掉目标 agent 的旧 resume id,按 agent 给默认 provider/model。
// 纯函数,返回 updateSession 的 patch（副作用由调用方执行）。pi 用默认 provider + 默认模型
//（或 provider 首模型）;其余 agent 用各自默认模型。
//
// U7:切到派生 agent 时传 derived,patch 落 `agent=derived.base`(session.agent 始终存 base)+
// `derivedAgentId=derived.id`;模型/provider/续接槽均按 base 处理(派生与 base 共用 CLI 语义)。
// 切回内置时 derived 省略 → 显式清空 derivedAgentId(否则旧派生标记残留)。resume 槽按 base 键
// (per-session 隔离 + 切换即清,无碰撞)。
export function buildAgentSwitchPatch(
  session: SessionMeta,
  agent: AgentKind,
  providerSettings: ProviderSettings,
  derived?: DerivedAgentMeta,
): Partial<SessionMeta> {
  const base = derived?.base ?? agent;
  const agentSessionIds = { ...session.agentSessionIds };
  delete agentSessionIds[base];
  const piDefaultProvider = providerSettings.providers.find((p) => p.id === providerSettings.defaultProviderId);
  const thinkingPatch = mapThinkingAcrossAgents(
    session.agent,
    base,
    session.agent === "pi" ? session.thinkingLevel : session.effort,
  );
  return {
    agent: base,
    derivedAgentId: derived?.id, // 内置时为 undefined,显式清除旧派生标记
    agentSessionIds,
    claudeSessionId: base === "claude" ? undefined : session.claudeSessionId,
    providerId: base === "pi" ? providerSettings.defaultProviderId : undefined,
    model:
      base === "pi"
        ? (providerSettings.defaultModel ?? piDefaultProvider?.models[0]?.id)
        : DEFAULT_MODEL[base],
    ...thinkingPatch,
  };
}

// 中栏是否正显示会话区（非 automation/home/timeline/noteEditor/settings）。顶栏会话头与执行过程区
// 共用此门控,保证「何时算 chat 视图」单一口径（渲染优先级 automation > noteEditor > home >
// timeline > 会话区，与 PersonalWorkspace 的视图切换对齐）。
export function useChatViewActive(): boolean {
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  const noteEditorId = usePersonalStore((s) => s.noteEditorId);
  const timelineProject = usePersonalStore((s) =>
    s.timelineProjectId ? s.projects.find((p) => p.id === s.timelineProjectId) : undefined,
  );
  return !homeOpen && !automationOpen && !settingsOpen && !noteEditorId && !timelineProject;
}
