// 历史消息「追问」浮层的临时多轮问答状态机（U3）。
//
// 与主会话彻底隔离:本地 useState/useRef 持有 turns，**不**进 React Query、**不**进
// Zustand、**不**落盘。浮层卸载即丢弃（关闭即弃）。流式 text/tool 事件复用 messages.ts
// 的纯函数 foldCliEvent 折叠成 Message[]。每一轮一个唯一 askId，既作主进程子进程登记
// key，也经 onAskFollowupEvent 回带做代际守卫（封堵并发重入 + IPC 在途旧事件晚到）。
//
// 多轮用「每轮无状态重发」(KTD4):每次 ask 都重拼整段 prompt（种子 + 本浮层已发生的问答 +
// 新问题），不维持 agent 会话。指代上轮自身输出的追问靠 buildFollowupPrompt 的角色标注缓解。

import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../types";
import type { AgentKind, CliStreamEvent, ReasoningEffort } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { emptyFoldCursor, finalizeAgentLog, foldCliEvent, type FoldCursor } from "./messages";

// 种子正文的正文级截断上限(KTD7):远大于 clipSummary 的 200 字摘要级——后者会砍残正文。
// 8000 字符足以容纳绝大多数单条 assistant 回复,又防极端超长正文撑爆 prompt。
export const FOLLOWUP_SEED_MAX = 8000;

// 收尾兜底宽限(R8):只收到 text、迟迟无 result/exit 时,宽限后强制关 running（仿
// scheduleResultExitFallback）。比主会话 1s 略宽,容忍单发 spawn 的网络抖动。
export const FOLLOWUP_RESULT_GRACE_MS = 1_500;

// 被追问的消息正文种子。
export interface FollowupSeed {
  text: string;
}

// 由调用方(U5)解析好后传入:复用当前活动会话的 agent / model / cwd / provider（R6）。
// followup 自身不读 store、不解析 provider —— 保持纯粹与可测。
export interface FollowupSessionCtx {
  agent: AgentKind;
  model?: string;
  cwd: string;
  effort?: ReasoningEffort;
  provider?: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    models: { id: string; name?: string }[];
  };
}

export type TurnStatus = "streaming" | "done" | "error" | "cancelled";

// 一轮问答:用户问题 + 该轮 agent 输出（经 foldCliEvent 折叠的块）。
export interface Turn {
  id: string; // == 该轮 askId（代际标识，UI 列表 key）
  question: string;
  status: TurnStatus;
  messages: Message[]; // 折叠后的 agent 输出块（text / agentLog）
  error?: string;
}

export interface UseFollowupAsk {
  turns: Turn[];
  running: boolean;
  ask(question: string): void;
  cancel(): void;
  reset(): void;
}

// ── 纯函数:拼 prompt / system prompt ─────────────────────────────────────

function clipSeed(text: string): string {
  if (text.length <= FOLLOWUP_SEED_MAX) return text;
  return text.slice(0, FOLLOWUP_SEED_MAX) + "\n…(正文过长已截断)";
}

// 种子正文 → appendSystemPrompt 块(KTD7,拼装风格仿 buildAttachmentSystemPrompt)。
// 用标注块包住正文 + 明确告诉 agent「这是用户想追问的一段历史回复」。正文级截断（非 200 摘要级）。
export function buildFollowupSystemPrompt(seedText: string): string {
  return [
    "<followup_seed>",
    "以下是用户正在浏览的一段历史回复。用户想就这段内容继续追问。",
    "请把它当作对话上下文来理解,据此回答用户接下来的问题。",
    "---",
    clipSeed(seedText),
    "</followup_seed>",
  ].join("\n");
}

// 历史轮 → 角色标注块。把先前 agent 输出明确标为「你在本次追问会话中先前的回答」,
// 缓解无状态重发的指代漂移(KTD4):防止 print 模式进程把内嵌 assistant 段当成用户给的文本。
function turnToHistoryBlock(turn: Turn): string {
  const answer = turn.messages
    .map((m) => (m.kind === "text" ? messageText(m) : ""))
    .filter(Boolean)
    .join("\n");
  return [
    `<user>${turn.question}</user>`,
    `<assistant>${answer}</assistant>`,
  ].join("\n");
}

function messageText(m: Message): string {
  if (m.kind !== "text") return "";
  const t = m.text;
  if (typeof t === "string") return t;
  return t.parts.map((p) => p.v).join("");
}

// 把本浮层已发生的问答 + 新问题拼成 prompt(KTD4)。历史用角色标注包裹并加一句引导,
// 新问题放末尾。turns 只取已完成（done）的历史轮——streaming/error/cancelled 不入历史。
export function buildFollowupPrompt(turns: Turn[], question: string): string {
  const history = turns.filter((t) => t.status === "done" && t.messages.length > 0);
  if (history.length === 0) return question;
  return [
    "<followup_history>",
    "以下 <assistant> 段是你在本次追问会话中先前的回答(<user> 是用户先前的提问)。",
    "请把它们理解为「你自己之前说过的话」,据此连贯地继续回答末尾的新问题。",
    history.map(turnToHistoryBlock).join("\n\n"),
    "</followup_history>",
    "",
    question,
  ].join("\n");
}

// ── 纯 reducer：事件 → turns（可在 node 环境直测，无 React/DOM 依赖） ──────────
//
// 把「事件 → turns」的核心逻辑（代际守卫 + foldCliEvent 折叠 + result/error 状态迁移）
// 与取消/收尾的状态迁移全部抽成纯函数,在 node 环境用 vitest 直测（守住 core「只测纯函数」
// 约定,不引 react-dom/jsdom）。useFollowupAsk 只是薄壳:持 state + 订阅事件 + 调这些纯函数。

// 每轮独立的折叠游标，按 askId 索引（reducer 自带，不靠外部 ref）。
export type FollowupCursors = Record<string, FoldCursor>;

// reducer 的折叠上下文：agent（决定块的 who）+ 取时间/uid 的注入函数（保持纯粹、可控）。
export interface FollowupApplyCtx {
  agent: AgentKind;
  time: string;
  newUid: (prefix: string) => string;
}

export interface FollowupState {
  turns: Turn[];
  cursors: FollowupCursors;
}

function withCursor(cursors: FollowupCursors, askId: string, cursor: FoldCursor): FollowupCursors {
  return { ...cursors, [askId]: cursor };
}

// 把 askId 轮里仍打开的 agentLog 收尾（停 spinner）。纯函数。
export function finalizeTurnLog(turns: Turn[], cursors: FollowupCursors, askId: string): Turn[] {
  const cursor = cursors[askId];
  const logUid = cursor?.lastKind === "tool" ? cursor.logUid : undefined;
  if (!logUid) return turns;
  return turns.map((t) => (t.id === askId ? { ...t, messages: finalizeAgentLog(t.messages, logUid) } : t));
}

// 终态迁移：把 askId 轮标记 done/error/cancelled（收尾 agentLog + 写状态）。纯函数。
export function settleTurn(
  turns: Turn[],
  cursors: FollowupCursors,
  askId: string,
  status: Exclude<TurnStatus, "streaming">,
  error?: string,
): Turn[] {
  const finalized = finalizeTurnLog(turns, cursors, askId);
  return finalized.map((t) => (t.id === askId ? { ...t, status, error } : t));
}

export const markTurnDone = (turns: Turn[], cursors: FollowupCursors, askId: string): Turn[] =>
  settleTurn(turns, cursors, askId, "done");

export const markTurnError = (turns: Turn[], cursors: FollowupCursors, askId: string, error?: string): Turn[] =>
  settleTurn(turns, cursors, askId, "error", error || "执行出错");

export const markTurnCancelled = (turns: Turn[], cursors: FollowupCursors, askId: string): Turn[] =>
  settleTurn(turns, cursors, askId, "cancelled");

// 单事件归约（代际守卫 + 折叠 + 状态迁移）。纯函数,核心可测点：
// - activeAskId !== askId → 原样返回（旧代际/迟到事件丢弃,R7）。
// - text/tool → foldCliEvent 折叠进该轮 messages,回写该轮 cursor。
// - result.ok → done；result.ok===false → error（带文案）。
// - init / 其它 → 不改 turns/cursors（仅 hook 侧据此刷新宽限定时器）。
export function applyFollowupEvent(
  state: FollowupState,
  activeAskId: string | null,
  askId: string,
  event: CliStreamEvent,
  ctx: FollowupApplyCtx,
): FollowupState {
  if (activeAskId !== askId) return state; // 代际守卫：丢弃旧/并发事件
  const { turns, cursors } = state;

  if (event.type === "text" || event.type === "tool") {
    const cursor = cursors[askId] ?? emptyFoldCursor();
    let nextCursor = cursor;
    const nextTurns = turns.map((t) => {
      if (t.id !== askId) return t;
      const folded = foldCliEvent(t.messages, event, cursor, {
        agent: ctx.agent,
        time: ctx.time,
        newUid: ctx.newUid,
      });
      nextCursor = folded.cursor;
      return { ...t, messages: folded.messages };
    });
    return { turns: nextTurns, cursors: withCursor(cursors, askId, nextCursor) };
  }

  if (event.type === "result") {
    const nextTurns = event.ok
      ? markTurnDone(turns, cursors, askId)
      : markTurnError(turns, cursors, askId, event.error);
    return { turns: nextTurns, cursors };
  }

  // init 等：不改 turns（hook 侧仅用于刷新收尾宽限）。
  return state;
}

// ── Hook（薄壳：持态 + 订阅 + 调纯 reducer） ───────────────────────────────

let askSeq = 0;
function newAskId(): string {
  askSeq += 1;
  return `ask-${Date.now()}-${askSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

let foldSeq = 0;
function foldUid(prefix: string): string {
  foldSeq += 1;
  return `${prefix}-${foldSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function hhmm(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function useFollowupAsk(seed: FollowupSeed, sessionCtx: FollowupSessionCtx): UseFollowupAsk {
  const bridge = useDesktopBridge();
  const [state, setState] = useState<FollowupState>({ turns: [], cursors: {} });
  const [running, setRunning] = useState(false);

  // active 代际:当前在途的 askId。事件守卫据此丢弃旧 askId 的迟到事件(R7)。
  const activeRef = useRef<string | null>(null);
  // 收尾兜底定时器。
  const graceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最新 seed/ctx 引用,避免 ask 回调闭包过期。
  const seedRef = useRef(seed);
  const ctxRef = useRef(sessionCtx);
  seedRef.current = seed;
  ctxRef.current = sessionCtx;

  const clearGrace = useCallback(() => {
    if (graceRef.current) {
      clearTimeout(graceRef.current);
      graceRef.current = null;
    }
  }, []);

  // 把 active 轮标记终态并关 running（薄壳:守卫代际 + 调纯 settleTurn）。
  const settle = useCallback(
    (askId: string, status: Exclude<TurnStatus, "streaming">, error?: string) => {
      if (activeRef.current !== askId) return;
      clearGrace();
      activeRef.current = null;
      setRunning(false);
      setState((prev) => ({ ...prev, turns: settleTurn(prev.turns, prev.cursors, askId, status, error) }));
    },
    [clearGrace],
  );

  // 起手/续流时刷新收尾宽限定时器（R8,仿 scheduleResultExitFallback）。
  const armGrace = useCallback(
    (askId: string) => {
      clearGrace();
      graceRef.current = setTimeout(() => settle(askId, "done"), FOLLOWUP_RESULT_GRACE_MS);
    },
    [clearGrace, settle],
  );

  // 订阅事件流:守卫由纯 reducer 内做（applyFollowupEvent 比对 activeAskId）。
  useEffect(() => {
    if (!bridge?.onAskFollowupEvent) return;
    const off = bridge.onAskFollowupEvent((askId, ev) => {
      if (activeRef.current !== askId) return; // 旧代际/迟到事件丢弃（reducer 内亦再守一次）
      setState((prev) =>
        applyFollowupEvent(prev, activeRef.current, askId, ev, {
          agent: ctxRef.current.agent,
          time: hhmm(),
          newUid: foldUid,
        }),
      );
      if (ev.type === "result") {
        // turns 状态迁移已在 applyFollowupEvent 内完成;此处只收尾 hook 级在途态。
        clearGrace();
        activeRef.current = null;
        setRunning(false);
        return;
      }
      // text/tool/init：刷新收尾宽限。
      armGrace(askId);
    });
    return off;
  }, [bridge, clearGrace, armGrace]);

  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q) return;
      // bridge 或方法缺失（web/旧壳）→ 安全降级为 no-op（入口门控在 U5）。
      if (!bridge?.askFollowupStream) return;
      clearGrace();

      const askId = newAskId();
      activeRef.current = askId;

      const newTurn: Turn = { id: askId, question: q, status: "streaming", messages: [] };
      setState((prev) => {
        // 用「当前已完成历史 + 新轮」拼 prompt;新轮本身不进历史。
        const prompt = buildFollowupPrompt(prev.turns, q);
        const appendSystemPrompt = buildFollowupSystemPrompt(seedRef.current.text);
        const ctx = ctxRef.current;
        void bridge
          .askFollowupStream?.({
            askId,
            agent: ctx.agent,
            cwd: ctx.cwd,
            prompt,
            model: ctx.model,
            appendSystemPrompt,
            effort: ctx.effort,
            provider: ctx.provider,
          })
          .catch((err: unknown) => {
            settle(askId, "error", err instanceof Error ? err.message : String(err));
          });
        return { turns: [...prev.turns, newTurn], cursors: withCursor(prev.cursors, askId, emptyFoldCursor()) };
      });
      setRunning(true);
      // 起手宽限:即便一个事件都没收到也最终收尾，不留永久运行中。
      graceRef.current = setTimeout(() => settle(askId, "done"), FOLLOWUP_RESULT_GRACE_MS);
    },
    [bridge, clearGrace, settle],
  );

  const cancel = useCallback(() => {
    const askId = activeRef.current;
    clearGrace();
    activeRef.current = null;
    setRunning(false);
    if (!askId) return;
    void bridge?.cancelFollowup?.(askId);
    setState((prev) => ({ ...prev, turns: markTurnCancelled(prev.turns, prev.cursors, askId) }));
  }, [bridge, clearGrace]);

  const reset = useCallback(() => {
    const askId = activeRef.current;
    clearGrace();
    activeRef.current = null;
    setRunning(false);
    if (askId) void bridge?.cancelFollowup?.(askId);
    setState({ turns: [], cursors: {} });
  }, [bridge, clearGrace]);

  // 卸载:退订由上面 useEffect 的 cleanup 负责;此处 cancel 在途（清子进程,避免孤儿进程 R7）。
  useEffect(() => {
    return () => {
      const askId = activeRef.current;
      if (graceRef.current) clearTimeout(graceRef.current);
      if (askId) void bridge?.cancelFollowup?.(askId);
      activeRef.current = null;
    };
  }, [bridge]);

  return { turns: state.turns, running, ask, cancel, reset };
}
