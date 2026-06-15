// 个人工作区会话消息层。消息流存 React Query cache（key 按 sessionId 隔离），
// CLI 流式事件（经 DesktopBridge）增量写入缓存：
//   typing 占位 → 首个事件后替换为流式 text / agentLog → result/exit 落定。
// 多轮：init 捕获 agent session id 写回 SessionMeta，下一轮 resume。

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Message } from "../types";
import type { AgentKind, CliStreamEvent, HiddenHistoryMeta, ProjectMeta, SessionMeta } from "../desktop/types";
import type { DesktopBridge } from "../desktop/bridge";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import { usePetStore } from "../store/pet";
import { extractChangedFile, promptTitle, clipSummary, recordTimelineEvent } from "./timeline";
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
}

const runs = new Map<string, RunState>();

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
  bridgeRef = null;
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
      const runId = uid("run");
      const typingUid = uid("typing");

      // 历史尚未加载时先加载,避免首条写入把磁盘历史盖掉。
      await ensureChatLoaded(qc, bridge, session.id);

      appendMsg(qc, session.id, {
        kind: "text",
        who: "me",
        time: realHHMM(),
        text,
        // 拖入的 skill/todo 仅注入 system prompt;这里同步把引用元数据存进消息,让会话气泡能回显。
        attachments: attachments.length ? attachments.map((a) => ({ name: a.name, kind: a.kind })) : undefined,
        uid: uid("u"),
      });
      appendMsg(qc, session.id, {
        kind: "typing",
        who: session.agent,
        text: typingText(session.agent, "starting", 0),
        uid: typingUid,
      });

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

      const attachmentPrompt = buildAttachmentSystemPrompt(attachments);
      // 项目信息（Spotlight 注入）在前、附件 skills/todos 在后;两者皆空仍传 undefined。
      const appendSystemPrompt = [extraSystemPrompt, attachmentPrompt].filter(Boolean).join("\n\n") || undefined;

      // pi 兜底 Agent:按会话选中的供应商（或默认 provider）拍平传入主进程,
      // 由主进程生成 extension + 注入 key env;model 取会话模型/默认模型/provider 首模型。
      const providerSettings = usePersonalStore.getState().providerSettings;
      const isPi = session.agent === "pi";
      // 只解析「已启用」的 provider（与 UI 下拉、automation runner 一致）;停用/失效则
      // 落空,pi 走自身内置默认 provider,不会用停用凭据运行。
      const provider = isPi
        ? providerSettings.providers.find(
            (p) => p.id === (session.providerId ?? providerSettings.defaultProviderId) && p.enabled,
          )
        : undefined;
      const piModel = isPi
        ? session.model ?? providerSettings.defaultModel ?? provider?.models[0]?.id
        : session.model;

      try {
        let resumeSessionId = sessionResumeId(session);
        let sendSession = session;
        if (resumeSessionId && session.agent !== "pi" && bridge.agentSessionExists) {
          const exists = await bridge.agentSessionExists({ agent: session.agent, agentSessionId: resumeSessionId });
          if (!exists) {
            const patch = clearAgentSessionPatch(session, session.agent);
            usePersonalStore.getState().updateSession(session.id, patch);
            sendSession = { ...session, ...patch };
            resumeSessionId = undefined;
          }
        }

        await bridge.startCli({
          runId,
          sessionId: sendSession.id,
          agent: sendSession.agent,
          cwd: projectPath,
          prompt: text,
          model: piModel,
          resumeSessionId,
          appendSystemPrompt,
          useOwnSkills: sendSession.useOwnSkills,
          provider: provider
            ? { id: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey, models: provider.models }
            : undefined,
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
      const runId = usePersonalStore.getState().runningBySession[sessionId];
      if (!bridge || !runId) return;
      await bridge.killCli(runId);
      // 兜底:若 4 秒内没收到 exit 事件（进程早已不在/事件丢失）,强制复位 UI。
      setTimeout(() => {
        const store = usePersonalStore.getState();
        if (store.runningBySession[sessionId] === runId) {
          runs.forEach((r, id) => {
            if (r.sessionId === sessionId) {
              stopWatchdog(r);
              runs.delete(id);
            }
          });
          store.setRunning(sessionId, undefined);
          clearTransient(qc, sessionId);
          flushChat(qc, sessionId);
        }
      }, 4000);
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

  return { send, stop, editResend, clearView };
}
