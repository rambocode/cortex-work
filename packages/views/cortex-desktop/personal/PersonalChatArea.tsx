// 个人工作区中间内容区：session 头部（agent/项目信息）+ 消息流（复用团队侧
// MessageStream 渲染管线）+ PersonalComposer。消息数据来自 personal query cache。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  defaultAgent,
  getTtsPlaybackState,
  speakText,
  stopSpeaking,
  subscribeTtsPlayback,
  useDesktopBridge,
  usePersonalActions,
  usePersonalChat,
  usePersonalStore,
} from "@cortex-work/core";
import type { AgentKind, ProjectMeta, SessionMeta } from "@cortex-work/core";
import type { Contact, Conversation } from "@cortex-work/core/types";
import { MessageStream } from "../ChatArea";
import { GitBar } from "./GitBar";
import { PersonalComposer } from "./PersonalComposer";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

// 各 agent 头像视觉（claude/codex 沿用原值,pi 用缩写 PI + 靛蓝底）。
const AGENT_AVATAR: Record<AgentKind, { initials: string; bg: string }> = {
  claude: { initials: "CC", bg: "#c96442" },
  codex: { initials: "CX", bg: "#1a1916" },
  pi: { initials: "PI", bg: "#4338ca" },
};

// MessageStream 需要 Contact/Conversation 形状,为 CLI agent 合成一份。
function agentContact(agent: AgentKind): Contact {
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
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const createSession = usePersonalStore((s) => s.createSession);
  const runningBySession = usePersonalStore((s) => s.runningBySession);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const ttsSettings = usePersonalStore((s) => s.ttsSettings);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const piSettings = usePersonalStore((s) => s.piSettings);
  const bridge = useDesktopBridge();

  const session: SessionMeta | undefined = sessions.find((x) => x.id === activeSessionId);
  const realProject: ProjectMeta | undefined =
    session && session.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
  // 无项目会话:合成一个项目对象,使下游(send / EmptyState 守卫)无需特判;
  // path 用会话创建时定下的 noProjectDir(不漂移)。GitBar 仍只对真实项目渲染。
  const syntheticNoProject = useMemo<ProjectMeta | undefined>(() => {
    if (!session || session.projectId) return undefined;
    return {
      id: "__noproject__",
      name: "无项目",
      path: session.noProjectDir ?? "",
      addedAt: 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.noProjectDir]);
  const project: ProjectMeta | undefined = realProject ?? syntheticNoProject;

  const { allMessages, messages, hiddenCount } = usePersonalChat(session?.id);
  const { send, stop: stopRun, editResend, clearView } = usePersonalActions();
  const [showHiddenHistory, setShowHiddenHistory] = useState(false);
  const [ttsPlayback, setTtsPlayback] = useState(getTtsPlaybackState);
  // 编辑重发:正在编辑的历史用户消息(原文填入 composer,发送时截断其后所有消息)。
  const [editing, setEditing] = useState<{ uid: string; text: string } | null>(null);

  useEffect(() => {
    setShowHiddenHistory(false);
    setEditing(null);
  }, [session?.id, session?.hiddenHistory?.count, session?.hiddenHistory?.hiddenAt, session?.hiddenHistory?.throughUid]);

  useEffect(() => subscribeTtsPlayback(setTtsPlayback), []);

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

  // 既无可用会话又无项目时才提示添加项目;有无项目会话(session 存在)则放行,
  // 让下面的会话渲染路径接管,避免无项目会话被早退拦截。
  if (projects.length === 0 && !session)
    return <EmptyState text="先在左侧添加一个项目" hint="项目是你电脑上的一个文件夹,Agent 将在该目录下工作" />;
  // 已激活项目但未选会话（左栏点击项目名进入）:引导新建聊天,右栏此时已切到
  // 该项目的 Tasks,可在标题栏菜单换成文件视图。
  if (!session) {
    const activeProject = projects.find((p) => p.id === activeProjectId);
    if (activeProject) {
      const hasSessions = sessions.some((x) => x.projectId === activeProject.id);
      return (
        <main className="chat">
          <div className="pw-center">
            <Icon.Folder size={26} />
            <div className="pw-center-title">{activeProject.name}</div>
            <div className="pw-center-hint">
              {hasSessions
                ? "在左侧选择一个 Session,或新建聊天继续与 Agent 协作"
                : "这个项目还没有聊天。新建一个开始与 Agent 协作;右侧面板可查看项目 Tasks 与文件"}
            </div>
            <button
              className="btn primary pw-center-cta"
              onClick={() => {
                createSession(activeProject.id, defaultAgent(agentsAvailable));
                onToast(`已在 ${activeProject.name} 新建 Session`);
              }}
            >
              <Icon.Plus size={13} />
              新建聊天
            </button>
          </div>
        </main>
      );
    }
  }
  if (!session || !project || !contact) return <EmptyState text="选择或新建一个 Session" hint="在左侧项目上点 + 新建" />;

  const running = !!runningBySession[session.id];

  const switchAgent = (agent: AgentKind) => {
    const agentSessionIds = { ...session.agentSessionIds };
    delete agentSessionIds[agent];
    // pi:用默认通道 + 默认模型（或通道首模型）;其余 agent 用各自默认模型。
    const piDefaultChannel = piSettings.channels.find((c) => c.id === piSettings.defaultChannelId);
    updateSession(session.id, {
      agent,
      agentSessionIds,
      claudeSessionId: agent === "claude" ? undefined : session.claudeSessionId,
      piChannelId: agent === "pi" ? piSettings.defaultChannelId : undefined,
      model:
        agent === "pi"
          ? piSettings.defaultModel ?? piDefaultChannel?.models[0]?.id
          : DEFAULT_MODEL[agent],
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
              {realProject ? `${project.name} · ${project.path}` : project.name}
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
            {(Object.keys(AGENT_MODELS) as AgentKind[]).map((a) => {
              // pi 是内置兜底,永不禁用;其余 agent 未探测到安装时禁用并标注。
              const unavailable = a !== "pi" && agentsAvailable?.[a] === false;
              return (
                <option key={a} value={a} disabled={unavailable}>
                  {AGENT_LABEL[a]}
                  {unavailable ? "（未安装）" : ""}
                </option>
              );
            })}
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
        renderTextTail={(m) => {
          if (typeof m.text !== "string") return null;
          if (m.who === "me") {
            // 用户消息:可编辑重发(运行中先停止;无 uid 的极老消息不支持)。
            if (running || !m.uid) return null;
            const msgUid = m.uid;
            const msgText = m.text;
            return (
              <div className="m-tts-actions">
                <button
                  type="button"
                  title="编辑这条消息并重新发送(将清除其后的所有消息)"
                  onClick={() => setEditing({ uid: msgUid, text: msgText })}
                >
                  <Icon.Edit size={12} />
                  编辑重发
                </button>
              </div>
            );
          }
          return (
            <div className="m-tts-actions">
              <button type="button" onClick={() => void speakText(bridge, ttsSettings, m.text as string)} title="重新朗读这条回复">
                <Icon.Run size={12} />
                重听
              </button>
              <button type="button" disabled={!ttsPlayback.isSpeaking} onClick={stopSpeaking} title="停止当前朗读">
                <Icon.Stop size={12} />
                停止
              </button>
            </div>
          );
        }}
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

      <GitBar
        project={realProject}
        projectValue={session.projectId}
        running={running}
        onSend={(text) => void send(session, project.path, text, [])}
        onToast={onToast}
      />

      <PersonalComposer
        session={session}
        running={running}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onSend={(text, attachments) => {
          // 编辑重发:截断目标消息及其后内容,按新文本重发。
          if (editing) {
            const uid = editing.uid;
            setEditing(null);
            void editResend(session, project.path, uid, text, attachments);
            return;
          }
          // slash 命令:/clear 默认隐藏当前历史(磁盘历史保留,重启仍隐藏)。
          if (text.trim() === "/clear") {
            clearView(session.id);
            setShowHiddenHistory(false);
            onToast("已隐藏当前历史 · 可随时展开查看");
            return;
          }
          void send(session, project.path, text, attachments);
        }}
        onStop={() => void stopRun(session.id)}
        onChangeModel={(model) => updateSession(session.id, { model })}
        onChangePiModel={(channelId, model) => updateSession(session.id, { piChannelId: channelId, model })}
        onToggleSkills={() => updateSession(session.id, { useOwnSkills: session.useOwnSkills !== true })}
        onToast={onToast}
      />
    </main>
  );
}
