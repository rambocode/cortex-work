// 个人工作区会话消息层。消息流存 React Query cache（key 按 sessionId 隔离），
// CLI 流式事件（经 DesktopBridge）增量写入缓存：
//   typing 占位 → 首个事件后替换为流式 text / agentLog → result/exit 落定。
// 多轮：init 捕获 agent session id 写回 SessionMeta，下一轮 resume。

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Message } from "../types";
import type {
  AgentKind,
  AskQuestionAnswers,
  AskQuestionEnvelope,
  CliStreamEvent,
  HiddenHistoryMeta,
  PiSessionEvent,
  PiUiResponsePayload,
  ProjectMeta,
  SessionMeta,
  ThinkingLevel,
} from "../desktop/types";
import { DEFAULT_PI_SKILLS } from "../desktop/types";
import type { DesktopBridge } from "../desktop/bridge";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import { usePetStore } from "../store/pet";
import { extractChangedFile, promptTitle, clipSummary, recordTimelineEvent } from "./timeline";
import { applyDeepenFinalize } from "./notes";
import {
  abortPi,
  ensurePiSession,
  forkPi,
  getForkMessagesPi,
  isPiSessionOpen,
  markPiSessionGone,
  piRpcAvailable,
  piRpcUnavailableMessage,
  promptPi,
  setModelPi,
  setThinkingLevelPi,
  setPiLifecycleHooks,
  steerPi,
  touchPiSession,
} from "./pi-session";
import { speakText } from "./tts";

// 全局桥引用：usePersonalCliEvents（个人工作区根部挂载一次）写入，
// 供模块级缓存写入函数做消息落盘。
let bridgeRef: DesktopBridge | null = null;

export const personalChatKeys = {
  detail: (sessionId: string) => ["personal", "convo", sessionId] as const,
};

export interface PromptAttachment {
  id: string;
  name: string;
  path: string;
  kind: "prompt";
  content: string;
}

export interface TodoAttachment {
  id: string;
  name: string;
  path: string;
  kind: "todo";
  projectName: string;
  content: string;
}

export type PersonalAttachment = PromptAttachment | TodoAttachment;

export function buildAttachmentSystemPrompt(attachments: PersonalAttachment[]): string | undefined {
  if (attachments.length === 0) return undefined;
  return attachments
    .map((a) =>
      a.kind === "prompt"
        ? `<skill name="${a.name}">\n${a.content}\n</skill>`
        : [
            `<todo name="${a.name}" project="${a.projectName}">`,
            `# ${a.name}`,
            "",
            a.content,
            "</todo>",
          ].join("\n"),
    )
    .join("\n\n");
}

// 个人工作区项目清单 → system prompt 块（让 agent 知道用户有哪些本地项目及绝对路径）。
// 排除归档项目;无可用项目返回 undefined。Spotlight 默认「不使用项目」时 cwd 是 no-project
// 目录,但此块仍列出项目,便于 agent 按需进入某项目。
export function buildProjectSystemPrompt(projects: ProjectMeta[]): string | undefined {
  const active = projects.filter((p) => p.archivedAt == null);
  if (active.length === 0) return undefined;
  const lines = active.map((p) => `- ${p.name}: ${p.path}`).join("\n");
  return [
    "<personal_workspace_projects>",
    "以下是用户「个人工作区」中登记的本地项目(名称: 绝对路径)。",
    "当前会话默认不在任何项目目录下工作;如需操作某项目,请使用其绝对路径。",
    lines,
    "</personal_workspace_projects>",
  ].join("\n");
}

function realHHMM(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── run 注册表（runId → 流式渲染状态） ────────────────────────────────────
interface RunState {
  sessionId: string;
  agent: AgentKind; // 消息 who
  typingUid: string;
  cursor: FoldCursor; // 流式块折叠游标（按到达顺序交替分块，取代单例 textUid/logUid）
  sawText: boolean; // 本轮是否产出过文本（result 文本兜底判断）
  buffer: string;
  gotResult: boolean;
  resultOk?: boolean;
  // 启动状态机:starting(进程启动中)→ thinking(收到 init,等首个输出)。
  phase: "starting" | "thinking";
  // 最近一次收到事件的时间,看门狗据此判定卡死。
  lastEventAt: number;
  watchdog?: ReturnType<typeof setInterval>;
  // 时间线采集：prompt 首行 / 起始时间 / 项目路径 / 写类工具触碰的文件。
  promptText?: string;
  startedAt?: number;
  cwd?: string;
  changedFiles?: Set<string>;
  resultExitFallback?: ReturnType<typeof setTimeout>;
  // 传输通道:cli=单发 startCli（claude/codex）;pi=RPC 长驻会话。pi 的看门狗绝不杀进程。
  transport?: "cli" | "pi";
  // pi 思考流（reasoning）的折叠块（独立于 text/tool 游标:思考通常先于正文,累进同一块）。
  reasoningUid?: string;
  reasoningText?: string;
}

const runs = new Map<string, RunState>();

// pi 同会话「发送在途」同步锁:覆盖 running 置位前的异步窗口（ensureChatLoaded 等 await）,
// 防并发/抖动 send 同会话造孤儿 run + 永不自杀的看门狗。beginPiRun 置 running 后即交棒释放。
const piSendStarting = new Set<string>();

// 看门狗阈值:启动阶段(一个事件都没收到)90 秒;运行中静默 300 秒
// (工具可能长时间执行不产生事件,放宽避免误杀)。
export const RUN_START_TIMEOUT_MS = 90_000;
export const RUN_STALL_TIMEOUT_MS = 300_000;
export const RESULT_EXIT_GRACE_MS = 1_000;

const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

// typing 占位文案:阶段 + 等待时长(5 秒以上才显示,避免一闪而过的数字)。
export function typingText(agent: AgentKind, phase: "starting" | "thinking", waitedMs: number): string {
  const base = phase === "starting" ? `正在启动 ${AGENT_NAME[agent]}…` : `${AGENT_NAME[agent]} 正在思考…`;
  const secs = Math.floor(waitedMs / 1000);
  return secs >= 5 ? `${base}已等待 ${secs} 秒` : base;
}

function stopWatchdog(run: RunState): void {
  if (run.watchdog) {
    clearInterval(run.watchdog);
    run.watchdog = undefined;
  }
}

function stopResultExitFallback(run: RunState): void {
  if (run.resultExitFallback) {
    clearTimeout(run.resultExitFallback);
    run.resultExitFallback = undefined;
  }
}

function stopRunTimers(run: RunState): void {
  stopWatchdog(run);
  stopResultExitFallback(run);
}

// typing 是瞬态消息(sanitizeForSave 会丢弃),只改缓存不调度落盘,避免每秒空写。
function updateTypingMsg(qc: QueryClient, sessionId: string, typingUid: string, text: string): void {
  qc.setQueryData<Message[]>(personalChatKeys.detail(sessionId), (prev) =>
    (prev ?? []).map((m) => (m.uid === typingUid && m.kind === "typing" ? { ...m, text } : m)),
  );
}

export function sessionResumeId(session: SessionMeta): string | undefined {
  return session.agentSessionIds?.[session.agent] ?? (session.agent === "claude" ? session.claudeSessionId : undefined);
}

export function agentSessionPatch(session: SessionMeta, agent: AgentKind, id: string): Partial<SessionMeta> {
  const agentSessionIds = { ...session.agentSessionIds, [agent]: id };
  return agent === "claude" ? { agentSessionIds, claudeSessionId: id } : { agentSessionIds };
}

export function clearAgentSessionPatch(session: SessionMeta, agent: AgentKind): Partial<SessionMeta> {
  const agentSessionIds = { ...session.agentSessionIds };
  delete agentSessionIds[agent];
  return agent === "claude" ? { agentSessionIds, claudeSessionId: undefined } : { agentSessionIds };
}

export function isMissingAgentSessionError(error?: string): boolean {
  return /thread\/resume failed|no rollout found for thread id/i.test(error ?? "");
}

export interface PersonalChatSlice {
  allMessages: Message[];
  hiddenMessages: Message[];
  visibleMessages: Message[];
  messages: Message[];
  hiddenCount: number;
  hiddenHistory?: HiddenHistoryMeta;
}

function clampIndex(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.trunc(n), max));
}

export function splitPersonalMessages(messages: Message[], hiddenHistory?: HiddenHistoryMeta): PersonalChatSlice {
  let hiddenEnd = 0;
  if (hiddenHistory) {
    const throughIndex = hiddenHistory.throughUid
      ? messages.findIndex((m) => m.uid === hiddenHistory.throughUid)
      : -1;
    hiddenEnd = throughIndex >= 0 ? throughIndex + 1 : clampIndex(hiddenHistory.count, messages.length);
  }
  const hiddenMessages = hiddenEnd > 0 ? messages.slice(0, hiddenEnd) : [];
  const visibleMessages = hiddenEnd > 0 ? messages.slice(hiddenEnd) : messages;
  return {
    allMessages: messages,
    hiddenMessages,
    visibleMessages,
    messages: visibleMessages,
    hiddenCount: hiddenMessages.length,
    hiddenHistory,
  };
}

export function createHiddenHistory(messages: Message[], now = Date.now()): HiddenHistoryMeta {
  const last = messages[messages.length - 1];
  const hiddenHistory: HiddenHistoryMeta = { count: messages.length, hiddenAt: now };
  if (last?.uid) hiddenHistory.throughUid = last.uid;
  return hiddenHistory;
}

// ── 消息持久化（节流落盘） ────────────────────────────────────────────────
const SAVE_THROTTLE_MS = 600;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 落盘前清理瞬态:typing 丢弃,运行中的 agentLog 标记完成（重启后不会有悬挂 spinner）。
function sanitizeForSave(messages: Message[]): Message[] {
  return messages
    .filter((m) => m.kind !== "typing")
    .map((m) => (m.kind === "agentLog" && m.active ? { ...m, active: false, completed: true } : m));
}

function flushChat(qc: QueryClient, sessionId: string): void {
  const timer = saveTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(sessionId);
  }
  const messages = qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId));
  if (bridgeRef && messages) void bridgeRef.saveChat(sessionId, sanitizeForSave(messages));
}

function scheduleChatSave(qc: QueryClient, sessionId: string): void {
  if (!bridgeRef) return;
  const prev = saveTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  saveTimers.set(
    sessionId,
    setTimeout(() => flushChat(qc, sessionId), SAVE_THROTTLE_MS),
  );
}

function setMessages(qc: QueryClient, sessionId: string, updater: (prev: Message[]) => Message[]): void {
  qc.setQueryData<Message[]>(personalChatKeys.detail(sessionId), (prev) => updater(prev ?? []));
  scheduleChatSave(qc, sessionId);
}

function appendMsg(qc: QueryClient, sessionId: string, msg: Message): void {
  setMessages(qc, sessionId, (prev) => [...prev, msg]);
}

function dropMsg(qc: QueryClient, sessionId: string, msgUid: string): void {
  setMessages(qc, sessionId, (prev) => prev.filter((m) => m.uid !== msgUid));
}

// 清掉某 session 的全部 typing 占位 + 把仍在运行的 agentLog 收尾。
function clearTransient(qc: QueryClient, sessionId: string): void {
  setMessages(qc, sessionId, (prev) =>
    prev
      .filter((m) => m.kind !== "typing")
      .map((m) =>
        m.kind === "agentLog" && m.active ? { ...m, active: false, completed: true, title: "Agent 执行完成" } : m,
      ),
  );
}

// ── 流式块折叠（按到达顺序的尾部折叠） ─────────────────────────────────────
// text 块与 agentLog 块按事件到达顺序交替成多个独立块：同类事件并入当前打开块,
// 异类则收尾旧块、开新块（语义对齐 open-design 的 buildBlocks——只与紧邻上一块同类合并）。
// 连续工具仍并入同一张 agentLog 卡片;连续文本增量仍并入同一个 text 块。
export interface FoldCursor {
  lastKind?: "text" | "tool"; // 当前打开块的类型
  textUid?: string; // 当前打开的 text 块 uid（lastKind==="text" 时有效）
  logUid?: string; // 当前打开的 agentLog 块 uid（lastKind==="tool" 时有效）
  segmentText: string; // 当前打开 text 块已累加文本
}

export interface FoldCtx {
  agent: AgentKind;
  time: string;
  newUid: (prefix: string) => string;
}

export function emptyFoldCursor(): FoldCursor {
  return { segmentText: "" };
}

// 收尾一个 agentLog 块:全部 items 翻 check 并标记完成（停 spinner）。
export function finalizeAgentLog(messages: Message[], logUid: string): Message[] {
  return messages.map((m) =>
    m.uid === logUid && m.kind === "agentLog"
      ? {
          ...m,
          active: false,
          completed: true,
          title: "Agent 执行完成",
          items: m.items.map((it) => ({ ...it, ic: "check" as const })),
        }
      : m,
  );
}

// 折叠单个 text/tool 事件到消息数组尾部,返回新数组 + 新游标（纯函数,便于单测）。
// 仅处理 text / tool;init/result/error 由 handleCliEvent 处理。
export function foldCliEvent(
  messages: Message[],
  ev: CliStreamEvent,
  cursor: FoldCursor,
  ctx: FoldCtx,
): { messages: Message[]; cursor: FoldCursor } {
  if (ev.type === "text") {
    // 续写当前 text 块。
    if (cursor.lastKind === "text" && cursor.textUid) {
      const segmentText = cursor.segmentText + ev.delta;
      const next = messages.map((m) =>
        m.uid === cursor.textUid && m.kind === "text" ? { ...m, text: segmentText } : m,
      );
      return { messages: next, cursor: { ...cursor, segmentText } };
    }
    // 异类切换:收尾上一个打开的 agentLog（若有）,开新 text 块。
    const base = cursor.lastKind === "tool" && cursor.logUid ? finalizeAgentLog(messages, cursor.logUid) : messages;
    const textUid = ctx.newUid("at");
    const textMsg: Message = { kind: "text", who: ctx.agent, time: ctx.time, text: ev.delta, uid: textUid };
    return {
      messages: [...base, textMsg],
      cursor: { lastKind: "text", textUid, logUid: undefined, segmentText: ev.delta },
    };
  }

  if (ev.type === "tool") {
    const itemText = ev.detail ? `${ev.name} · ${ev.detail}` : ev.name;
    // 并入当前 agentLog 卡片:既有 items 翻 check,追加新 running 项。
    if (cursor.lastKind === "tool" && cursor.logUid) {
      const next = messages.map((m) =>
        m.uid === cursor.logUid && m.kind === "agentLog"
          ? {
              ...m,
              items: [
                ...m.items.map((it) => ({ ...it, ic: "check" as const })),
                { ic: "running" as const, text: itemText },
              ],
            }
          : m,
      );
      return { messages: next, cursor };
    }
    // 异类切换（或起手）:开新 agentLog 卡片。前一个 text 块无需收尾。
    const logUid = ctx.newUid("log");
    const logMsg: Message = {
      kind: "agentLog",
      who: ctx.agent,
      time: ctx.time,
      title: "Agent 正在执行",
      active: true,
      uid: logUid,
      items: [{ ic: "running", text: itemText }],
    };
    return {
      messages: [...messages, logMsg],
      cursor: { lastKind: "tool", logUid, textUid: undefined, segmentText: "" },
    };
  }

  return { messages, cursor };
}

// 把一个 text/tool 事件折叠进消息缓存,并回写 run 的折叠游标。
function foldIntoCache(qc: QueryClient, sessionId: string, run: RunState, ev: CliStreamEvent): void {
  let nextCursor = run.cursor;
  setMessages(qc, sessionId, (prev) => {
    const folded = foldCliEvent(prev, ev, run.cursor, { agent: run.agent, time: realHHMM(), newUid: uid });
    nextCursor = folded.cursor;
    return folded.messages;
  });
  run.cursor = nextCursor;
}

function clearStoredAgentSessionId(sessionId: string, agent: AgentKind): void {
  const sess = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
  if (!sess) return;
  usePersonalStore.getState().updateSession(sessionId, clearAgentSessionPatch(sess, agent));
}

function handleCliEvent(qc: QueryClient, runId: string, ev: CliStreamEvent, sessionIdHint?: string): void {
  let run = runs.get(runId);
  if (!run) {
    // renderer 被 HMR/刷新重载,内存注册表丢失 —— 用主进程回显的 sessionId 重建,
    // 让仍在跑的流继续渲染,而不是永远卡在「运行中」。
    if (!sessionIdHint) return;
    const sess = usePersonalStore.getState().sessions.find((x) => x.id === sessionIdHint);
    run = {
      sessionId: sessionIdHint,
      agent: sess?.agent ?? "claude",
      typingUid: "recovered-no-typing",
      cursor: emptyFoldCursor(),
      sawText: false,
      buffer: "",
      gotResult: false,
      phase: "thinking",
      lastEventAt: Date.now(),
    };
    runs.set(runId, run);
    usePersonalStore.getState().setRunning(sessionIdHint, runId);
  }
  const { sessionId } = run;
  run.lastEventAt = Date.now();

  if (ev.type === "init") {
    // 进程已起来:启动中 → 思考中。
    run.phase = "thinking";
    updateTypingMsg(qc, sessionId, run.typingUid, typingText(run.agent, "thinking", 0));
    const sess = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
    if (sess) usePersonalStore.getState().updateSession(sessionId, agentSessionPatch(sess, run.agent, ev.sessionId));
    return;
  }

  if (ev.type === "tool") {
    usePetStore.getState().set("working");
    dropMsg(qc, sessionId, run.typingUid);
    // 时间线：写类工具的 file_path 记为变更文件。
    const changed = extractChangedFile(ev.name, ev.detail, run.cwd ?? "");
    if (changed) (run.changedFiles ??= new Set()).add(changed);
    foldIntoCache(qc, sessionId, run, ev);
    return;
  }

  if (ev.type === "text") {
    usePetStore.getState().set("replying");
    dropMsg(qc, sessionId, run.typingUid);
    run.buffer += ev.delta; // 全轮文本累加（供 TTS / 时间线 summary），独立于块拆分
    run.sawText = true;
    foldIntoCache(qc, sessionId, run, ev);
    return;
  }

  if (ev.type === "result") {
    run.gotResult = true;
    run.resultOk = ev.ok;
    dropMsg(qc, sessionId, run.typingUid);
    // 收尾当前打开的 agentLog：全部步骤打勾（被文本打断的旧卡片已在折叠时收尾）。
    if (run.cursor.lastKind === "tool" && run.cursor.logUid) {
      const logUid = run.cursor.logUid;
      setMessages(qc, sessionId, (prev) => finalizeAgentLog(prev, logUid));
    }
    if (!ev.ok) {
      if (run.agent === "codex" && isMissingAgentSessionError(ev.error)) {
        clearStoredAgentSessionId(sessionId, run.agent);
        appendMsg(qc, sessionId, {
          kind: "text",
          who: run.agent,
          time: realHHMM(),
          text: "⚠️ Codex 本地会话历史已丢失，已断开旧 thread id。下次发送会创建新的 Codex 线程。",
          uid: uid("err"),
        });
        notifyTurnComplete(false);
        scheduleResultExitFallback(qc, runId, sessionId);
        return;
      }
      // pi 兜底 Agent 鉴权类错误:补一句去哪里配供应商 / API Key。
      const piAuthHint =
        run.agent === "pi" && /api.?key|auth|credential|unauthorized|401|provider/i.test(ev.error ?? "")
          ? "（请在 设置 → 供应商 添加供应商并填写 API Key）"
          : "";
      appendMsg(qc, sessionId, {
        kind: "text",
        who: run.agent,
        time: realHHMM(),
        text: `⚠️ 执行出错：${ev.error || "未知错误"}${piAuthHint}`,
        uid: uid("err"),
      });
    } else if (!run.sawText && ev.text) {
      // 没收到增量文本（极少数情况），用 result 的最终文本兜底。
      appendMsg(qc, sessionId, { kind: "text", who: run.agent, time: realHHMM(), text: ev.text, uid: uid("at") });
    }
    notifyTurnComplete(ev.ok);
    scheduleResultExitFallback(qc, runId, sessionId);
  }
}

// 回合完成系统通知（通用设置开关 + 仅窗口失焦时打扰）。Notification 是标准 Web API,
// 在 Electron renderer 与浏览器均可用;不可用/被拒时静默。
function notifyTurnComplete(ok: boolean): void {
  try {
    if (!usePersonalStore.getState().generalSettings.notifications.turnComplete) return;
    if (typeof document !== "undefined" && document.hasFocus()) return;
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    const fire = () => new Notification("Cortex Desktop", { body: ok ? "Agent 回合完成" : "Agent 执行出错" });
    if (Notification.permission === "granted") fire();
    else void Notification.requestPermission().then((p) => (p === "granted" ? fire() : undefined));
  } catch {
    /* 通知不可用时静默 */
  }
}

function scheduleResultExitFallback(qc: QueryClient, runId: string, sessionId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  stopResultExitFallback(run);
  run.resultExitFallback = setTimeout(() => {
    finalizeRun(qc, runId, 0, undefined, sessionId);
  }, RESULT_EXIT_GRACE_MS);
}

function finalizeRun(
  qc: QueryClient,
  runId: string,
  code: number | null,
  error?: string,
  sessionIdHint?: string,
): void {
  const run = runs.get(runId);
  if (!run) {
    // 注册表丢失（重载/看门狗已超时清理）时按 sessionId 兜底,保证 UI 不卡死。
    if (sessionIdHint) {
      clearTransient(qc, sessionIdHint);
      const store = usePersonalStore.getState();
      if (store.runningBySession[sessionIdHint] === runId) store.setRunning(sessionIdHint, undefined);
      flushChat(qc, sessionIdHint);
      usePetStore.getState().set("idle");
    }
    return;
  }
  stopRunTimers(run);
  runs.delete(runId);
  const { sessionId } = run;
  dropMsg(qc, sessionId, run.typingUid);
  usePersonalStore.getState().setRunning(sessionId, undefined);

  if (!run.gotResult && (error || (code !== null && code !== 0))) {
    const missingCodexSession = run.agent === "codex" && isMissingAgentSessionError(error);
    if (missingCodexSession) clearStoredAgentSessionId(sessionId, run.agent);
    const friendly = missingCodexSession
      ? "Codex 本地会话历史已丢失，已断开旧 thread id。下次发送会创建新的 Codex 线程。"
      : error && /ENOENT/.test(error)
        ? "未检测到 CLI，请确认已安装并在 PATH 中（如 npm install -g @anthropic-ai/claude-code）"
        : error || `进程退出码 ${code}`;
    appendMsg(qc, sessionId, {
      kind: "text",
      who: run.agent,
      time: realHHMM(),
      text: `⚠️ ${friendly}`,
      uid: uid("err"),
    });
  }
  // 一轮结束立即冲刷落盘，不等节流窗口。
  flushChat(qc, sessionId);
  // 成功收尾 → 开心一下;失败/中断 → 回闲置。
  usePetStore.getState().set(run.gotResult && run.resultOk !== false ? "happy" : "idle");

  // TTS：开启自动朗读时,把这一轮的回复读出来（失败静默,不影响会话）。
  const tts = usePersonalStore.getState().ttsSettings;
  if (tts.autoSpeak && run.gotResult && run.buffer.trim()) {
    speakText(bridgeRef, tts, run.buffer).catch(() => {
      // TTS 端点不可用等,静默跳过
    });
  }

  // 时间线：记录这一轮 run 事件（恢复型 run 无 prompt,用回复首行兜底）。
  // 不使用项目的会话（无 projectId）不归入任何项目时间线,跳过。
  const session = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
  if (session && session.projectId) {
    const title = run.promptText ? promptTitle(run.promptText) : promptTitle(run.buffer || "（恢复的轮次）");
    recordTimelineEvent(qc, bridgeRef, session.projectId, {
      id: `run-${runId}`,
      projectId: session.projectId,
      sessionId,
      ts: Date.now(),
      kind: "run",
      title,
      summary: clipSummary(run.buffer),
      files: run.changedFiles?.size ? [...run.changedFiles] : undefined,
      meta: {
        agent: run.agent,
        ok: run.gotResult && run.resultOk !== false && !error && (code === null || code === 0),
        durationMs: run.startedAt ? Date.now() - run.startedAt : undefined,
      },
    });
  }

  // 深化副作用:仅当该 session 有关联闪记（深化中 deepening / 生成 plan 的 deepened）时才动作
  //（普通会话完全 no-op,applyDeepenFinalize 内部 gate）。终态失败（spawn/鉴权/超时/放弃）→
  // 回落 draft（plan run 的 deepened 不回落）;否则 fs.exists 探测确定产出路径 → 置已深化/追加
  // docPaths;普通澄清轮 → 保持原状态。鉴权失败走 result(ok:false)（gotResult=true、resultOk=false）;
  // spawn/超时/非零退出走 (!gotResult && (error||非零 code))。
  const terminalFailure =
    (!run.gotResult && (!!error || (code !== null && code !== 0))) ||
    (run.gotResult && run.resultOk === false);
  void applyDeepenFinalize(bridgeRef, {
    sessionId,
    cwd: run.cwd,
    terminalFailure,
  });
}

function handleCliExit(
  qc: QueryClient,
  runId: string,
  code: number | null,
  error?: string,
  sessionIdHint?: string,
): void {
  finalizeRun(qc, runId, code, error, sessionIdHint);
}

export function __handleCliEventForTest(
  qc: QueryClient,
  runId: string,
  ev: CliStreamEvent,
  sessionIdHint?: string,
): void {
  handleCliEvent(qc, runId, ev, sessionIdHint);
}

export function __handleCliExitForTest(
  qc: QueryClient,
  runId: string,
  code: number | null,
  error?: string,
  sessionIdHint?: string,
): void {
  handleCliExit(qc, runId, code, error, sessionIdHint);
}

export function __resetPersonalMessageRunsForTest(): void {
  for (const run of runs.values()) stopRunTimers(run);
  runs.clear();
  piSendStarting.clear();
  bridgeRef = null;
}

// ── pi RPC 会话（pi --mode rpc）的事件折叠 + 轮生命周期 ─────────────────────
// 复用上面单发的 runs / RunState / foldIntoCache / finalizeRun:pi 与单发语义重叠的
// text/tool/result 走同一折叠管线;pi 专属 reasoning/compaction/retry/queue/thinking-level/
// crashed 单独处理。关键发散:pi 进程长驻,看门狗只刷新 typing 等待时长、绝不 killCli;一轮
// 由 result 事件（agent_end）收尾,不等 exit。

/**
 * 开启一个 pi 轮:创建 RunState（transport:"pi"）+ 只刷新等待时长的看门狗 + setRunning。
 * runId/typingUid 由调用方（send）生成;调用方负责已 appendMsg 用户消息 + typing 占位。
 */
export function beginPiRun(
  qc: QueryClient,
  opts: {
    runId: string;
    sessionId: string;
    typingUid: string;
    cwd?: string;
    promptText?: string;
    phase?: "starting" | "thinking";
  },
): void {
  const run: RunState = {
    sessionId: opts.sessionId,
    agent: "pi",
    typingUid: opts.typingUid,
    cursor: emptyFoldCursor(),
    sawText: false,
    buffer: "",
    gotResult: false,
    phase: opts.phase ?? "starting",
    lastEventAt: Date.now(),
    promptText: opts.promptText,
    startedAt: Date.now(),
    cwd: opts.cwd,
    transport: "pi",
  };
  runs.set(opts.runId, run);
  // pi 看门狗:只滚动显示等待时长,绝不杀进程（长驻;一轮靠 result/abort 收尾,无静默超时杀）。
  run.watchdog = setInterval(() => {
    const cur = runs.get(opts.runId);
    if (!cur) return;
    if (!cur.cursor.lastKind && !cur.reasoningUid && !cur.gotResult && cur.startedAt) {
      updateTypingMsg(qc, cur.sessionId, cur.typingUid, typingText("pi", cur.phase, Date.now() - cur.startedAt));
    }
  }, 1000);
  usePersonalStore.getState().setRunning(opts.sessionId, opts.runId);
  usePetStore.getState().set("thinking");
}

// 冷启动会话:piOpen 完成后从「启动中」翻到「思考中」（复用会话则一开始即 thinking）。
export function flipPiRunToThinking(qc: QueryClient, runId: string): void {
  const run = runs.get(runId);
  if (!run || run.phase === "thinking") return;
  run.phase = "thinking";
  updateTypingMsg(qc, run.sessionId, run.typingUid, typingText("pi", "thinking", 0));
}

// 思考流折叠:首个 reasoning delta 开块,后续累进同一 reasoning 块。
function foldReasoning(qc: QueryClient, run: RunState, delta: string): void {
  const { sessionId } = run;
  if (run.reasoningUid) {
    const text = (run.reasoningText ?? "") + delta;
    run.reasoningText = text;
    const ruid = run.reasoningUid;
    setMessages(qc, sessionId, (prev) =>
      prev.map((m) => (m.uid === ruid && m.kind === "reasoning" ? { ...m, text } : m)),
    );
    return;
  }
  const ruid = uid("re");
  run.reasoningUid = ruid;
  run.reasoningText = delta;
  appendMsg(qc, sessionId, { kind: "reasoning", who: run.agent, time: realHHMM(), text: delta, uid: ruid });
}

// tool-end:把当前 agentLog 卡片里最后一个 running 项翻 check;出错则文本前缀 ⚠️。
// 顺序工具精确;并发工具（罕见）best-effort 翻最后一个,不影响整体可读性。
function finalizeLastToolItem(qc: QueryClient, run: RunState, isError: boolean): void {
  if (run.cursor.lastKind !== "tool" || !run.cursor.logUid) return;
  const logUid = run.cursor.logUid;
  setMessages(qc, run.sessionId, (prev) =>
    prev.map((m) => {
      if (m.uid !== logUid || m.kind !== "agentLog") return m;
      const items = [...m.items];
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it && it.ic === "running") {
          const text = isError && typeof it.text === "string" ? `⚠️ ${it.text}` : it.text;
          items[i] = { ...it, ic: "check", text };
          break;
        }
      }
      return { ...m, items };
    }),
  );
}

function appendPiError(qc: QueryClient, run: RunState, error: string): void {
  // 鉴权类错误补一句去哪配供应商（与单发 result 错误分支同款）。
  const piAuthHint = /api.?key|auth|credential|unauthorized|401|provider/i.test(error)
    ? "（请在 设置 → 供应商 添加供应商并填写 API Key）"
    : "";
  appendMsg(qc, run.sessionId, {
    kind: "text",
    who: run.agent,
    time: realHHMM(),
    text: `⚠️ 执行出错：${error || "未知错误"}${piAuthHint}`,
    uid: uid("err"),
  });
}

// 取某会话当前活跃的 pi run（一个会话同时至多一轮）。
function piRunFor(sessionId: string): { runId: string; run: RunState } | undefined {
  const runId = usePersonalStore.getState().runningBySession[sessionId];
  if (!runId) return undefined;
  const run = runs.get(runId);
  return run ? { runId, run } : undefined;
}

// pi 硬失败（坏 key/限流/provider 挂）时,单发 pi 适配器实测:进程 exit 0、错误只在
// message_end{stopReason:error},agent_end 可能不发（见 apps/desktop/src/main/agents/pi.ts:15）。
// RPC 用 agent_end 作终结符,故 error 后给一段宽限:无 result/retry 跟进则自行收尾,防永久卡 running。
const PI_ERROR_FINALIZE_GRACE_MS = 4_000;

// pi 归一化事件 → 消息缓存。无活跃 run 也要处理的状态/瞬态事件先分流;其余折叠进当前轮。
function handlePiEvent(qc: QueryClient, sessionId: string, ev: PiSessionEvent, evRunId?: string): void {
  const store = usePersonalStore.getState();
  // 阶段4:任何事件 = 活跃,刷新空闲回收计时器（避免运行中被误回收）。
  touchPiSession(bridgeRef, sessionId);
  // 阶段4 代际守卫:事件带 runId 且与当前活跃轮不符 → 迟到/串台事件（崩溃重开/editResend 重入的
  // 旧轮事件），丢弃,不折叠进新轮。状态/瞬态事件（queue/compaction/crashed 等不折叠进 run）放行。
  const activeRunId = store.runningBySession[sessionId];
  if (evRunId && activeRunId && evRunId !== activeRunId && ev.type !== "crashed") return;
  // 任何新事件都说明本轮仍活跃 → 取消下面 error 分支挂的「防卡死」兜底收尾。
  const activeAny = piRunFor(sessionId);
  if (activeAny) stopResultExitFallback(activeAny.run);
  switch (ev.type) {
    case "queue":
      store.setPiRuntime(sessionId, { steering: ev.steering, followUp: ev.followUp });
      return;
    case "compaction":
      store.setPiRuntime(sessionId, { compacting: ev.phase === "start" });
      return;
    case "retry":
      store.setPiRuntime(sessionId, { retry: { attempt: ev.attempt, max: ev.maxAttempts } });
      return;
    case "thinking-level":
      store.setPiRuntime(sessionId, { thinkingLevel: ev.level });
      return;
    case "session-info":
      return; // 预留:暂不据此改标题（避免覆盖用户改名）。
    case "crashed": {
      markPiSessionGone(sessionId);
      const active = piRunFor(sessionId);
      if (active) {
        stopRunTimers(active.run);
        runs.delete(active.runId);
      }
      clearTransient(qc, sessionId);
      appendMsg(qc, sessionId, {
        kind: "text",
        who: "pi",
        time: realHHMM(),
        // 阶段4:崩溃后会话内存态丢,但 sessionFile 已持久 → 下次发送惰性重开 + switchSession 恢复上下文。
        text: `⚠️ pi 会话已退出${ev.error ? `：${ev.error}` : ""}。下次发送将自动重启并恢复上下文。`,
        uid: uid("err"),
      });
      store.setRunning(sessionId, undefined);
      store.setPiRuntime(sessionId, undefined);
      store.clearPiUiForSession(sessionId); // 清该会话悬挂的确认弹窗（进程已死,回写无意义）。
      flushChat(qc, sessionId);
      usePetStore.getState().set("idle");
      return;
    }
  }

  const active = piRunFor(sessionId);
  if (!active) return; // 轮已结束/未开始,丢弃残余流（与停止后丢弃 stdout 对称）。
  const { runId, run } = active;
  run.lastEventAt = Date.now();
  if (run.phase === "starting") run.phase = "thinking";

  switch (ev.type) {
    case "reasoning":
      usePetStore.getState().set("thinking");
      dropMsg(qc, sessionId, run.typingUid);
      foldReasoning(qc, run, ev.delta);
      return;
    case "text":
      usePetStore.getState().set("replying");
      dropMsg(qc, sessionId, run.typingUid);
      run.buffer += ev.delta;
      run.sawText = true;
      foldIntoCache(qc, sessionId, run, { type: "text", delta: ev.delta });
      return;
    case "tool-start": {
      usePetStore.getState().set("working");
      dropMsg(qc, sessionId, run.typingUid);
      const changed = extractChangedFile(ev.name, ev.detail, run.cwd ?? "");
      if (changed) (run.changedFiles ??= new Set()).add(changed);
      foldIntoCache(qc, sessionId, run, { type: "tool", name: ev.name, detail: ev.detail });
      return;
    }
    case "tool-end":
      finalizeLastToolItem(qc, run, ev.isError);
      return;
    case "turn-end":
      if (run.cursor.lastKind === "tool" && run.cursor.logUid) {
        const logUid = run.cursor.logUid;
        setMessages(qc, sessionId, (prev) => finalizeAgentLog(prev, logUid));
      }
      return;
    case "error":
      run.resultOk = false;
      dropMsg(qc, sessionId, run.typingUid);
      if (/^aborted$/i.test(ev.error)) {
        appendMsg(qc, sessionId, { kind: "text", who: run.agent, time: realHHMM(), text: "⏹ 已中断本轮。", uid: uid("err") });
      } else {
        appendPiError(qc, run, ev.error);
      }
      // 防卡死:挂宽限兜底,若 pi 不发后续 agent_end/retry 则自行收尾（下个事件会取消它）。
      run.resultExitFallback = setTimeout(
        () => finalizeRun(qc, runId, 0, undefined, sessionId),
        PI_ERROR_FINALIZE_GRACE_MS,
      );
      return;
    case "result":
      if (ev.willRetry) {
        // 自动重试:保留 run 等下一轮事件,不收尾（retry 事件已驱动状态指示）。
        // 复位上一尝试的失败态 + 折叠游标 + buffer,避免成功的重试被误判失败或文本续错块。
        run.gotResult = false;
        run.resultOk = undefined;
        run.cursor = emptyFoldCursor();
        run.reasoningUid = undefined;
        run.reasoningText = undefined;
        run.buffer = "";
        run.sawText = false;
        return;
      }
      run.gotResult = true;
      if (run.resultOk === undefined) run.resultOk = true;
      if (run.cursor.lastKind === "tool" && run.cursor.logUid) {
        const logUid = run.cursor.logUid;
        setMessages(qc, sessionId, (prev) => finalizeAgentLog(prev, logUid));
      }
      store.setPiRuntime(sessionId, undefined);
      notifyTurnComplete(run.resultOk !== false);
      finalizeRun(qc, runId, 0, undefined, sessionId);
      return;
  }
}

export function __handlePiEventForTest(qc: QueryClient, sessionId: string, ev: PiSessionEvent, runId?: string): void {
  handlePiEvent(qc, sessionId, ev, runId);
}

// 强制回收某会话的 renderer run:停看门狗/兜底 + 删 run + 清 running/runtime + 收瞬态。
// 用于「删除/关闭一个仍在跑的 pi 会话」——pi 看门狗无超时自杀,不回收会永久空转 interval
// 并向已删会话缓存写 typing（见 closePiSession 调用点）。对无活跃 run 的会话幂等 no-op。
export function reapSessionRun(qc: QueryClient, sessionId: string): void {
  for (const [id, r] of runs) {
    if (r.sessionId === sessionId) {
      stopRunTimers(r);
      runs.delete(id);
    }
  }
  const store = usePersonalStore.getState();
  store.setRunning(sessionId, undefined);
  store.setPiRuntime(sessionId, undefined);
  store.clearPiUiForSession(sessionId); // 删/关会话时清其悬挂确认弹窗。
  clearTransient(qc, sessionId);
}

// pi:prompt 只收 message 字符串,无 appendSystemPrompt 通道（与单发 startCli 不同）。
// 故把项目/skills/todos 注入内联到消息前（阶段2 取舍:pi 把它当消息一部分;后续可给
// pi:prompt 加系统提示通道）。run.promptText 仍存纯文本（标题/时间线用）。
function buildPiPromptMessage(text: string, appendSystemPrompt?: string): string {
  return appendSystemPrompt ? `${appendSystemPrompt}\n\n${text}` : text;
}

// 插件 Skill（U5）:据 piSkills 配置 + 工作区路径,解析出注入 pi 的 --skill 目录集合。
// 流程:bridge 扫描多根 → 过滤禁用(scope:name) + 工作区未授信 → 按 name 去重(全局覆盖工作区,
// 高可信优先,防恶意工作区同名劫持) → 排序。useOwnSkills===false = 会话级一键关 → []。
// bridge 无 piSkillsList（web/旧壳）或扫描失败 → []（降级,不阻断发送）。RPC 与单发两路共用。
export async function resolveEnabledSkillPaths(
  bridge: DesktopBridge,
  projectPath: string,
  useOwnSkills: boolean | undefined,
): Promise<string[]> {
  if (useOwnSkills === false) return [];
  if (!bridge.piSkillsList) return [];
  const cfg = { ...DEFAULT_PI_SKILLS, ...usePersonalStore.getState().generalSettings.piSkills };
  let skills;
  try {
    skills = await bridge.piSkillsList({
      globalRoots: cfg.globalRoots,
      userGlobalRoots: cfg.userGlobalRoots,
      workspaceEnabled: cfg.workspaceEnabled,
      workspaceDir: projectPath,
    });
  } catch {
    return [];
  }
  const disabled = new Set(cfg.disabledSkills);
  const trusted = new Set(cfg.trustedWorkspaceSkillDirs);
  const enabled = skills.filter((s) => {
    if (disabled.has(`${s.scope}:${s.name}`)) return false; // 已禁用
    if (s.scope === "workspace" && !trusted.has(s.dir)) return false; // 工作区未授信不注入
    return true;
  });
  // name 去重:先放工作区、后放全局覆盖 → 同名时全局胜出。
  const byName = new Map<string, string>();
  for (const s of enabled) if (s.scope === "workspace") byName.set(s.name, s.dir);
  for (const s of enabled) if (s.scope === "global") byName.set(s.name, s.dir);
  return [...byName.values()].sort();
}

function appendUserMessage(
  qc: QueryClient,
  sessionId: string,
  text: string,
  attachments: PersonalAttachment[],
): void {
  appendMsg(qc, sessionId, {
    kind: "text",
    who: "me",
    time: realHHMM(),
    text,
    // 拖入的 skill/todo 仅注入 system prompt;这里同步把引用元数据存进消息,让会话气泡能回显。
    attachments: attachments.length ? attachments.map((a) => ({ name: a.name, kind: a.kind })) : undefined,
    uid: uid("u"),
  });
}

// pi 轮启动/受理失败:收尾本轮（drop typing + ⚠️ + 清 running）。
function failPiTurn(qc: QueryClient, sessionId: string, runId: string, err: unknown): void {
  const run = runs.get(runId);
  if (run) {
    stopRunTimers(run);
    runs.delete(runId);
    dropMsg(qc, sessionId, run.typingUid);
  }
  clearTransient(qc, sessionId);
  const msg = err instanceof Error ? err.message : String(err);
  appendMsg(qc, sessionId, {
    kind: "text",
    who: "pi",
    time: realHHMM(),
    text: `⚠️ pi 会话启动失败：${msg}`,
    uid: uid("err"),
  });
  usePersonalStore.getState().setRunning(sessionId, undefined);
  usePersonalStore.getState().setPiRuntime(sessionId, undefined);
  usePetStore.getState().set("idle");
  flushChat(qc, sessionId);
}

// 发起一轮 pi RPC:beginPiRun（典型不杀进程的看门狗）+ 惰性 ensurePiSession（冷启就绪后翻
// 「思考中」）+ promptPi。失败 → failPiTurn。调用方已 appendMsg 用户消息 + typing 占位。
async function sendPiTurn(
  qc: QueryClient,
  bridge: DesktopBridge,
  session: SessionMeta,
  projectPath: string,
  text: string,
  appendSystemPrompt: string | undefined,
  ids: { runId: string; typingUid: string },
): Promise<void> {
  const { runId, typingUid } = ids;
  const reuse = isPiSessionOpen(session.id); // 复用已开会话:一开即「思考中」;冷启显「启动中」。
  beginPiRun(qc, {
    runId,
    sessionId: session.id,
    typingUid,
    cwd: projectPath,
    promptText: text,
    phase: reuse ? "thinking" : "starting",
  });
  piSendStarting.delete(session.id); // running 已置位,发送在途锁交棒（之后并发 send 被 running 挡）。

  // provider/model 解析:复用单发 isPi 分支策略（只取已启用 provider;停用/失效落空走 pi 内置默认）。
  const providerSettings = usePersonalStore.getState().providerSettings;
  const provider = providerSettings.providers.find(
    (p) => p.id === (session.providerId ?? providerSettings.defaultProviderId) && p.enabled,
  );
  const model = session.model ?? providerSettings.defaultModel ?? provider?.models[0]?.id;

  try {
    // pi 深度定制开关（阶段3）:从通用设置读,塞进 piOpen,主进程据此生成审批/样例 extension。
    // 会话开启时生效（extension 在 open 时加载）;改设置需重开会话才应用。
    const piCustom = usePersonalStore.getState().generalSettings.piCustomization;
    // 持久 system prompt（阶段4）:用户配置的人设/规则,经 --append-system-prompt 系统级注入。
    // 与每轮临时 appendSystemPrompt（buildPiPromptMessage 内联）解耦——后者走 prompt 文本,前者走会话启动参数。
    const piSystemPrompt = usePersonalStore.getState().generalSettings.piSystemPrompt;
    // 思考强度初值（阶段5）:会话级优先,缺省回退全局默认;再缺省 = 不传 --thinking = pi 内置默认。
    const thinkingLevel = session.thinkingLevel ?? usePersonalStore.getState().generalSettings.piThinkingDefault;
    // 插件 Skill（U5）:解析已启用 + 授信 + 去重的 skill 目录,经 --skill 注入;集合变化经
    // extensionFingerprint 触发会话重开。useOwnSkills===false → 会话级一键关 → []。
    const skillPaths = await resolveEnabledSkillPaths(bridge, projectPath, session.useOwnSkills);
    const opened = await ensurePiSession(
      bridge,
      {
        uiSessionId: session.id,
        cwd: projectPath,
        model,
        useOwnSkills: session.useOwnSkills,
        skillPaths,
        provider: provider
          ? {
              id: provider.id,
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              endpointFormat: provider.endpointFormat,
              // ProviderModelOption 用 label,pi 端用 name → 此处映射;并带上 per-model 能力标记
              // (reasoning/vision/contextTokens),供 renderPiExtension 渲染高级配置。
              models: provider.models.map((m) => ({
                id: m.id,
                name: m.label,
                reasoning: m.reasoning,
                vision: m.vision,
                contextTokens: m.contextTokens,
              })),
            }
          : undefined,
        enableToolApproval: piCustom?.toolApproval || undefined,
        // 审批清单:仅总开关开时下发。空数组 [] 原样穿透(=不审批任何工具),禁用 ?? DEFAULT
        // 兜回默认——undefined→默认三件 是 renderApprovalExtension 默认参的职责,不在此抢。
        approvalTools: piCustom?.toolApproval ? piCustom.approvalTools : undefined,
        enableSampleTools: piCustom?.sampleTools || undefined,
        enableSampleCommands: piCustom?.sampleCommands || undefined,
        appendSystemPrompt: piSystemPrompt || undefined,
        thinkingLevel,
      },
      // 阶段4 恢复:此前持久化过 sessionFile（崩溃/空闲/LRU/app 重启后会话内存态没了）→
      // 重开后 switchSession 从磁盘 JSONL 恢复上下文（best-effort）。首轮全新会话无 file → 不恢复。
      { resumeFrom: session.piSessionFile },
    );
    // 持久 sessionFile 到 SessionMeta,供后续任何重开恢复。
    if (opened.sessionFile && opened.sessionFile !== session.piSessionFile) {
      usePersonalStore.getState().updateSession(session.id, { piSessionFile: opened.sessionFile });
    }
    flipPiRunToThinking(qc, runId); // 冷启就绪 → typing 翻「思考中」。
    touchPiSession(bridge, session.id); // 阶段4:发起一轮 = 活跃,启动/重置空闲计时。
    // 传 runId（阶段4 代际）:主进程绑定到本轮,事件回带,renderer 守卫丢弃旧轮串台事件。
    await promptPi(bridge, session.id, buildPiPromptMessage(text, appendSystemPrompt), runId);
    autoTitle(bridge, session, text); // pi 走 fallback 截断标题（autoTitle 内部仅 claude 跑 haiku）。
  } catch (err) {
    failPiTurn(qc, session.id, runId, err);
  }
}

// 编辑重发的 pi 分支:经 getForkMessages 定位编辑轮在 pi 侧的 entryId 并 fork（替代单发的
// trimAgentSession 截断会话文件）。pi 侧 entry.text 可能含内联系统提示前缀,故按「后缀匹配」+
// 同文序号定位。映射失败/会话未开 → 返回 false（调用方退化为只截断 UI + 重发,不 fork）。
function piEntryMatchesText(entryText: string, originalText: string): boolean {
  const a = entryText.trim();
  const b = originalText.trim();
  if (a === b) return true;
  // pi 侧 entry 可能含 buildPiPromptMessage 内联的系统提示前缀（`${appendSystemPrompt}\n\n${text}`）。
  // 收紧:要求「\n\n + 原文」结尾（前缀块与原文以 \n\n 分隔），比裸 endsWith 稳——避免误命中
  // 「尾串恰好等于原文但中间无分隔」的别条。
  return a.endsWith(`\n\n${b}`);
}

async function forkPiAtEditedMessage(
  bridge: DesktopBridge,
  sessionId: string,
  prevMessages: Message[],
  msgUid: string,
): Promise<boolean> {
  if (!isPiSessionOpen(sessionId) || !bridge.piGetForkMessages) return false;
  const original = prevMessages.find((m) => m.uid === msgUid);
  const originalText = original?.kind === "text" && typeof original.text === "string" ? original.text : undefined;
  if (!originalText) return false;
  const data = (await getForkMessagesPi(bridge, sessionId)) as
    | { messages?: Array<{ entryId: string; text: string }> }
    | undefined;
  const entries = data?.messages ?? [];
  const matches = entries.filter((e) => piEntryMatchesText(e.text, originalText));
  if (matches.length === 0) return false;
  // 同文序号:UI 里相同原文的第几条 → fork 列表里相同原文的第几条（越界回退到末条）。
  const ordinal = sameTextOrdinal(prevMessages, msgUid, originalText);
  const target = matches[ordinal >= 0 && ordinal < matches.length ? ordinal : matches.length - 1];
  if (!target) return false;
  await forkPi(bridge, sessionId, target.entryId);
  return true;
}

// ── session 标题自动生成 ──────────────────────────────────────────────────
const DEFAULT_TITLE = /^Session \d+$/;

function fallbackTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 16 ? clean.slice(0, 16) + "…" : clean || "新会话";
}

function sanitizeTitle(raw: string): string {
  // 取最后一个非空行（防模型偶尔带前言）,去引号/标点收尾。
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] ?? "").replace(/^["'“”《]+|["'“”》。,.!?]+$/g, "").trim();
  return last.length > 24 ? last.slice(0, 24) : last;
}

// 首条消息发出后:先用截断文本占位,再用 haiku 异步生成概括标题（不阻塞会话）。
function autoTitle(bridge: DesktopBridge, session: SessionMeta, text: string): void {
  if (!DEFAULT_TITLE.test(session.title)) return;
  const fallback = fallbackTitle(text);
  usePersonalStore.getState().updateSession(session.id, { title: fallback });
  if (session.agent !== "claude") return;
  void bridge
    .oneshotCli({
      // 不传 cwd:在中性目录运行,不加载项目上下文,不与正式会话抢资源。
      prompt: `为下面这个用户请求生成一个简短的中文标题,不超过12个字,只输出标题本身,不要任何引号、标点或解释:\n\n${text.slice(0, 500)}`,
      model: "haiku",
    })
    .then((raw) => {
      const title = sanitizeTitle(raw);
      if (!title) return;
      const store = usePersonalStore.getState();
      const current = store.sessions.find((x) => x.id === session.id);
      // 仅当标题仍是占位值时替换,避免覆盖之后的修改。
      if (current && current.title === fallback) store.updateSession(session.id, { title });
    })
    .catch(() => {
      // 生成失败保留截断占位标题。
    });
}

// ── Hooks ─────────────────────────────────────────────────────────────────

// 全局只挂一次（PersonalWorkspace 根部）：订阅主进程 CLI 事件。
export function usePersonalCliEvents(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge) return;
    bridgeRef = bridge;
    const offEvent = bridge.onCliEvent((runId, ev, sessionId) => handleCliEvent(qc, runId, ev, sessionId));
    const offExit = bridge.onCliExit((exit) => handleCliExit(qc, exit.runId, exit.code, exit.error, exit.sessionId));
    return () => {
      bridgeRef = null;
      offEvent();
      offExit();
    };
  }, [bridge, qc]);
}

// 全局只挂一次（PersonalWorkspace 根部，与 usePersonalCliEvents 并列）：订阅 pi RPC 事件流。
// 单订阅按 uiSessionId 分派到 handlePiEvent（多会话隔离）。bridge 无 onPiEvent（web/旧壳）时
// 整体 no-op，pi 退回单发或隐藏运行时控制。
export function usePersonalPiEvents(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge?.onPiEvent) return;
    // bridgeRef 通常已由 usePersonalCliEvents 设置;此处兜底确保 handlePiEvent 的落盘可用。
    bridgeRef = bridge;
    // 阶段4:给 pi-session 进程层注入「是否有活跃轮」谓词 + 回收收尾回调（进程层不能反向依赖 store/qc）。
    // 空闲回收/LRU 据此跳过繁忙会话,被迫逐出时经 reapSessionRun 收尾 renderer run。
    setPiLifecycleHooks({
      isBusy: (sessionId) => !!usePersonalStore.getState().runningBySession[sessionId],
      onReclaim: (sessionId) => reapSessionRun(qc, sessionId),
    });
    const off = bridge.onPiEvent((sessionId, ev, runId) => handlePiEvent(qc, sessionId, ev, runId));
    return () => off();
  }, [bridge, qc]);
}

// 全局只挂一次（PersonalWorkspace 根部）：订阅 pi extension UI 请求 → 入队 store，由确认弹窗消费。
// bridge 无 onPiUiRequest（web/旧壳）时整体 no-op（pi extension 的 confirm 走 pi 侧 timeout 默认）。
export function usePersonalPiUi(): void {
  const bridge = useDesktopBridge();
  useEffect(() => {
    if (!bridge?.onPiUiRequest) return;
    const off = bridge.onPiUiRequest((uiSessionId, request) => {
      // confirm（阶段3 模态）与 askquestion（输入框上方富卡片）入队渲染。
      if (request.method === "confirm" || request.method === "askquestion") {
        usePersonalStore.getState().pushPiUiRequest({ uiSessionId, request });
      } else if (request.method === "select" || request.method === "input" || request.method === "editor") {
        // 同属阻断式(pi await 应答)但本阶段未渲染 UI → 立即回 cancelled 解除 pi 侧 await,
        // 否则该轮永久卡死。fire-and-forget 类(notify/setStatus/setWidget/...)无需回写,忽略。
        respondPiUi(bridge, uiSessionId, request.id, { cancelled: true });
      }
    });
    return () => off();
  }, [bridge]);
}

// 回应一条 pi extension UI 请求:回写给 pi（confirm/value/cancelled）+ 出队。失败静默（会话已退则作废）。
export function respondPiUi(
  bridge: DesktopBridge | null,
  uiSessionId: string,
  id: string,
  payload: PiUiResponsePayload,
): void {
  usePersonalStore.getState().resolvePiUiRequest(id);
  void bridge?.piUiResponse?.(uiSessionId, id, payload).catch(() => undefined);
}

// 把 AskQuestionCard 每组的选择（选项下标 或 自定义文本）按 KTD-5 互斥规则归一成 AskQuestionAnswers
// JSON 串,经 {value} 回写 pi。custom 非空优先（自定义=「其他」);否则取选项 label。纯函数:无
// react-dom/localStorage/process.env 依赖,可独立单测（喂结构断言结构）。
export function serializeAskQuestionAnswers(
  envelope: AskQuestionEnvelope,
  selections: Record<string, { optionIndex?: number; custom?: string }>,
): string {
  const answers: AskQuestionAnswers["answers"] = [];
  for (const group of envelope.groups) {
    const sel = selections[group.id];
    if (!sel) continue;
    const custom = typeof sel.custom === "string" ? sel.custom.trim() : "";
    if (custom) {
      answers.push({ groupId: group.id, value: custom, isCustom: true });
    } else if (sel.optionIndex != null && sel.optionIndex >= 0 && sel.optionIndex < group.options.length) {
      answers.push({ groupId: group.id, value: group.options[sel.optionIndex]!.label, isCustom: false });
    }
  }
  return JSON.stringify({ answers });
}

// 确保某 session 的消息缓存已从磁盘加载（发送前调用，防止首条写入被覆盖）。
//
// 用 ensureQueryData 而非自起一次 loadChat:与 usePersonalChat 的 useQuery 共享同一在途
// 请求（React Query 按 queryKey 去重）。否则「即建即发」场景（Spotlight 接力、新会话落地页
// NewSessionLanding —— 均 createSession 后同一 tick 立刻 send）会有两个并发的 loadChat:
// ensureChatLoaded 自己的先 resolve、追加首条用户消息后,useQuery 那个晚到的 loadChat 才
// resolve 空历史,把刚写入的用户消息覆盖成空——表现为主窗体会话里看不到用户发出的那条消息。
async function ensureChatLoaded(qc: QueryClient, bridge: DesktopBridge, sessionId: string): Promise<void> {
  // 历史加载也做瞬态清理（双保险:崩溃时可能存了未收尾状态）。
  await qc.ensureQueryData<Message[]>({
    queryKey: personalChatKeys.detail(sessionId),
    queryFn: async () => sanitizeForSave((await bridge.loadChat(sessionId)) as Message[]),
  });
}

export function __ensureChatLoadedForTest(
  qc: QueryClient,
  bridge: DesktopBridge,
  sessionId: string,
): Promise<void> {
  return ensureChatLoaded(qc, bridge, sessionId);
}

export function usePersonalChat(sessionId: string | undefined): PersonalChatSlice {
  const bridge = useDesktopBridge();
  const hiddenHistory = usePersonalStore(
    (s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.hiddenHistory : undefined),
  );
  const { data } = useQuery<Message[]>({
    queryKey: personalChatKeys.detail(sessionId ?? "none"),
    // 历史消息从磁盘加载（web 端无桥,恒为空）;加载时清理瞬态状态。
    queryFn: async () =>
      bridge && sessionId ? sanitizeForSave((await bridge.loadChat(sessionId)) as Message[]) : [],
    enabled: !!sessionId,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const all = data ?? [];
  return splitPersonalMessages(all, hiddenHistory);
}

// 编辑重发:截断到目标消息之前(目标消息本身也移除,由重发的新消息替代)。
// 找不到目标返回 null(调用方放弃操作)。
export function truncateForEdit(messages: Message[], msgUid: string): Message[] | null {
  const idx = messages.findIndex((m) => m.uid === msgUid);
  return idx < 0 ? null : messages.slice(0, idx);
}

// 同文序号:相同原文的用户消息里,目标是第几条(0-based;未找到返回 -1)。
// 用于在 CLI 会话文件中精确定位「重复发过同样内容」时要截断的那一轮。
export function sameTextOrdinal(messages: Message[], msgUid: string, text: string): number {
  return messages
    .filter((m) => m.kind === "text" && m.who === "me" && m.text === text)
    .findIndex((m) => m.uid === msgUid);
}

export interface PersonalActions {
  send: (
    session: SessionMeta,
    projectPath: string,
    text: string,
    attachments: PersonalAttachment[],
    extraSystemPrompt?: string,
  ) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  // pi 运行中插话:把引导注入当前轮（仅 pi 会话有效;非 pi/未运行 no-op）。
  steer: (sessionId: string, text: string) => Promise<void>;
  // pi 运行时切模型:更新会话记忆 + 会话已开则实时下发（未开仅记忆,下次 open 生效）。
  setPiModel: (session: SessionMeta, providerId: string, model: string) => void;
  // pi 运行时切思考强度:更新会话记忆 + 会话已开则实时下发（不重开;未开仅记忆,下次 open 经 --thinking 生效）。
  setPiThinking: (session: SessionMeta, level: ThinkingLevel) => void;
  // 编辑重发:清除目标用户消息及其后的全部消息,以新文本重新发送。
  editResend: (
    session: SessionMeta,
    projectPath: string,
    msgUid: string,
    text: string,
    attachments: PersonalAttachment[],
  ) => Promise<void>;
  // /clear:默认隐藏当前历史;磁盘历史保留,重启后仍从隐藏游标后显示。
  clearView: (sessionId: string) => void;
}

export function usePersonalActions(): PersonalActions {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();

  const send = useCallback<PersonalActions["send"]>(
    async (session, projectPath, text, attachments, extraSystemPrompt) => {
      if (!bridge || !text.trim()) return;
      if (session.agent === "pi" && !piRpcAvailable(bridge)) {
        await ensureChatLoaded(qc, bridge, session.id);
        appendUserMessage(qc, session.id, text, attachments);
        appendMsg(qc, session.id, {
          kind: "text",
          who: "pi",
          time: realHHMM(),
          text: `⚠️ pi 会话启动失败：${piRpcUnavailableMessage(bridge)}`,
          uid: uid("err"),
        });
        flushChat(qc, session.id);
        return;
      }
      // pi 长驻会话:同会话已有在跑的一轮、或一轮正在启动(同步锁)时不再起新轮（pi 冷启 ~790ms
      // 窗口里 Enter 抖动/并发 send 会造孤儿 run + 永不自杀的看门狗;运行中 UI 也只应能停止/插话）。
      if (session.agent === "pi") {
        if (usePersonalStore.getState().runningBySession[session.id] || piSendStarting.has(session.id)) return;
        piSendStarting.add(session.id);
      }
      const runId = uid("run");
      const typingUid = uid("typing");

      // 历史尚未加载时先加载,避免首条写入把磁盘历史盖掉。
      await ensureChatLoaded(qc, bridge, session.id);

      appendUserMessage(qc, session.id, text, attachments);
      appendMsg(qc, session.id, {
        kind: "typing",
        who: session.agent,
        text: typingText(session.agent, "starting", 0),
        uid: typingUid,
      });

      const attachmentPrompt = buildAttachmentSystemPrompt(attachments);
      // 项目信息（Spotlight 注入）在前、附件 skills/todos 在后;两者皆空仍传 undefined。
      const appendSystemPrompt = [extraSystemPrompt, attachmentPrompt].filter(Boolean).join("\n\n") || undefined;

      // pi 走 RPC 长驻会话（steer/abort/fork);claude/codex 仍走下面单发 startCli 管线。
      if (session.agent === "pi") {
        await sendPiTurn(qc, bridge, session, projectPath, text, appendSystemPrompt, { runId, typingUid });
        return;
      }

      const run: RunState = {
        sessionId: session.id,
        agent: session.agent,
        typingUid,
        cursor: emptyFoldCursor(),
        sawText: false,
        buffer: "",
        gotResult: false,
        phase: "starting",
        lastEventAt: Date.now(),
        promptText: text,
        startedAt: Date.now(),
        cwd: projectPath,
      };
      runs.set(runId, run);
      // 看门狗:每秒刷新 typing 等待时长;启动/静默超时则杀进程并提示重试。
      run.watchdog = setInterval(() => {
        const cur = runs.get(runId);
        if (!cur) return;
        const silent = Date.now() - cur.lastEventAt;
        const limit = cur.phase === "starting" ? RUN_START_TIMEOUT_MS : RUN_STALL_TIMEOUT_MS;
        if (!cur.gotResult && silent >= limit) {
          stopWatchdog(cur);
          runs.delete(runId);
          dropMsg(qc, cur.sessionId, cur.typingUid);
          clearTransient(qc, cur.sessionId);
          appendMsg(qc, cur.sessionId, {
            kind: "text",
            who: cur.agent,
            time: realHHMM(),
            text:
              cur.phase === "starting"
                ? `⚠️ 启动超时：${Math.round(limit / 1000)} 秒内没有收到 ${AGENT_NAME[cur.agent]} 的任何响应,已停止本次调用。请检查 CLI 是否正常,然后把鼠标移到刚才的消息上点「编辑重发」重试。`
                : `⚠️ 响应超时：${Math.round(limit / 1000)} 秒没有新的输出,已停止本次调用。可把鼠标移到刚才的消息上点「编辑重发」重试。`,
            uid: uid("err"),
          });
          usePersonalStore.getState().setRunning(cur.sessionId, undefined);
          usePetStore.getState().set("idle");
          flushChat(qc, cur.sessionId);
          // 深化:启动/静默超时属终态失败,回落该 session 的 deepening 闪记（普通会话 no-op）。
          void applyDeepenFinalize(bridgeRef, {
            sessionId: cur.sessionId,
            cwd: cur.cwd,
            terminalFailure: true,
          });
          void bridgeRef?.killCli(runId);
          return;
        }
        // 仍在等首个输出:typing 占位上滚动显示已等待时长。
        if (!cur.cursor.lastKind && !cur.gotResult && cur.startedAt) {
          updateTypingMsg(qc, cur.sessionId, cur.typingUid, typingText(cur.agent, cur.phase, Date.now() - cur.startedAt));
        }
      }, 1000);
      usePersonalStore.getState().setRunning(session.id, runId);
      usePetStore.getState().set("thinking");

      try {
        let resumeSessionId = sessionResumeId(session);
        let sendSession = session;
        if (resumeSessionId && bridge.agentSessionExists) {
          const exists = await bridge.agentSessionExists({ agent: session.agent, agentSessionId: resumeSessionId });
          if (!exists) {
            const patch = clearAgentSessionPatch(session, session.agent);
            usePersonalStore.getState().updateSession(session.id, patch);
            sendSession = { ...session, ...patch };
            resumeSessionId = undefined;
          }
        }

        // 插件 Skill（U5）:仅 pi 单发路径解析注入 skillPaths（claude/codex adapter 忽略,
        // 且不必为它们空扫目录）。RPC 路径在 sendPiTurn 另行注入。
        const skillPaths =
          sendSession.agent === "pi"
            ? await resolveEnabledSkillPaths(bridge, projectPath, sendSession.useOwnSkills)
            : undefined;
        await bridge.startCli({
          runId,
          sessionId: sendSession.id,
          agent: sendSession.agent,
          cwd: projectPath,
          prompt: text,
          model: sendSession.model,
          resumeSessionId,
          appendSystemPrompt,
          useOwnSkills: sendSession.useOwnSkills,
          skillPaths,
        });
        // 主对话 spawn 成功后再异步生成标题（CLI 缺失时不会白跑）。
        autoTitle(bridge, sendSession, text);
      } catch (err) {
        handleCliExit(qc, runId, null, err instanceof Error ? err.message : String(err));
      }
    },
    [bridge, qc],
  );

  const editResend = useCallback<PersonalActions["editResend"]>(
    async (session, projectPath, msgUid, text, attachments) => {
      if (!bridge || !text.trim()) return;
      // 运行中不允许编辑历史(先停止再说),避免与流式写入打架。
      if (usePersonalStore.getState().runningBySession[session.id]) return;
      await ensureChatLoaded(qc, bridge, session.id);
      const prev = qc.getQueryData<Message[]>(personalChatKeys.detail(session.id)) ?? [];
      const truncated = truncateForEdit(prev, msgUid);
      if (truncated === null) return;

      // pi:在 pi 侧 fork 到分支点（替代 trimAgentSession 截断会话文件）,再以新文本重发。
      // 映射失败/会话未开 → best-effort 退化:只截断 UI + 重发（pi 仍带旧记忆,阶段2 取舍）。
      if (session.agent === "pi") {
        const forked = await forkPiAtEditedMessage(bridge, session.id, prev, msgUid).catch(() => false);
        qc.setQueryData<Message[]>(personalChatKeys.detail(session.id), truncated);
        // fork 退化（会话未开/定位失败）→ pi 仍带旧记忆,给用户可见提示,避免「以为截断了实则没」。
        if (!forked) {
          appendMsg(qc, session.id, {
            kind: "text",
            who: "pi",
            time: realHHMM(),
            text: "⚠️ 未能在 pi 侧定位编辑点,已带原有上下文重发（pi 仍记得被编辑前的内容）。",
            uid: uid("err"),
          });
        }
        flushChat(qc, session.id);
        await send(session, projectPath, text, attachments);
        return;
      }

      // 同步清理 agent 侧记忆,让它和 UI 一致:
      // - 编辑的是第一条 → 直接丢弃 resume id,重开全新会话(记忆天然干净);
      // - 否则尽力截断 CLI 会话文件中该轮及其后内容(.bak 备份;按原文+同文序号
      //   严格匹配,失败则静默退化为带旧记忆 resume)。
      let sendSession = session;
      const original = prev.find((m) => m.uid === msgUid);
      const originalText = original?.kind === "text" && typeof original.text === "string" ? original.text : undefined;
      const resumeId = sessionResumeId(session);
      if (truncated.length === 0) {
        const patch = clearAgentSessionPatch(session, session.agent);
        usePersonalStore.getState().updateSession(session.id, patch);
        sendSession = { ...session, ...patch };
      } else if (resumeId && originalText && bridge.trimAgentSession) {
        await bridge
          .trimAgentSession({
            agent: session.agent,
            agentSessionId: resumeId,
            promptText: originalText,
            occurrence: sameTextOrdinal(prev, msgUid, originalText),
          })
          .catch(() => false);
      }

      qc.setQueryData<Message[]>(personalChatKeys.detail(session.id), truncated);
      flushChat(qc, session.id);
      await send(sendSession, projectPath, text, attachments);
    },
    [bridge, qc, send],
  );

  const stop = useCallback<PersonalActions["stop"]>(
    async (sessionId) => {
      const store = usePersonalStore.getState();
      const runId = store.runningBySession[sessionId];
      if (!bridge || !runId) return;
      const session = store.sessions.find((x) => x.id === sessionId);
      if (session?.agent === "pi") {
        // pi:优雅打断当前轮（不杀长驻进程;收尾由 error/result 事件驱动,下面 4 秒兜底复位）。
        // try/catch 兼顾同步抛（会话未就绪）与异步拒（会话已退出）,均靠兜底复位 UI。
        try {
          await abortPi(bridge, sessionId);
        } catch {
          /* 会话未就绪/已退出,忽略,靠下面兜底 */
        }
      } else {
        await bridge.killCli(runId);
      }
      // 兜底:若 4 秒内没收到收尾事件（进程早已不在/事件丢失）,强制复位 UI。
      // 仅当本次捕获的 runId 仍是当前轮才清,且只删该 runId（不扫该会话全部 run,避免误掐
      // 期间已开的新一轮）。
      setTimeout(() => {
        const store = usePersonalStore.getState();
        if (store.runningBySession[sessionId] === runId) {
          const r = runs.get(runId);
          if (r) {
            stopRunTimers(r);
            runs.delete(runId);
          }
          store.setRunning(sessionId, undefined);
          store.setPiRuntime(sessionId, undefined);
          clearTransient(qc, sessionId);
          flushChat(qc, sessionId);
        }
      }, 4000);
    },
    [bridge, qc],
  );

  const steer = useCallback<PersonalActions["steer"]>(
    async (sessionId, text) => {
      if (!bridge || !text.trim()) return;
      const session = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
      if (session?.agent !== "pi") return;
      // 会话尚未就绪（冷启 ~790ms 窗口）时不回显也不注入:否则会留一条 pi 永不响应的孤立气泡。
      if (!isPiSessionOpen(sessionId)) return;
      // 把插话作为用户消息回显（让会话能看到注入了什么）,再注入当前轮;队列计数由 queue 事件回显。
      appendMsg(qc, sessionId, { kind: "text", who: "me", time: realHHMM(), text, uid: uid("u") });
      touchPiSession(bridge, sessionId); // 阶段4:插话 = 活跃。
      try {
        await steerPi(bridge, sessionId, text);
      } catch {
        /* 会话已退出:忽略 */
      }
    },
    [bridge, qc],
  );

  const setPiModel = useCallback<PersonalActions["setPiModel"]>(
    (session, providerId, model) => {
      const prev = { providerId: session.providerId, model: session.model };
      usePersonalStore.getState().updateSession(session.id, { providerId, model });
      // 会话已开 → 实时切换（pi 长驻进程无需重启）;未开仅记忆,下次 open 即用新模型。
      // 实时下发失败不再静默吞:回滚会话记忆 + 提示,避免「UI 显新模型、pi 实际仍旧模型」漂移。
      if (session.agent === "pi" && bridge && isPiSessionOpen(session.id)) {
        void setModelPi(bridge, session.id, providerId, model).catch(() => {
          usePersonalStore.getState().updateSession(session.id, prev);
          appendMsg(qc, session.id, {
            kind: "text",
            who: "pi",
            time: realHHMM(),
            text: "⚠️ 切换模型失败,已回滚到原模型。",
            uid: uid("err"),
          });
        });
      }
    },
    [bridge, qc],
  );

  const setPiThinking = useCallback<PersonalActions["setPiThinking"]>(
    (session, level) => {
      const prev = { thinkingLevel: session.thinkingLevel };
      usePersonalStore.getState().updateSession(session.id, { thinkingLevel: level });
      // 会话已开 → 运行时切档（不重启,不进指纹）;未开仅记忆,下次 open 经 --thinking 生效。
      // 下发失败回滚 + 提示,避免「UI 显新档、pi 实际仍旧档」漂移。
      if (session.agent === "pi" && bridge && isPiSessionOpen(session.id)) {
        void setThinkingLevelPi(bridge, session.id, level).catch(() => {
          usePersonalStore.getState().updateSession(session.id, prev);
          appendMsg(qc, session.id, {
            kind: "text",
            who: "pi",
            time: realHHMM(),
            text: "⚠️ 切换思考强度失败,已回滚。",
            uid: uid("err"),
          });
        });
      }
    },
    [bridge, qc],
  );

  const clearView = useCallback<PersonalActions["clearView"]>(
    (sessionId) => {
      const messages = qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
      usePersonalStore.getState().updateSession(sessionId, { hiddenHistory: createHiddenHistory(messages) });
    },
    [qc],
  );

  return { send, stop, steer, setPiModel, setPiThinking, editResend, clearView };
}
