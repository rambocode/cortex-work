// 个人工作区中间内容区：session 头部（agent/项目信息）+ 消息流（复用团队侧
// MessageStream 渲染管线）+ PersonalComposer。消息数据来自 personal query cache。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  defaultAgent,
  getTtsPlaybackState,
  resolveProjectFileRef,
  speakText,
  stopSpeaking,
  subscribeTtsPlayback,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalActions,
  usePersonalChat,
  usePersonalStore,
  useRenderWindow,
} from "@cortex-work/core";
import type { AgentKind, ProjectMeta, SessionMeta } from "@cortex-work/core";
import type { Contact, Conversation, Message } from "@cortex-work/core/types";
import { MessageStream } from "../ChatArea";
import { AskQuestionCard } from "./AskQuestionCard";
import { GitBar } from "./GitBar";
import { PersonalComposer } from "./PersonalComposer";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

// 稳定 noop：个人工作区无审批流,onApprove 传它而非每渲染新建的箭头函数(保 ApproveMessage memo)。
const NOOP_APPROVE = (_uid: string, _decision: "approve" | "reject") => {};

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

// 「展开更多」入口:历史会话默认折叠更早消息,点击逐步多渲染一页(复用 .pw-history-gate 视觉)。
function MoreHistoryGate({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <div className="pw-history-gate">
      <div className="pw-history-gate-line" />
      <button className="pw-history-gate-btn" onClick={onExpand} type="button">
        <Icon.Chevron size={11} />
        <span>还有 {count} 条更早消息</span>
        <b>展开更多</b>
      </button>
      <div className="pw-history-gate-line" />
    </div>
  );
}

export function PersonalChatArea({
  onToast,
  onOpenFlashNote,
}: {
  onToast: (text: string) => void;
  // 闪记浮层入口(壳注入,透传给 composer 图标;web/旧壳缺省 → 隐藏)。
  onOpenFlashNote?: () => void;
}) {
  const projects = usePersonalStore((s) => s.projects);
  const sessions = usePersonalStore((s) => s.sessions);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const createSession = usePersonalStore((s) => s.createSession);
  const runningBySession = usePersonalStore((s) => s.runningBySession);
  const piRuntimeBySession = usePersonalStore((s) => s.piRuntimeBySession);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const ttsSettings = usePersonalStore((s) => s.ttsSettings);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const requestFilePreview = usePersonalStore((s) => s.requestFilePreview);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
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
  const { send, stop: stopRun, steer, setPiModel, setPiThinking, editResend, clearView } = usePersonalActions();
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
  // 渲染窗口:历史会话默认只渲染最新 20 条,「展开更多」逐步加载更早的。窗口作用在 messages
  //(即 /clear 后的可见集)之上;resetKey 含 hiddenHistory 游标,切会话 / /clear 后窗口重置。
  const resetKey = `${session?.id ?? ""}:${session?.hiddenHistory?.count ?? 0}:${session?.hiddenHistory?.hiddenAt ?? 0}`;
  const win = useRenderWindow(resetKey, messages);
  // 用户主动「显示隐藏历史」(showHiddenHistory,仅 /clear 过的会话)走全量 allMessages;否则用窗口尾部切片。
  const rendered = showHiddenHistory ? allMessages : win.rendered;
  const convo: Conversation | null = useMemo(
    () =>
      rendered.length > 0 || hiddenCount > 0
        ? { headerStatus: { dot: "online", text: "" }, metaRow: [], messages: rendered }
        : null,
    [rendered, hiddenCount],
  );

  // 下面的回调用 useCallback 稳定引用,使 ChatArea 的消息组件 React.memo 在流式逐字更新时
  // 只重渲染正在输出的那一条(否则父级每渲染新建的回调会让全部消息行 memo 失效)。须在任何
  // 早退之前调用(hooks 规则);session/project 可空时回调内部短路(此时消息流根本不渲染)。
  const running = session ? !!runningBySession[session.id] : false;

  // 消息里文件路径(及 diff 卡片文件行)点击 → 解析为绝对路径,请求右栏预览并展开右栏。
  // 无项目会话(无 realProject)与解析爬出项目(within=false)一律短路,不派发。
  const handleOpenFile = useCallback(
    (ref: string) => {
      if (!realProject) return;
      const openPreview = (abs: string) => {
        const name = abs.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ref;
        requestFilePreview({ projectId: realProject.id, path: abs, name });
        setRightOpen(true);
      };
      const probe = bridge?.resolveProjectFile;
      if (!probe) {
        const { abs, within } = resolveProjectFileRef(realProject.path, ref);
        if (within) openPreview(abs);
        return;
      }
      void probe(realProject.path, ref).then((abs) => {
        if (abs) openPreview(abs);
        else onToast(`未找到文件：${ref}`);
      });
    },
    [realProject, bridge, requestFilePreview, setRightOpen, onToast],
  );

  // 消息底部行:时间常驻(撑起固定高度,避免悬停露出图标时抖动)+ 悬停淡入的操作。
  const renderTextTail = useCallback(
    (m: Extract<Message, { kind: "text" }>) => {
      if (typeof m.text !== "string" || !session || !project) return null;
      const msgText = m.text;
      if (m.who === "me") {
        // 用户消息:重发 / 编辑重发 / 复制。运行中或无 uid(极老消息)时只显示时间。
        const editable = !running && !!m.uid;
        const msgUid = m.uid;
        return (
          <div className="m-msg-actions">
            <span className="m-msg-time">{m.time}</span>
            {editable && msgUid ? (
              <div className="m-act-row">
                <button
                  type="button"
                  className="m-act-btn"
                  title="按原文重新发送(将清除其后的所有消息)"
                  onClick={() => void editResend(session, project.path, msgUid, msgText, [])}
                >
                  <Icon.Retry size={15} />
                </button>
                <button
                  type="button"
                  className="m-act-btn"
                  title="编辑后重新发送(将清除其后的所有消息)"
                  onClick={() => setEditing({ uid: msgUid, text: msgText })}
                >
                  <Icon.Edit size={15} />
                </button>
                <button
                  type="button"
                  className="m-act-btn"
                  title="复制消息内容"
                  onClick={() => {
                    void navigator.clipboard.writeText(msgText);
                    onToast("已复制");
                  }}
                >
                  <Icon.Copy size={15} />
                </button>
              </div>
            ) : null}
          </div>
        );
      }
      // agent 回复:复制 +(仅在开启「实时朗读」时)朗读开关。正在朗读时常驻显示便于停止。
      const speaking = ttsPlayback.isSpeaking;
      return (
        <div className="m-msg-actions">
          <span className="m-msg-time">{m.time}</span>
          <div className={`m-act-row ${speaking ? "is-active" : ""}`}>
            <button
              type="button"
              className="m-act-btn"
              title="复制回复内容"
              onClick={() => {
                void navigator.clipboard.writeText(msgText);
                onToast("已复制");
              }}
            >
              <Icon.Copy size={15} />
            </button>
            {ttsSettings.autoSpeak ? (
              <button
                type="button"
                className="m-act-btn"
                title={speaking ? "停止朗读" : "朗读这条回复"}
                onClick={() => (speaking ? stopSpeaking() : void speakText(bridge, ttsSettings, msgText))}
              >
                {speaking ? <Icon.Stop size={15} /> : <Icon.Run size={15} />}
              </button>
            ) : null}
          </div>
        </div>
      );
    },
    [session, project, running, editResend, ttsPlayback.isSpeaking, ttsSettings, bridge, onToast],
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

  // pi RPC 会话运行时状态（压缩/重试/待注入队列/思考强度）;非 pi 会话恒 undefined。
  const piRuntime = session.agent === "pi" ? piRuntimeBySession[session.id] : undefined;

  const switchAgent = (agent: AgentKind) => {
    const agentSessionIds = { ...session.agentSessionIds };
    delete agentSessionIds[agent];
    // pi:用默认 provider + 默认模型（或 provider 首模型）;其余 agent 用各自默认模型。
    const piDefaultProvider = providerSettings.providers.find((p) => p.id === providerSettings.defaultProviderId);
    updateSession(session.id, {
      agent,
      agentSessionIds,
      claudeSessionId: agent === "claude" ? undefined : session.claudeSessionId,
      providerId: agent === "pi" ? providerSettings.defaultProviderId : undefined,
      model:
        agent === "pi"
          ? providerSettings.defaultModel ?? piDefaultProvider?.models[0]?.id
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
            <span className="ch-title-text">{session.title}</span>
            <span className="agent-tag">{AGENT_LABEL[session.agent]}</span>
          </div>
          <div className="ch-status">
            <span className="dot" style={{ background: running ? "var(--amber)" : "var(--green)" }} />
            <span className="pw-head-path" title={project.path}>
              {realProject ? `${project.name} · ${project.path}` : project.name}
            </span>
            {piRuntime?.compacting ? <span className="pw-pi-chip">压缩上下文…</span> : null}
            {piRuntime?.retry ? (
              <span className="pw-pi-chip pw-pi-warn">
                重试中 {piRuntime.retry.attempt}
                {piRuntime.retry.max ? `/${piRuntime.retry.max}` : ""}
              </span>
            ) : null}
            {piRuntime?.steering ? <span className="pw-pi-chip">{piRuntime.steering} 条待注入</span> : null}
            {piRuntime?.thinkingLevel ? (
              <span className="pw-pi-chip">思考 {piRuntime.thinkingLevel}</span>
            ) : null}
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
        key={session.id}
        contact={contact}
        convo={convo}
        onSelectFile={handleOpenFile}
        activeFile=""
        onApprove={NOOP_APPROVE}
        markdownBodies
        collapsibleLogs
        collapsibleReasoning
        hideTextTime
        onOpenFile={handleOpenFile}
        projectPath={realProject ? realProject.path : undefined}
        renderTextTail={renderTextTail}
        stickToBottomKey={showHiddenHistory ? `all:${allMessages.length}` : win.stickKey}
        preserveAnchorKey={win.expandNonce}
        leadingContent={
          showHiddenHistory ? (
            <HiddenHistoryGate count={hiddenCount} expanded onToggle={() => setShowHiddenHistory(false)} />
          ) : win.canExpandMore ? (
            <MoreHistoryGate count={win.collapsedEarlier} onExpand={win.expandMore} />
          ) : hiddenCount > 0 ? (
            <HiddenHistoryGate count={hiddenCount} expanded={false} onToggle={() => setShowHiddenHistory(true)} />
          ) : undefined
        }
      />

      {/* askquestion 富卡片:渲染在消息流与输入框之间(输入框正上方,KTD-3)。 */}
      <AskQuestionCard sessionId={session.id} />

      <PersonalComposer
        session={session}
        running={running}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onSend={(text, attachments, images) => {
          // 编辑重发:截断目标消息及其后内容,按新文本重发(复用原消息已落盘图,见 editResend)。
          // 本期编辑态不增删图,composer 的待发 images 忽略;返回 true 让 composer 清空。
          if (editing) {
            const uid = editing.uid;
            setEditing(null);
            void editResend(session, project.path, uid, text, attachments);
            return true;
          }
          // slash 命令:/clear 默认隐藏当前历史(磁盘历史保留,重启仍隐藏)。
          // 返回 false → 不消费待发图(AE11:/clear 不清待发图)。
          if (text.trim() === "/clear") {
            clearView(session.id);
            setShowHiddenHistory(false);
            onToast("已隐藏当前历史 · 可随时展开查看");
            return false;
          }
          return send(session, project.path, text, attachments, undefined, images);
        }}
        onStop={() => void stopRun(session.id)}
        onSteer={session.agent === "pi" ? (text) => void steer(session.id, text) : undefined}
        onChangeModel={(model) => updateSession(session.id, { model })}
        onChangePiModel={(providerId, model) => setPiModel(session, providerId, model)}
        onChangePiThinking={(level) => setPiThinking(session, level)}
        onToggleSkills={() => updateSession(session.id, { useOwnSkills: session.useOwnSkills !== true })}
        onOpenFlashNote={onOpenFlashNote}
        onToast={onToast}
      />

      <GitBar
        project={realProject}
        projectValue={session.projectId}
        running={running}
        onSend={(text) => void send(session, project.path, text, [])}
        onToast={onToast}
      />
    </main>
  );
}
