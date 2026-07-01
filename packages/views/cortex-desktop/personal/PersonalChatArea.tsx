// 个人工作区中间内容区：session 头部（agent/项目信息）+ 消息流（复用团队侧
// MessageStream 渲染管线）+ PersonalComposer。消息数据来自 personal query cache。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  resolveDefaultAgent,
  getTtsPlaybackState,
  parseSkillSlash,
  renderClaudeSkillSlash,
  renderSkillInvocation,
  resolveEnabledSkillRecords,
  resolveProjectFileRef,
  speakText,
  stopSpeaking,
  subscribeTtsPlayback,
  toAdapterPermissions,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalActions,
  usePersonalChat,
  usePersonalStore,
  useRenderWindow,
} from "@cortex-work/core";
import type { AgentKind, FollowupSessionCtx, InjectableSkill, ProjectMeta, SessionMeta } from "@cortex-work/core";
import type { Conversation, Message } from "@cortex-work/core/types";
import { extractLatestTurnAutoOpenDevPreviewUrls } from "@cortex-work/core/personal/devPreviewDetection";
import { parseMentions } from "@cortex-work/core/personal/mention";
import { MessageStream } from "../ChatArea";
import { agentContact } from "./agentMeta";
import { isOpenExternalLike } from "./fileIcons";
import { resolveExistingFile } from "./resolveFileRef";
import { AskQuestionCard } from "./AskQuestionCard";
import { FollowupOverlay } from "./FollowupOverlay";
import { GitBar } from "./GitBar";
import { ModeBlockBanner } from "./ModeBlockBanner";
import { PersonalComposer } from "./PersonalComposer";

// 稳定 noop：个人工作区无审批流,onApprove 传它而非每渲染新建的箭头函数(保 ApproveMessage memo)。
const NOOP_APPROVE = (_uid: string, _decision: "approve" | "reject") => {};

// U6:发送侧 /skill:name 派发结果。outText 是最终发给 send() 的文本;invokedSkill 仅 codex 单发
// 原生触发时非空(随请求落到 CliStartRequest.invokedSkill,主进程按 transport 决定 ws/exec)。
interface SkillDispatch {
  outText: string;
  invokedSkill?: { name: string; path: string };
}

// U6:复现 messages.ts 的单发/编排路由,判断本轮是否走圆桌编排(bridge.startOrchestration)。
// 条件必须与 messages.ts 完整对齐(subagentOrchestration && startOrchestration && !hasDelegateMentions)——
// 只看 subagentOrchestration 一个字段会把「开了编排 + 本条带 @mention 委派」误判为编排,而 messages.ts
// 实际把它路由到单发 startCli,导致本该原生调用的组合悄悄退回 prose。
export function isOrchestrationSend(
  subagentOrchestration: boolean | undefined,
  hasStartOrchestration: boolean,
  hasDelegateMentions: boolean,
): boolean {
  return subagentOrchestration === true && hasStartOrchestration && !hasDelegateMentions;
}

// U6:把命中的 /skill:name 按 agent + 路由改写成三路(纯函数,便于单测)。
//  - 圆桌编排(useOrchestration=true):claude/codex 都维持现状 renderSkillInvocation prose——编排
//    路径(startOrchestration)绕开 cli:start,没有原生 skill 挂点(见 U5/U6 编排分支不改动)。
//  - 单发 + claude:转 claude CLI 认得的裸 slash,claude 自身在输入层原生展开(桥接目录见 U1/U2)。
//  - 单发 + codex:文本保留用户 args,并置 invokedSkill 结构化字段;prose 由主进程按 transport 决定
//    (ws 不注入 prose、exec 委派回退才 renderSkillInvocation,见 cli.ts U4)。
//  - 其它(理论不达,pi 已在调用前排除):原样透传,不阻断。
export function resolveSkillDispatch(
  agent: AgentKind,
  originalText: string,
  parsedArgs: string,
  skill: InjectableSkill,
  useOrchestration: boolean,
): SkillDispatch {
  if (useOrchestration) return { outText: renderSkillInvocation(skill, parsedArgs) };
  if (agent === "claude") return { outText: renderClaudeSkillSlash(skill, parsedArgs) };
  if (agent === "codex") return { outText: parsedArgs, invokedSkill: { name: skill.name, path: skill.dir } };
  return { outText: originalText };
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

function richLength(text: Extract<Message, { kind: "text" }>["text"]): number {
  if (typeof text === "string") return text.length;
  return text.parts.reduce((n, p) => n + p.v.length, 0);
}

function messageScrollSignature(messages: Message[]): string {
  const tail = messages[messages.length - 1];
  if (!tail) return "empty";
  if (tail.kind === "text") return `text:${tail.uid ?? ""}:${richLength(tail.text)}`;
  if (tail.kind === "typing") return `typing:${tail.uid ?? ""}:${tail.text.length}`;
  if (tail.kind === "reasoning") return `reasoning:${tail.uid ?? ""}:${richLength(tail.text)}:${tail.active ? 1 : 0}`;
  if (tail.kind === "agentLog") {
    const last = tail.items[tail.items.length - 1];
    return `agentLog:${tail.uid ?? ""}:${tail.items.length}:${last?.ic ?? ""}:${last ? richLength(last.text) : 0}:${tail.active ? 1 : 0}`;
  }
  return `${tail.kind}:${tail.uid ?? messages.length}`;
}

export function PersonalChatArea({
  onToast,
}: {
  onToast: (text: string) => void;
}) {
  const projects = usePersonalStore((s) => s.projects);
  const sessions = usePersonalStore((s) => s.sessions);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const createSession = usePersonalStore((s) => s.createSession);
  const runningBySession = usePersonalStore((s) => s.runningBySession);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const ttsSettings = usePersonalStore((s) => s.ttsSettings);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const requestFilePreview = usePersonalStore((s) => s.requestFilePreview);
  const requestBrowserUrl = usePersonalStore((s) => s.requestBrowserUrl);
  const autoOpenedPreviewKeys = usePersonalStore((s) => s.autoOpenedPreviewKeys);
  const markAutoOpenedPreview = usePersonalStore((s) => s.markAutoOpenedPreview);
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
  const { send, stop: stopRun, steer, compact, setPiModel, setThinking, editResend, clearView } =
    usePersonalActions();

  // auto_open(仅环回,SSRF 收紧):**只信主信号**(最近一轮 assistant 正文)。process 流
  // (agentLog)无 user 消息、无法按轮次切片,从后往前扫可能取到上一轮旧 URL → 误自动打开。
  const autoOpenPreviewUrl = useMemo(
    () => extractLatestTurnAutoOpenDevPreviewUrls(allMessages)[0] ?? null,
    [allMessages],
  );

  const openPreview = useCallback(
    (url: string) => {
      // auto_open 均为环回 URL,受「本地 URL 打开目标」偏好控制(plan U3 / R7):
      // system 且 bridge 可用 → 系统浏览器;否则内置面板。
      const target = usePersonalStore.getState().generalSettings.browserControl?.localUrlOpenTarget ?? "internal";
      if (target === "system" && bridge?.openExternal) {
        void bridge.openExternal(url).catch(() => {});
        return;
      }
      requestBrowserUrl(url);
      setRightOpen(true);
    },
    [requestBrowserUrl, setRightOpen, bridge],
  );

  // auto_open:输出明确像 dev server 且为环回时自动打开内嵌浏览器,按「会话:URL」去重,
  // 防重渲染反复弹(计划 U5)。
  useEffect(() => {
    if (!autoOpenPreviewUrl || !session) return;
    const key = `${session.id}:${autoOpenPreviewUrl}`;
    if (autoOpenedPreviewKeys.includes(key)) return;
    markAutoOpenedPreview(key);
    openPreview(autoOpenPreviewUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenPreviewUrl, session?.id, autoOpenedPreviewKeys]);
  const [showHiddenHistory, setShowHiddenHistory] = useState(false);
  const [ttsPlayback, setTtsPlayback] = useState(getTtsPlaybackState);
  // 编辑重发:正在编辑的历史用户消息(原文填入 composer,发送时截断其后所有消息)。
  const [editing, setEditing] = useState<{ uid: string; text: string } | null>(null);
  // 追问浮层(U5):以某条 assistant 正文为种子的临时多轮问答,关闭即弃。单实例;
  // returnFocusEl 记录触发按钮,关闭后焦点归还(无障碍)。
  const [followup, setFollowup] = useState<{ seedText: string; returnFocusEl?: HTMLElement | null } | null>(null);

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
  const scrollStickKey = showHiddenHistory
    ? `all:${messageScrollSignature(allMessages)}`
    : `${win.stickKey}:${messageScrollSignature(rendered)}`;
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

  // 消息里文件路径(及 diff 卡片文件行)点击 → 解析为「真实存在的绝对路径」(口径见
  // resolveExistingFile:绝对路径走 fileExists、相对走 resolveProjectFile→拼 abs+fileExists,
  // 覆盖项目外 agent 产物如 ~/.codex/generated_images 与 `../outputs` 爬出),按文件类型分发:
  // - 非文本(图片/媒体/office/pdf/二进制)→ 系统默认应用打开,不依赖项目上下文;
  // - 文本类 → 右栏内置预览并展开右栏(需项目);无项目会话退化为系统打开。
  const handleOpenFile = useCallback(
    (ref: string) => {
      const projectPath = realProject?.path ?? "";
      const openResolved = (abs: string) => {
        const name = abs.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ref;
        // 图片/office/pdf/媒体/二进制 → 系统打开;无项目会话(无右栏预览上下文)亦同。
        if (isOpenExternalLike(name) || !realProject) {
          void bridge?.openPath?.(abs).catch(() => onToast(`打开失败：${name}`));
          return;
        }
        requestFilePreview({ projectId: realProject.id, path: abs, name });
        setRightOpen(true);
      };
      // 无任何探测能力(web/旧壳):沿用原乐观逻辑(仅项目内相对路径,凭 within 放行)。
      if (!bridge?.fileExists && !bridge?.resolveProjectFile) {
        if (!projectPath) return;
        const { abs, within } = resolveProjectFileRef(projectPath, ref);
        if (within) openResolved(abs);
        return;
      }
      void resolveExistingFile(bridge, projectPath, ref).then((abs) => {
        if (abs) openResolved(abs);
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
      // 本地 HTML / dev URL 的预览入口已内联到消息正文里(见 chatMarkdown 的 pre 渲染:代码块
      // 含 .html 路径时正下方给「预览网页」按钮),此处消息底部不再重复。
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
            {/* 追问入口(U5):需桌面端三方法齐备才渲染(FIX-2)——askFollowupStream 发起、
                onAskFollowupEvent 订阅事件、cancelFollowup 取消;任一缺失(Web/旧壳)则降级隐藏,
                避免「按钮可点但事件订阅早退/cancel no-op 留孤儿」(R1)。排在复制/朗读之后,固定次序。 */}
            {bridge?.askFollowupStream && bridge?.onAskFollowupEvent && bridge?.cancelFollowup ? (
              <button
                type="button"
                className="m-act-btn"
                title="追问"
                aria-label="追问"
                onClick={(e) => setFollowup({ seedText: msgText, returnFocusEl: e.currentTarget })}
              >
                <Icon.Reply size={15} />
              </button>
            ) : null}
          </div>
        </div>
      );
    },
    [session, project, running, editResend, ttsPlayback.isSpeaking, ttsSettings, bridge, onToast],
  );

  // 追问浮层的会话上下文(R6:复用当前会话 agent/model/cwd/provider,不新建会话)。
  // cwd 合成口径同上方 syntheticNoProject:realProject.path ?? noProjectDir(空则主进程退 homedir)。
  // provider 仅 pi 自定义供应商需要,解析逻辑照搬 sendPiTurn(messages.ts):
  // session.providerId ?? defaultProviderId → providerSettings.providers 找已启用项 → 拍平字段。
  const followupSessionCtx = useMemo<FollowupSessionCtx | null>(() => {
    if (!session) return null;
    const cwd = realProject?.path ?? session.noProjectDir ?? "";
    let provider: FollowupSessionCtx["provider"];
    if (session.agent === "pi") {
      const p = providerSettings.providers.find(
        (x) => x.id === (session.providerId ?? providerSettings.defaultProviderId) && x.enabled,
      );
      if (p) {
        provider = {
          id: p.id,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          models: p.models.map((m) => ({ id: m.id, name: m.label })),
        };
      }
    }
    // 无真实项目 = 无项目会话 → 收紧 tool(FIX-3,显式标志,主进程据此剥离跳审批/bypass)。
    // 运行模式沿用主会话档位,追问与主会话权限一致(与 tightenTools 叠加,更严者优先)。
    // 执行/目录两轴 → 线格式:followup ctx 是 DTO 载体,派生在此构造处。
    const { permissionMode, approvalPolicy } = toAdapterPermissions(session.execPermission, session.dirPermission);
    return {
      agent: session.agent,
      model: session.model,
      effort: session.effort,
      cwd,
      permissionMode,
      approvalPolicy,
      tightenTools: !realProject,
      provider,
    };
    // 用 session 的细粒度字段做依赖(而非整对象),保引用稳定避免无谓重渲染(同 syntheticNoProject)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    session?.id,
    session?.agent,
    session?.model,
    session?.effort,
    session?.providerId,
    session?.execPermission,
    session?.dirPermission,
    session?.noProjectDir,
    realProject?.path,
    realProject,
    providerSettings,
  ]);

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
                // 按设置里的全局默认 agent 起草(resolveDefaultAgent),而非仅按安装情况派生。
                createSession(activeProject.id, resolveDefaultAgent({ generalSettings, agentsAvailable }));
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

  // 会话标题 / agent 标签 / 项目路径 / agent 切换已上移到中栏顶栏（见 PersonalSessionHeader），
  // 会话区不再渲染 chat-head，直接以消息流开头。
  return (
    <main className="chat">
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
        stickToBottomKey={scrollStickKey}
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

      {/* 运行模式拦截提示:plan/accept-edits 下 agent 被拦时,提示切档并自动重发本轮。 */}
      <ModeBlockBanner session={session} projectPath={project.path} />

      <PersonalComposer
        session={session}
        running={running}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onSend={async (text, attachments, images, docFiles) => {
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
          // /compact（仅 pi）:手动压缩上下文。反馈走 compact action（压缩中 chip + 完成/失败消息）,
          // 不作为消息发给 agent。返回 false → 不消费待发图。
          if (session.agent === "pi" && text.trim() === "/compact") {
            void compact(session.id);
            return false;
          }
          // /skill:name 派发(U6):按 agent + 路由三路分支。pi 透传(pi CLI 自行展开);claude 单发转
          // 裸 slash(claude 原生展开,桥接目录见 U1/U2);codex 单发置 invokedSkill 结构化字段(主进程
          // 按 transport 走 ws 原生触发 / exec prose 回退)。圆桌编排路径无原生挂点 → claude/codex 都维持
          // 现状 renderSkillInvocation prose(与 messages.ts 编排分支不改动对齐)。找不到对应 skill
          //(未启用 / 不适用当前 agent / 无桥)时原样发送,不阻断——与菜单侧 supportedAgents 过滤一致。
          let outText = text;
          let invokedSkill: { name: string; path: string } | undefined;
          if (session.agent !== "pi" && bridge) {
            const parsed = parseSkillSlash(text);
            if (parsed) {
              const records = await resolveEnabledSkillRecords(bridge, project.path, session.useOwnSkills, session.agent);
              const skill = records.find((s) => s.name === parsed.name);
              if (skill) {
                // 路由判断须与 messages.ts 完整对齐:@mention 委派时任何 agent 都走单发 startCli,故
                // hasDelegateMentions 参与判断,不能只看 subagentOrchestration。
                const hasDelegateMentions =
                  parseMentions(text, usePersonalStore.getState().roles).length > 0 && !!bridge.startCli;
                const useOrchestration = isOrchestrationSend(
                  session.subagentOrchestration,
                  !!bridge.startOrchestration,
                  hasDelegateMentions,
                );
                const dispatch = resolveSkillDispatch(session.agent, text, parsed.args, skill, useOrchestration);
                outText = dispatch.outText;
                invokedSkill = dispatch.invokedSkill;
              }
            }
          }
          return send(session, project.path, outText, attachments, undefined, images, undefined, docFiles, invokedSkill);
        }}
        onStop={() => void stopRun(session.id)}
        onSteer={session.agent === "pi" ? (text) => void steer(session.id, text) : undefined}
        onChangeModel={(model) => updateSession(session.id, { model })}
        onChangePiModel={(providerId, model) => setPiModel(session, providerId, model)}
        onChangeThinking={(value) => setThinking(session, value)}
        onChangeExecPermission={(p) => updateSession(session.id, { execPermission: p })}
        onChangeDirPermission={(d) => updateSession(session.id, { dirPermission: d })}
        onToggleSubagentOrchestration={() =>
          updateSession(session.id, { subagentOrchestration: session.subagentOrchestration !== true })
        }
        onToggleSkills={() => updateSession(session.id, { useOwnSkills: session.useOwnSkills !== true })}
        onToast={onToast}
      />

      <GitBar
        project={realProject}
        projectValue={session.projectId}
        running={running}
        onSend={(text) => void send(session, project.path, text, [])}
        onToast={onToast}
      />

      {/* 追问浮层(U5):单实例,条件挂载。onClose 关状态 + 焦点归还触发按钮(浮层内部
          已在关闭时 cancel() 清在途子进程)。followupSessionCtx 在此恒非空(session 存在)。 */}
      {followup && followupSessionCtx ? (
        <FollowupOverlay
          seed={{ text: followup.seedText }}
          sessionCtx={followupSessionCtx}
          onClose={() => {
            const el = followup.returnFocusEl;
            setFollowup(null);
            el?.focus();
          }}
        />
      ) : null}
    </main>
  );
}
