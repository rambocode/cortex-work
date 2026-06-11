// 个人工作区中间内容区：session 头部（agent/项目信息）+ 消息流（复用团队侧
// MessageStream 渲染管线）+ PersonalComposer。消息数据来自 personal query cache。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  DEFAULT_MODEL,
  usePersonalActions,
  usePersonalChat,
  usePersonalStore,
} from "@cortex-work/core";
import type { AgentKind, ProjectMeta, SessionMeta } from "@cortex-work/core";
import type { Contact, Conversation } from "@cortex-work/core/types";
import { MessageStream } from "../ChatArea";
import { PersonalComposer } from "./PersonalComposer";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };

// MessageStream 需要 Contact/Conversation 形状,为 CLI agent 合成一份。
function agentContact(agent: AgentKind): Contact {
  return {
    id: agent,
    name: AGENT_LABEL[agent],
    group: "shared",
    avatar: agent === "claude" ? { initials: "CC", bg: "#c96442" } : { initials: "CX", bg: "#1a1916" },
    agentStatus: "online",
    statusText: "",
    last: "",
    time: "",
    unread: 0,
  };
}

function EmptyState({ text, hint }: { text: string; hint?: string }) {
  return (
    <main className="chat">
      <div className="pw-center">
        <Icon.Terminal size={26} />
        <div className="pw-center-title">{text}</div>
        {hint ? <div className="pw-center-hint">{hint}</div> : null}
      </div>
    </main>
  );
}

function HiddenHistoryGate({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="pw-history-gate">
      <div className="pw-history-gate-line" />
      <button className="pw-history-gate-btn" onClick={onToggle} type="button">
        <Icon.Clock size={13} />
        <span>已隐藏 {count} 条历史记录</span>
        <b>{expanded ? "收起" : "显示"}</b>
        <span className="pw-history-chev" data-open={expanded}>
          <Icon.Chevron size={11} />
        </span>
      </button>
      <div className="pw-history-gate-line" />
    </div>
  );
}

export function PersonalChatArea({ onToast }: { onToast: (text: string) => void }) {
  const projects = usePersonalStore((s) => s.projects);
  const sessions = usePersonalStore((s) => s.sessions);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const runningBySession = usePersonalStore((s) => s.runningBySession);
  const updateSession = usePersonalStore((s) => s.updateSession);

  const session: SessionMeta | undefined = sessions.find((x) => x.id === activeSessionId);
  const project: ProjectMeta | undefined = session && projects.find((p) => p.id === session.projectId);

  const { allMessages, messages, hiddenCount } = usePersonalChat(session?.id);
  const { send, stop, clearView } = usePersonalActions();
  const [showHiddenHistory, setShowHiddenHistory] = useState(false);

  useEffect(() => {
    setShowHiddenHistory(false);
  }, [session?.id, session?.hiddenHistory?.count, session?.hiddenHistory?.hiddenAt, session?.hiddenHistory?.throughUid]);

  const agent = session?.agent;
  const contact = useMemo(() => (agent ? agentContact(agent) : null), [agent]);
  const displayMessages = showHiddenHistory ? allMessages : messages;
  const convo: Conversation | null = useMemo(
    () =>
      displayMessages.length > 0 || hiddenCount > 0
        ? { headerStatus: { dot: "online", text: "" }, metaRow: [], messages: displayMessages }
        : null,
    [displayMessages, hiddenCount],
  );

  if (projects.length === 0) return <EmptyState text="先在左侧添加一个项目" hint="项目是你电脑上的一个文件夹,Agent 将在该目录下工作" />;
  if (!session || !project || !contact) return <EmptyState text="选择或新建一个 Session" hint="在左侧项目上点 + 新建" />;

  const running = !!runningBySession[session.id];

  const switchAgent = (agent: AgentKind) => {
    const agentSessionIds = { ...session.agentSessionIds };
    delete agentSessionIds[agent];
    updateSession(session.id, {
      agent,
      agentSessionIds,
      claudeSessionId: agent === "claude" ? undefined : session.claudeSessionId,
      model: DEFAULT_MODEL[agent],
    });
  };

  return (
    <main className="chat">
      <div className="chat-head">
        <div className="ch-avatar" style={{ background: contact.avatar.bg }}>
          {contact.avatar.initials}
        </div>
        <div className="ch-meta pw-head-meta">
          <div className="ch-name">
            {session.title}
            <span className="agent-tag">{AGENT_LABEL[session.agent]}</span>
          </div>
          <div className="ch-status">
            <span className="dot" style={{ background: running ? "var(--amber)" : "var(--green)" }} />
            <span className="pw-head-path" title={project.path}>
              {project.name} · {project.path}
            </span>
          </div>
        </div>
        <div className="ch-spacer" />
        <div className="pw-head-controls">
          <span className="pw-head-label">Agent</span>
          <select
            className="pw-agent-select"
            value={session.agent}
            onChange={(e) => {
              const agent = e.target.value as AgentKind;
              // 换 agent 即换上下文,清掉旧 resume id。
              switchAgent(agent);
            }}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </div>
      </div>

      <MessageStream
        contact={contact}
        convo={convo}
        onSelectFile={() => {}}
        activeFile=""
        onApprove={() => {}}
        markdownBodies
        collapsibleLogs
        leadingContent={
          hiddenCount > 0 ? (
            <HiddenHistoryGate
              count={hiddenCount}
              expanded={showHiddenHistory}
              onToggle={() => setShowHiddenHistory((open) => !open)}
            />
          ) : undefined
        }
      />

      <PersonalComposer
        session={session}
        running={running}
        onSend={(text, attachments) => {
          // slash 命令:/clear 默认隐藏当前历史(磁盘历史保留,重启仍隐藏)。
          if (text.trim() === "/clear") {
            clearView(session.id);
            setShowHiddenHistory(false);
            onToast("已隐藏当前历史 · 可随时展开查看");
            return;
          }
          void send(session, project.path, text, attachments);
        }}
        onStop={() => void stop(session.id)}
        onChangeModel={(model) => updateSession(session.id, { model })}
        onToggleSkills={() => updateSession(session.id, { useOwnSkills: session.useOwnSkills === false })}
        onToast={onToast}
      />
    </main>
  );
}
