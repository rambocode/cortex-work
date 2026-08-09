// 个人工作区中间内容区：session 头部（agent/项目信息）+ 消息流（复用团队侧
// MessageStream 渲染管线）+ PersonalComposer。消息数据来自 personal query cache。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  resolveDefaultAgent,
  getTtsPlaybackState,
  parseSkillSlash,
  resolveEnabledSkillRecords,
  resolveProjectFileRef,
  speakText,
  stopSpeaking,
  subscribeTtsPlayback,
  toAdapterPermissions,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalActions,
  presetSessionTitle,
  stripSkillDirective,
  usePersonalBranches,
  usePersonalChat,
  usePersonalStore,
  useRenderWindow,
  useBranchActions,
  anchorForAgentMessage,
  isLastAgentReplyOfTail,
  pagerPosition,
  GOAL_CONTINUATION_PROMPT,
  goalCanAutoContinue,
  goalStatusFromAssistantText,
  parseGoalCommand,
} from "@cortex-work/core";
import type { FollowupSessionCtx, ProjectMeta, SessionMeta } from "@cortex-work/core";
import type { Conversation, Message } from "@cortex-work/core/types";
import { extractLatestTurnAutoOpenDevPreviewUrls } from "@cortex-work/core/personal/devPreviewDetection";
import { MessageStream } from "../../ChatArea";
import { resolveSkillDispatch } from "../skills/skillDispatch";
import { agentContact } from "./agentMeta";
import { inAppDocumentKind, isOpenExternalLike, isSpreadsheetLike } from "../shared/fileIcons";
import { resolveExistingFile } from "./resolveFileRef";
import { AskQuestionCard } from "./AskQuestionCard";
import { FollowupOverlay } from "./FollowupOverlay";
import { GitBar } from "../files/GitBar";
import { HomeBoard } from "../home/HomeView";
import { ModeBlockBanner } from "./ModeBlockBanner";
import { PersonalComposer } from "./composer/PersonalComposer";
import {
  buildConversationArtifactPrompt,
  conversationArtifacts,
  prepareArtifactDispatch,
  upsertConversationArtifact,
} from "./artifactDispatch";
export { buildConversationArtifactPrompt } from "./artifactDispatch";
import { normalizeResearchEngineSettings } from "@cortex-work/core/research/settings";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import { RESEARCH_STATUS_META } from "../../research/labels";
import {
  parseResearchSkill,
  prepareResearchDispatch,
  upsertConversationResearch,
} from "./researchDispatch";
import { shouldSendPromptToCodeCanvas } from "@cortex-work/core/design/canvas/code-canvas";
import { buildCodeCanvasOutboundText } from "@cortex-work/core/design/canvas/code-canvas-outbound";
import { useCanvasShapeStore } from "@cortex-work/core/design/canvas/canvas-shape-store";
import { useCanvasSelectionStore } from "@cortex-work/core/design/canvas/canvas-selection-store";
import { useCanvasViewportStore } from "@cortex-work/core/design/canvas/canvas-viewport-store";
import { useDesignWorkspaceStore } from "@cortex-work/core/design/design-workspace-store";

// 稳定 noop：个人工作区无审批流,onApprove 传它而非每渲染新建的箭头函数(保 ApproveMessage memo)。
const NOOP_APPROVE = (_uid: string, _decision: "approve" | "reject") => {};

function latestAssistantTurnText(messages: Message[]): string {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "text" && message.who === "me") {
      userIndex = index;
      break;
    }
  }
  return messages
    .slice(userIndex + 1)
    .filter((message) => message.kind === "text" && message.who !== "me" && typeof message.text === "string")
    .map((message) => (message.kind === "text" ? String(message.text) : ""))
    .join("\n");
}

// U6:/skill:name 三路派发已抽到 skillDispatch.ts(写作助手面板复用);此处 re-export 保持
// 既有引用(含单测 import 路径)不变。
export { resolveSkillDispatch };

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
  // todoList 原地覆盖更新(uid 不变):签名纳入条数/完成数/active,更新时仍能驱动自动滚动。
  if (tail.kind === "todoList") {
    const done = tail.todos.filter((it) => it.status === "completed").length;
    return `todoList:${tail.uid ?? ""}:${tail.todos.length}:${done}:${tail.active ? 1 : 0}`;
  }
  return `${tail.kind}:${tail.uid ?? messages.length}`;
}

export function PersonalChatArea({
  sessionId,
  onToast,
}: {
  // 拆分窗格可显式绑定会话；未传时沿用全局活动会话，保持所有既有调用不变。
  sessionId?: string;
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
  const setRightView = usePersonalStore((s) => s.setRightView);
  const rightView = usePersonalStore((s) => s.rightView);
  const setSessionGoal = usePersonalStore((s) => s.setSessionGoal);
  const setSessionGoalStatus = usePersonalStore((s) => s.setSessionGoalStatus);
  const clearSessionGoal = usePersonalStore((s) => s.clearSessionGoal);
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const bridge = useDesktopBridge();

  const resolvedSessionId = sessionId ?? activeSessionId;
  const session: SessionMeta | undefined = sessions.find((x) => x.id === resolvedSessionId);
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
  const {
    send,
    stop: stopRun,
    steer,
    compact,
    setPiModel,
    setThinking,
    editResend,
    clearView,
    appendLocalUserMessage,
  } = usePersonalActions();
  // 研究派发要用的两样：全局默认档（档位 / 来源范围）与研究会话的实时状态（卡片副标题）。
  const researchSettings = normalizeResearchEngineSettings(generalSettings.researchEngine);
  const researchStatuses = useResearchUiStore((s) => s.sessions);
  // 分支回复:刷新=归档旧回复为分支重新生成;回复下方「‹ i/n ›」分页器切换查看/续聊各分支。
  const branchGroups = usePersonalBranches(session?.id);
  const { regenerate, switchBranch } = useBranchActions();
  const goalRunRef = useRef<{ runId: string; startedAt: number } | null>(null);
  const goalContinuationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goalFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  const buildWhiteboardAppend = useCallback(
    async (text: string): Promise<string | undefined> => {
      if (!session || !project?.path) return undefined;
      const whiteboardOpen = rightOpen && rightView === "canvas";
      const selectedIds = useCanvasSelectionStore.getState().selectedIds;
      if (!shouldSendPromptToCodeCanvas({ text, whiteboardOpen, hasSelection: selectedIds.size > 0 })) {
        return undefined;
      }
      setRightView("canvas");
      setRightOpen(true);
      return buildCodeCanvasOutboundText({
        baseText: "",
        canvasBrief: text,
        workspaceRoot: project.path,
        threadId: session.id,
        currentDocument: useCanvasShapeStore.getState().document,
        currentDocumentKey: useCanvasShapeStore.getState().documentKey,
        selectedIds,
        viewBox: useCanvasViewportStore.getState().vbox,
        designContext: useDesignWorkspaceStore.getState().designContext,
      });
    },
    [project?.path, rightOpen, rightView, session, setRightOpen, setRightView],
  );

  const startOrReplaceGoal = useCallback(
    (objective: string) => {
      if (!session || !project) return;
      const goal = setSessionGoal(session.id, objective);
      if (!goal) return;
      // 对齐 Kun：创建/替换目标后立即发起首轮，而不是只挂一个不会执行的 UI 标签。
      void send({ ...session, goal }, project.path, goal.objective, []);
    },
    [project, send, session, setSessionGoal],
  );

  const changeGoalStatus = useCallback(
    (status: "active" | "paused") => {
      if (!session?.goal || !project) return;
      setSessionGoalStatus(session.id, status);
      if (status === "active" && !runningBySession[session.id]) {
        const resumed = { ...session.goal, status: "active" as const, autoTurnCount: 0, updatedAt: new Date().toISOString() };
        // Kun GUI 在 idle resume 后不立即续跑是其已知缺口；Cortex 在这里补齐真实恢复语义。
        void send({ ...session, goal: resumed }, project.path, GOAL_CONTINUATION_PROMPT, []);
      }
    },
    [project, runningBySession, send, session, setSessionGoalStatus],
  );

  useEffect(() => {
    const runId = session ? runningBySession[session.id] : undefined;
    if (runId) {
      if (goalRunRef.current?.runId !== runId) goalRunRef.current = { runId, startedAt: Date.now() };
      return;
    }
    const finished = goalRunRef.current;
    if (!finished || !session?.goal || !project) return;
    goalRunRef.current = null;

    // running store 会先于 80ms 消息渲染节流复位。稍后从 ref 读取最终缓存投影，确保 completion
    // 标记和 turnUsage 已到达；直接用本次 render 的 allMessages 会误判未完成并多开一轮。
    goalFinishTimerRef.current = setTimeout(() => {
      goalFinishTimerRef.current = null;
      const current = usePersonalStore.getState().sessions.find((item) => item.id === session.id);
      const goal = current?.goal;
      if (!goal || goal.status !== "active") return;
      const finalMessages = allMessagesRef.current;
      const terminalStatus = goalStatusFromAssistantText(latestAssistantTurnText(finalMessages));
      const elapsed = Math.max(0, Math.round((Date.now() - finished.startedAt) / 1000));
      const usage = finalMessages.find(
        (message) => message.kind === "turnUsage" && message.runId === finished.runId,
      );
      const tokens = usage?.kind === "turnUsage"
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : 0;
      const accounted = {
        ...goal,
        tokensUsed: goal.tokensUsed + tokens,
        timeUsedSeconds: goal.timeUsedSeconds + elapsed,
        updatedAt: new Date().toISOString(),
      };
      if (terminalStatus) {
        updateSession(session.id, { goal: { ...accounted, status: terminalStatus } });
        return;
      }
      if (accounted.tokenBudget != null && accounted.tokensUsed >= accounted.tokenBudget) {
        updateSession(session.id, { goal: { ...accounted, status: "usageLimited" } });
        return;
      }
      if (!goalCanAutoContinue(accounted)) {
        updateSession(session.id, { goal: { ...accounted, status: "blocked" } });
        return;
      }

      const continuing = { ...accounted, autoTurnCount: (accounted.autoTurnCount ?? 0) + 1 };
      updateSession(session.id, { goal: continuing });
      goalContinuationTimerRef.current = setTimeout(() => {
        goalContinuationTimerRef.current = null;
        const latest = usePersonalStore.getState().sessions.find((item) => item.id === session.id);
        if (latest?.goal?.status !== "active" || usePersonalStore.getState().runningBySession[session.id]) return;
        void send({ ...latest, goal: latest.goal }, project.path, GOAL_CONTINUATION_PROMPT, []);
      }, 2000);
    }, 160);
  }, [project, runningBySession, send, session, updateSession]);

  useEffect(() => () => {
    if (goalContinuationTimerRef.current) clearTimeout(goalContinuationTimerRef.current);
    if (goalFinishTimerRef.current) clearTimeout(goalFinishTimerRef.current);
  }, []);

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
    // 拆分后两条会话都会挂载；只有用户当前聚焦的窗格可自动抢占全局右侧浏览器。
    if (!autoOpenPreviewUrl || !session || session.id !== activeSessionId) return;
    const key = `${session.id}:${autoOpenPreviewUrl}`;
    if (autoOpenedPreviewKeys.includes(key)) return;
    markAutoOpenedPreview(key);
    openPreview(autoOpenPreviewUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenPreviewUrl, session?.id, activeSessionId, autoOpenedPreviewKeys]);
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
  // 会话流里的用户消息只显示内容,不显示 `/skill:<name>` 派发前缀——前缀是派发指令不是内容
  //(与 core 侧 fallbackTitle 剥标题同一口径、同一个 stripSkillDirective)。pi 会话尤其需要:
  // 它把整条命令原样透传给 CLI,存储与发送是同一份文本,不像 claude/codex 在发送侧已改写掉。
  //
  // **只改显示,不动存储**:编辑重发要把原文重新过 prepareArtifactDispatch / parseResearchSkill
  // 才知道派发到哪,剥了原文会让「编辑后重发」静默丢掉 skill。renderTextTail 因此另经
  // rawTextByUid 取原文(见下)。agent 侧文本不碰——它可能正在讲解 `/skill:xxx` 怎么用。
  const displayMessages = useMemo(
    () =>
      rendered.map((m) =>
        m.kind === "text" && m.who === "me" && typeof m.text === "string"
          ? { ...m, text: stripSkillDirective(m.text) }
          : m,
      ),
    [rendered],
  );
  // uid → 原始文本。编辑重发要拿没剥过的原文,而 renderTextTail 收到的是上面剥过的消息。
  const rawTextByUid = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of rendered) {
      if (m.kind === "text" && m.who === "me" && m.uid && typeof m.text === "string") map.set(m.uid, m.text);
    }
    return map;
  }, [rendered]);
  const convo: Conversation | null = useMemo(
    () =>
      displayMessages.length > 0 || hiddenCount > 0
        ? { headerStatus: { dot: "online", text: "" }, metaRow: [], messages: displayMessages }
        : null,
    [displayMessages, hiddenCount],
  );

  // 下面的回调用 useCallback 稳定引用,使 ChatArea 的消息组件 React.memo 在流式逐字更新时
  // 只重渲染正在输出的那一条(否则父级每渲染新建的回调会让全部消息行 memo 失效)。须在任何
  // 早退之前调用(hooks 规则);session/project 可空时回调内部短路(此时消息流根本不渲染)。
  const running = session ? !!runningBySession[session.id] : false;

  // 最后一条用户消息 uid = 「当前轮」的 anchor。renderTextTail 据此判断某条 agent 回复属于
  // 正在输出的这一轮(此时不挂操作条)还是已收尾的历史轮。
  const lastUserMsgUid = useMemo(() => {
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i]!;
      if (m.kind === "text" && m.who === "me") return m.uid;
    }
    return undefined;
  }, [allMessages]);

  // 消息里文件路径(及 diff 卡片文件行)点击 → 解析为「真实存在的绝对路径」(口径见
  // resolveExistingFile:绝对路径走 fileExists、相对走 resolveProjectFile→拼 abs+fileExists,
  // 覆盖项目外 agent 产物如 ~/.codex/generated_images 与 `../outputs` 爬出),按文件类型分发:
  // - HTML → 经主进程授权为 file:// URL 后在右侧内置浏览器打开;
  // - 非文本(图片/媒体/office/pdf/二进制)→ 系统默认应用打开,不依赖项目上下文;
  // - 电子表格(xlsx/csv)→ 右栏内置表格(无项目会话同样走右栏,FilesView 回退 cortex 根);
  // - 文本类(含 markdown)→ 右栏内置预览并展开右栏;无项目会话同走右栏,旧壳退化系统打开。
  const handleOpenFile = useCallback(
    (ref: string) => {
      // 无项目会话也有创建时固定的 noProjectDir(project 为上方 syntheticNoProject);
      // 相对产物链接必须以该真实 cwd 解析,不能只认 realProject。
      const projectPath = project?.path ?? "";
      const openResolved = (abs: string) => {
        const name = abs.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ref;
        // HTML 统一进内置浏览器。browserResolveLocalHtml 会在主进程校验允许根、realpath、扩展名
        // 与真实文件并登记授权；不直接把本地路径塞给 BrowserView。
        if (/\.html?$/i.test(name)) {
          const resolveHtml = bridge?.browserResolveLocalHtml;
          if (!resolveHtml) {
            onToast(`当前环境不支持预览网页：${name}`);
            return;
          }
          void resolveHtml(abs)
            .then((fileUrl) => {
              if (!fileUrl) {
                onToast(`无法预览网页：${name}`);
                return;
              }
              requestBrowserUrl(fileUrl);
              setRightOpen(true);
            })
            .catch(() => onToast(`无法预览网页：${name}`));
          return;
        }
        // DOCX/PDF/PPTX/表格有二进制桥时统一走右栏 FilesView 应用内预览(与中栏并排、顶部对齐):
        // 无项目会话用 __noproject__ 哨兵与 FilesView 的回退项目对上,但回退根依赖
        // documentsCortexRoot 桥——缺失(旧壳)时请求永远不被消费,落到下方系统打开。
        const documentKind = inAppDocumentKind(name);
        const rightFilesReady = !!realProject || !!bridge?.documentsCortexRoot;
        if ((documentKind || isSpreadsheetLike(name)) && bridge?.readFileBinary && rightFilesReady && project) {
          requestFilePreview({ projectId: project.id, path: abs, name });
          setRightOpen(true);
          return;
        }
        // 图片/office/pdf/媒体/二进制(内置编辑器打不开)→ 系统打开;
        // 无项目会话缺 documentsCortexRoot 桥(旧壳,右栏无回退根)时文本也只能系统打开。
        if (isOpenExternalLike(name) || !rightFilesReady || !project) {
          void bridge?.openPath?.(abs).catch(() => onToast(`打开失败：${name}`));
          return;
        }
        // 文本类(含 markdown)→ 右栏内置预览,所有会话统一(无项目会话走 __noproject__ 哨兵)。
        requestFilePreview({ projectId: project.id, path: abs, name });
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
    [project, realProject, bridge, requestBrowserUrl, requestFilePreview, setRightOpen, onToast],
  );

  // typing 打开整轮过程；子代理卡传入 callId 后只打开该次委派的过程，重复调用同一角色也不会串流。
  const handleActivityClick = useCallback((subagent?: { callId: string; label: string }) => {
    if (session) usePersonalStore.getState().requestOpenProcessPanel(session.id, subagent);
  }, [session]);

  // 消息底部行:时间常驻(撑起固定高度,避免悬停露出图标时抖动)+ 悬停淡入的操作。
  const renderTextTail = useCallback(
    (m: Extract<Message, { kind: "text" }>) => {
      if (typeof m.text !== "string" || !session || !project) return null;
      // 编辑重发用**原文**(带 /skill: 前缀),不用气泡上剥过的显示文本:
      // editResend 要把文本重新过派发解析,少了前缀就等于静默取消了这次 skill 调用。
      const msgText = (m.uid ? rawTextByUid.get(m.uid) : undefined) ?? m.text;
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
                  title="重新回答(当前回复保留为分支,可在回复下方切换查看)"
                  onClick={() => void regenerate(session, project.path, msgUid)}
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
      //
      // 操作条只挂「每轮完整输出的最后一条 agent 文本」:一轮 run 因「文本→工具→文本」交错会产出
      // 多条 kind:"text" 消息(见 core/personal/messages.ts 的 foldCliEvent),逐条挂会把会话流
      // 切成一段段带按钮的碎片;用户要复制/朗读/追问的也是本轮的最终结论,它落在末段。
      if (!m.uid || !isLastAgentReplyOfTail(allMessages, m.uid)) return null;
      const anchorUid = anchorForAgentMessage(allMessages, m.uid);
      // 正在输出的当前轮同样不挂:此刻的「末条」随时会被下一段正文顶掉(按钮闪烁),复制/追问
      // 拿到的还是半截正文。run 结束时 finalizeRun 清 runningBySession → running 翻 false →
      // 这里放行,操作条自然出现,无需额外信号。
      if (running && anchorUid === lastUserMsgUid) return null;
      const speaking = ttsPlayback.isSpeaking;
      // 分支分页器:该回复归属的用户消息(anchor)有多份分支回复时,常驻「‹ i/n ›」切换器
      //(不随 hover 淡入——用户需要一眼看到存在多版本)。上面的末条门控已保证一轮只渲染一处,
      // 无需再判「是否 tail 首条」。
      const branchGroup = anchorUid
        ? branchGroups.find((g) => g.anchorUid === anchorUid && g.variants.length > 1)
        : undefined;
      const showPager = !!branchGroup;
      const pager = branchGroup ? pagerPosition(branchGroup) : null;
      const switchTo = (offset: number) => {
        if (!branchGroup || !pager || !anchorUid) return;
        const target = branchGroup.variants[pager.index - 1 + offset];
        if (!target) return;
        void switchBranch(session, project.path, anchorUid, target.id).then((r) => {
          if (r === "degraded") onToast("该分支的会话记忆不完整,续聊时上下文可能缺失");
        });
      };
      // 本地 HTML / dev URL 的预览入口已内联到消息正文里(见 chatMarkdown 的 pre 渲染:代码块
      // 含 .html 路径时正下方给「预览网页」按钮),此处消息底部不再重复。
      return (
        <div className="m-msg-actions">
          <span className="m-msg-time">{m.time}</span>
          {showPager && pager ? (
            <span className="m-branch-pager" title="切换查看不同的回复分支">
              <button
                type="button"
                className="m-branch-pager-btn"
                aria-label="上一个回复分支"
                disabled={running || pager.index <= 1}
                onClick={() => switchTo(-1)}
              >
                ‹
              </button>
              <span className="m-branch-pager-num">
                {pager.index}/{pager.total}
              </span>
              <button
                type="button"
                className="m-branch-pager-btn"
                aria-label="下一个回复分支"
                disabled={running || pager.index >= pager.total}
                onClick={() => switchTo(1)}
              >
                ›
              </button>
            </span>
          ) : null}
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
                onClick={() => (speaking ? stopSpeaking() : void speakText(bridge, ttsSettings, msgText, { allowFallback: true }))}
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
    [session, project, running, lastUserMsgUid, regenerate, switchBranch, branchGroups, allMessages, ttsPlayback.isSpeaking, ttsSettings, bridge, onToast],
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
    // 执行权限 → 线格式:followup ctx 是 DTO 载体,派生在此构造处。
    const { permissionMode, approvalPolicy } = toAdapterPermissions(session.execPermission);
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
  // 空会话 = 新会话落地态:挂 pw-landing 让 Hero/chips/输入框共用同一封顶居中列,
  // 与 NewSessionLanding 视觉一致;一旦有消息就回到普通会话布局。
  const landing = convo === null;
  // pw-personal-chat:个人会话作用域类——CSS 据此隐藏消息头里的发送者名(悬停头像见名),
  // 团队会话(同用 MessageStream)不受影响。
  return (
    <main className={landing ? "chat pw-landing pw-personal-chat" : "chat pw-personal-chat"}>
      {/* 会话还没有任何消息时,中栏就是「新会话落地页」——渲染与 NewSessionLanding 同一份
          HomeBoard(Hero + 场景 tab/chips),两处不再各写一套内容。区别只在于:落地页底部
          还要选项目,这里项目已经由会话定死,GitBar 只读展示。 */}
      {landing ? (
        <div className="pw-landing-board">
          <HomeBoard />
        </div>
      ) : (
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
        // 相对文件链接按 agent 的真实 cwd 解析:项目会话用项目 path,无项目会话用 noProjectDir。
        projectPath={project.path}
        renderTextTail={renderTextTail}
        stickToBottomKey={scrollStickKey}
        preserveAnchorKey={win.expandNonce}
        onActivityClick={handleActivityClick}
        sessionId={session.id}
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
      )}

      {/* askquestion 富卡片:渲染在消息流与输入框之间(输入框正上方,KTD-3)。 */}
      {conversationArtifacts(session).map((artifact) => (
        <button
          key={`${artifact.workspaceRoot}:${artifact.documentId}`}
          type="button"
          className="pw-artifact-card"
          onClick={() => {
            updateSession(session.id, { activeArtifact: artifact });
            setRightView("artifact");
            setRightOpen(true);
          }}
        >
          <Icon.Sparkle size={15} />
          <span>
            <strong>{artifact.title}</strong>
            <small>{artifact.kind === "slides" ? "演示文稿" : "设计稿"} · 点击继续编辑</small>
          </span>
          <Icon.ChevronRight size={14} />
        </button>
      ))}

      {/* 研究卡片:形状照产物卡片。**状态不存在卡片自己身上**——按 sessionId 现查 ui-store,
          那份状态由常驻的事件订阅(useResearchLiveSync)维护,是唯一真源;卡片存一份副本
          就会出现「会话流里显示检索中、右栏已经完成」这种对不上的状态。 */}
      {(session.researchSessions ?? []).map((research) => {
        const status = researchStatuses.find((s) => s.sessionId === research.sessionId)?.status;
        return (
          <button
            key={research.sessionId}
            type="button"
            className="pw-artifact-card"
            onClick={() => {
              updateSession(session.id, { activeResearchSessionId: research.sessionId });
              setRightView("research");
              setRightOpen(true);
            }}
          >
            <Icon.Search size={15} />
            <span>
              <strong>{research.objective}</strong>
              <small>
                深度研究 · {status ? RESEARCH_STATUS_META[status].label : "读取中"} · 点击查看
              </small>
            </span>
            <Icon.ChevronRight size={14} />
          </button>
        );
      })}

      <AskQuestionCard sessionId={session.id} />

      {/* 运行模式拦截提示:plan/accept-edits 下 agent 被拦时,提示切档并自动重发本轮。 */}
      <ModeBlockBanner session={session} projectPath={project.path} />

      <PersonalComposer
        session={session}
        running={running}
        acceptComposerInsert={session.id === activeSessionId}
        className={landing ? "pw-landing-composer" : undefined}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onSend={async (text, attachments, images, docFiles) => {
          const goalCommand = parseGoalCommand(text);
          if (goalCommand) {
            if (goalCommand.action === "set") startOrReplaceGoal(goalCommand.objective);
            else if (goalCommand.action === "pause") changeGoalStatus("paused");
            else if (goalCommand.action === "resume") changeGoalStatus("active");
            else if (goalCommand.action === "clear") clearSessionGoal(session.id);
            // `/goal` 本身由 ComposerShell 切入目标输入态；即便经其它入口到这里，也不能作为
            // 普通消息发给 agent。控制命令不消费附件，返回 false 保留待发文件。
            return false;
          }
          // 编辑重发:截断目标消息及其后内容,按新文本重发(复用原消息已落盘图,见 editResend)。
          // 本期编辑态不增删图,composer 的待发 images 忽略;返回 true 让 composer 清空。
          if (editing) {
            if (!bridge) return false;
            // 研究消息不支持编辑重发:editResend 的语义是「截断到这条、以新文本重跑一轮 agent」，
            // 而研究那条消息背后没有 agent 轮次可截断,重跑要走引擎自己的 rerun(克隆会话,
            // 保住旧报告引用的证据)。放行只会得到一轮空转。
            if (parseResearchSkill(text)) {
              onToast("研究消息不支持编辑重发，重跑请用面板的重跑按钮");
              return false;
            }
            const uid = editing.uid;
            const artifactDispatch = await prepareArtifactDispatch(bridge, session, text);
            if (artifactDispatch.error) {
              onToast(artifactDispatch.error);
              return false;
            }
            const artifact = artifactDispatch.artifact;
            if (artifactDispatch.handledSkill) {
              if (artifactDispatch.created && artifact) {
                updateSession(session.id, {
                  activeArtifact: artifact,
                  artifacts: upsertConversationArtifact(session.artifacts, artifact),
                });
              }
              setRightView("artifact");
              setRightOpen(true);
            }
            setEditing(null);
            void editResend(
              session,
              project.path,
              uid,
              artifactDispatch.outText,
              attachments,
              {
                ...(artifact ? { extraSystemPrompt: buildConversationArtifactPrompt(artifact), artifact } : {}),
                ...(artifactDispatch.invokedSkill ? { invokedSkill: artifactDispatch.invokedSkill } : {}),
              },
            );
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
          if (!bridge) return false;
          // /skill:name 派发(U6):按 agent + 路由三路分支。pi 透传(pi CLI 自行展开);claude 单发转
          // 裸 slash(claude 原生展开,桥接目录见 U1/U2);codex 单发置 invokedSkill 结构化字段(主进程
          // 按 transport 走 ws 原生触发 / exec prose 回退)。圆桌编排路径无原生挂点 → claude/codex 都维持
          // 现状 renderSkillInvocation prose(与 messages.ts 编排分支不改动对齐)。找不到对应 skill
          //(未启用 / 不适用当前 agent / 无桥)时原样发送,不阻断——与菜单侧 supportedAgents 过滤一致。
          // 深度研究分叉:必须在产物派发**之前**。研究不经 agent(活由 CRE 引擎干),
          // 这条路径不产生 agent 轮次,也就没有可以喂给 prepareArtifactDispatch 的 outText。
          //
          // 先同步 parse 再决定要不要 await:普通消息占绝大多数,不该为这条分叉多等一个微任务
          //(发送路径的时序被既有测试与 composer 的乐观清空依赖着)。
          if (parseResearchSkill(text)) {
            const researchDispatch = await prepareResearchDispatch(bridge, session, text, researchSettings);
            if (researchDispatch.error) {
              onToast(researchDispatch.error);
              return false; // 未消费:目标写错了,输入框里的文本要留着让用户改
            }
            const ref = researchDispatch.ref!;
            updateSession(session.id, {
              researchSessions: upsertConversationResearch(session.researchSessions, ref),
              activeResearchSessionId: ref.sessionId,
            });
            setRightView("research");
            setRightOpen(true);
            // 会话流里留一条本地用户消息:研究本身不产生 agent 轮次,没有这一条的话
            // 用户回头翻会话只能看到一张卡片,记不起当时问的是什么。
            // 存 objective 而非原始 text:/skill:research 前缀是派发指令不是内容,
            // 显示出来是噪音,还会经 applyFallbackTitle 污染会话标题(用户反馈)。
            await appendLocalUserMessage(session, ref.objective);
            return true;
          }
          let outText = text;
          let invokedSkill: { name: string; path: string } | undefined;
          const artifactDispatch = await prepareArtifactDispatch(bridge, session, text);
          if (artifactDispatch.error) {
            onToast(artifactDispatch.error);
            return false;
          }
          const artifact = artifactDispatch.artifact;
          if (artifactDispatch.handledSkill) {
            outText = artifactDispatch.outText;
            invokedSkill = artifactDispatch.invokedSkill;
            // 标题用用户原话占位:outText 是派发指令(/skill:design … / skill prose),
            // 让 autoTitle 拿它派生会把指令搬进标题栏。
            if (artifactDispatch.userText) presetSessionTitle(session, artifactDispatch.userText);
            if (artifactDispatch.created && artifact) {
              updateSession(session.id, {
                activeArtifact: artifact,
                artifacts: upsertConversationArtifact(session.artifacts, artifact),
              });
            }
            setRightView("artifact");
            setRightOpen(true);
          }
          const parsed = parseSkillSlash(text);
          if (!artifactDispatch.handledSkill && session.agent !== "pi") {
            if (parsed) {
              const records = await resolveEnabledSkillRecords(bridge, project.path, session.useOwnSkills, session.agent);
              const skill = records.find((s) => s.name === parsed.name);
              if (skill) {
                // delegate 编排复用主会话 startCli，skill 派发与普通发送完全相同。
                const dispatch = resolveSkillDispatch(session.agent, text, parsed.args, skill, records);
                outText = dispatch.outText;
                invokedSkill = dispatch.invokedSkill;
              }
            }
          }
          const artifactPrompt = artifact
            ? buildConversationArtifactPrompt(artifact)
            : undefined;
          // 白板意图优先于当前绑定的设计产物：明确“画架构图/白板”应作用于会话级
          // `.kun-canvas/code-<sessionId>`，不能误发到另一个 artifact workspace。
          const whiteboardAppend = artifactDispatch.handledSkill
            ? undefined
            : await buildWhiteboardAppend(text);
          return send(
            session,
            project.path,
            outText,
            attachments,
            [whiteboardAppend, whiteboardAppend ? undefined : artifactPrompt].filter(Boolean).join("\n\n") || undefined,
            images,
            undefined,
            docFiles,
            invokedSkill,
            undefined,
            whiteboardAppend ? undefined : artifact,
          );
        }}
        onStop={() => void stopRun(session.id)}
        onSteer={session.agent === "pi" ? (text) => void steer(session.id, text) : undefined}
        onChangeModel={(model) => updateSession(session.id, { model })}
        onChangePiModel={(providerId, model) => setPiModel(session, providerId, model)}
        onChangeThinking={(value) => setThinking(session, value)}
        onChangeExecPermission={(p) => updateSession(session.id, { execPermission: p })}
        onToggleSkills={() => updateSession(session.id, { useOwnSkills: session.useOwnSkills !== true })}
        onToggleWebSearch={() => updateSession(session.id, { webSearch: session.webSearch !== true })}
        onSetGoal={startOrReplaceGoal}
        onSetGoalStatus={changeGoalStatus}
        onClearGoal={() => clearSessionGoal(session.id)}
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
