// 个人工作区 agent 元数据与共享小工具：供会话头（PersonalTopBar）与会话区（PersonalChatArea）复用，
// 避免 AGENT_LABEL / AGENT_AVATAR / agentContact / switchAgent 在两处重复。

import { DEFAULT_MODEL, usePersonalStore } from "@cortex-work/core";
import type { AgentKind, ProviderSettings, SessionMeta } from "@cortex-work/core";
import type { Contact } from "@cortex-work/core/types";

export const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

// 各 agent 头像视觉（claude/codex 沿用原值,pi 用缩写 PI + 靛蓝底,对应设计稿 PI 头像）。
export const AGENT_AVATAR: Record<AgentKind, { initials: string; bg: string }> = {
  claude: { initials: "CC", bg: "#c96442" },
  codex: { initials: "CX", bg: "#1a1916" },
  pi: { initials: "PI", bg: "#4338ca" },
};

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
export function buildAgentSwitchPatch(
  session: SessionMeta,
  agent: AgentKind,
  providerSettings: ProviderSettings,
): Partial<SessionMeta> {
  const agentSessionIds = { ...session.agentSessionIds };
  delete agentSessionIds[agent];
  const piDefaultProvider = providerSettings.providers.find((p) => p.id === providerSettings.defaultProviderId);
  return {
    agent,
    agentSessionIds,
    claudeSessionId: agent === "claude" ? undefined : session.claudeSessionId,
    providerId: agent === "pi" ? providerSettings.defaultProviderId : undefined,
    model:
      agent === "pi"
        ? (providerSettings.defaultModel ?? piDefaultProvider?.models[0]?.id)
        : DEFAULT_MODEL[agent],
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
