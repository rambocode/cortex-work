// 个人工作区会话消息层。消息流存 React Query cache（key 按 sessionId 隔离），
// CLI 流式事件（经 DesktopBridge）增量写入缓存：
//   typing 占位 → 首个事件后替换为流式 text / agentLog → result/exit 落定。
// 多轮：init 捕获 agent session id 写回 SessionMeta，下一轮 resume。

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Message } from "../types";
import type { AgentKind, CliStreamEvent, HiddenHistoryMeta, SessionMeta } from "../desktop/types";
import type { DesktopBridge } from "../desktop/bridge";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import { usePetStore } from "../store/pet";
import { extractChangedFile, promptTitle, clipSummary, recordTimelineEvent } from "./timeline";

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
  textUid?: string; // 流式 text 消息
  logUid?: string; // 工具步骤 agentLog 消息
  buffer: string;
  gotResult: boolean;
  // 时间线采集：prompt 首行 / 起始时间 / 项目路径 / 写类工具触碰的文件。
  promptText?: string;
  startedAt?: number;
  cwd?: string;
  changedFiles?: Set<string>;
}

const runs = new Map<string, RunState>();

export function sessionResumeId(session: SessionMeta): string | undefined {
  return session.agentSessionIds?.[session.agent] ?? (session.agent === "claude" ? session.claudeSessionId : undefined);
}

export function agentSessionPatch(session: SessionMeta, agent: AgentKind, id: string): Partial<SessionMeta> {
  const agentSessionIds = { ...session.agentSessionIds, [agent]: id };
  return agent === "claude" ? { agentSessionIds, claudeSessionId: id } : { agentSessionIds };
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
      buffer: "",
      gotResult: false,
    };
    runs.set(runId, run);
    usePersonalStore.getState().setRunning(sessionIdHint, runId);
  }
  const { sessionId } = run;

  if (ev.type === "init") {
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
    const itemText = ev.detail ? `${ev.name} · ${ev.detail}` : ev.name;
    if (!run.logUid) {
      run.logUid = uid("log");
      appendMsg(qc, sessionId, {
        kind: "agentLog",
        who: run.agent,
        time: realHHMM(),
        title: "Agent 正在执行",
        active: true,
        uid: run.logUid,
        items: [{ ic: "running", text: itemText }],
      });
    } else {
      setMessages(qc, sessionId, (prev) =>
        prev.map((m) =>
          m.uid === run.logUid && m.kind === "agentLog"
            ? {
                ...m,
                items: [...m.items.map((it) => ({ ...it, ic: "check" as const })), { ic: "running", text: itemText }],
              }
            : m,
        ),
      );
    }
    return;
  }

  if (ev.type === "text") {
    usePetStore.getState().set("replying");
    dropMsg(qc, sessionId, run.typingUid);
    run.buffer += ev.delta;
    if (!run.textUid) {
      run.textUid = uid("at");
      appendMsg(qc, sessionId, { kind: "text", who: run.agent, time: realHHMM(), text: run.buffer, uid: run.textUid });
    } else {
      setMessages(qc, sessionId, (prev) =>
        prev.map((m) => (m.uid === run.textUid && m.kind === "text" ? { ...m, text: run.buffer } : m)),
      );
    }
    return;
  }

  if (ev.type === "result") {
    run.gotResult = true;
    dropMsg(qc, sessionId, run.typingUid);
    // 收尾 agentLog：全部步骤打勾。
    if (run.logUid) {
      setMessages(qc, sessionId, (prev) =>
        prev.map((m) =>
          m.uid === run.logUid && m.kind === "agentLog"
            ? { ...m, active: false, completed: true, title: "Agent 执行完成", items: m.items.map((it) => ({ ...it, ic: "check" as const })) }
            : m,
        ),
      );
    }
    if (!ev.ok) {
      appendMsg(qc, sessionId, {
        kind: "text",
        who: run.agent,
        time: realHHMM(),
        text: `⚠️ 执行出错：${ev.error || "未知错误"}`,
        uid: uid("err"),
      });
    } else if (!run.textUid && ev.text) {
      // 没收到增量文本（极少数情况），用 result 的最终文本兜底。
      appendMsg(qc, sessionId, { kind: "text", who: run.agent, time: realHHMM(), text: ev.text, uid: uid("at") });
    }
  }
}

function handleCliExit(
  qc: QueryClient,
  runId: string,
  code: number | null,
  error?: string,
  sessionIdHint?: string,
): void {
  const run = runs.get(runId);
  if (!run) {
    // 注册表丢失（重载）时按 sessionId 兜底清理,保证 UI 不卡死。
    if (sessionIdHint) {
      clearTransient(qc, sessionIdHint);
      const store = usePersonalStore.getState();
      if (store.runningBySession[sessionIdHint] === runId) store.setRunning(sessionIdHint, undefined);
      flushChat(qc, sessionIdHint);
      usePetStore.getState().set("idle");
    }
    return;
  }
  runs.delete(runId);
  const { sessionId } = run;
  dropMsg(qc, sessionId, run.typingUid);
  usePersonalStore.getState().setRunning(sessionId, undefined);

  if (!run.gotResult && (error || (code !== null && code !== 0))) {
    const friendly =
      error && /ENOENT/.test(error)
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
  usePetStore.getState().set(run.gotResult ? "happy" : "idle");

  // 时间线：记录这一轮 run 事件（恢复型 run 无 prompt,用回复首行兜底）。
  const session = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
  if (session) {
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
        ok: run.gotResult && !error && (code === null || code === 0),
        durationMs: run.startedAt ? Date.now() - run.startedAt : undefined,
      },
    });
  }
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

// 确保某 session 的消息缓存已从磁盘加载（发送前调用，防止历史被覆盖）。
async function ensureChatLoaded(qc: QueryClient, bridge: DesktopBridge, sessionId: string): Promise<void> {
  const key = personalChatKeys.detail(sessionId);
  if (qc.getQueryData(key) !== undefined) return;
  // 历史加载也做瞬态清理（双保险:崩溃时可能存了未收尾状态）。
  const history = sanitizeForSave((await bridge.loadChat(sessionId)) as Message[]);
  // 加载期间可能已有写入,以已有缓存优先。
  qc.setQueryData<Message[]>(key, (prev) => prev ?? history);
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

export interface PersonalActions {
  send: (session: SessionMeta, projectPath: string, text: string, attachments: PromptAttachment[]) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  // /clear:默认隐藏当前历史;磁盘历史保留,重启后仍从隐藏游标后显示。
  clearView: (sessionId: string) => void;
}

export function usePersonalActions(): PersonalActions {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();

  const send = useCallback<PersonalActions["send"]>(
    async (session, projectPath, text, attachments) => {
      if (!bridge || !text.trim()) return;
      const runId = uid("run");
      const typingUid = uid("typing");

      // 历史尚未加载时先加载,避免首条写入把磁盘历史盖掉。
      await ensureChatLoaded(qc, bridge, session.id);

      appendMsg(qc, session.id, { kind: "text", who: "me", time: realHHMM(), text, uid: uid("u") });
      appendMsg(qc, session.id, {
        kind: "typing",
        who: session.agent,
        text: `${session.agent === "claude" ? "Claude Code" : "Codex"} 正在思考…`,
        uid: typingUid,
      });

      runs.set(runId, {
        sessionId: session.id,
        agent: session.agent,
        typingUid,
        buffer: "",
        gotResult: false,
        promptText: text,
        startedAt: Date.now(),
        cwd: projectPath,
      });
      usePersonalStore.getState().setRunning(session.id, runId);
      usePetStore.getState().set("thinking");

      const appendSystemPrompt =
        attachments.length > 0
          ? attachments.map((a) => `<skill name="${a.name}">\n${a.content}\n</skill>`).join("\n\n")
          : undefined;

      try {
        await bridge.startCli({
          runId,
          sessionId: session.id,
          agent: session.agent,
          cwd: projectPath,
          prompt: text,
          model: session.model,
          resumeSessionId: sessionResumeId(session),
          appendSystemPrompt,
          useOwnSkills: session.useOwnSkills,
        });
        // 主对话 spawn 成功后再异步生成标题（CLI 缺失时不会白跑）。
        autoTitle(bridge, session, text);
      } catch (err) {
        handleCliExit(qc, runId, null, err instanceof Error ? err.message : String(err));
      }
    },
    [bridge, qc],
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
            if (r.sessionId === sessionId) runs.delete(id);
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

  return { send, stop, clearView };
}
