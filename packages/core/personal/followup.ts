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
import type { AgentKind, CliStreamEvent, PermissionMode, ReasoningEffort } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { emptyFoldCursor, finalizeAgentLog, foldCliEvent, type FoldCursor } from "./messages";
import { resolveEffectiveMode } from "./resolveMode";

// 种子正文的正文级截断上限(KTD7):远大于 clipSummary 的 200 字摘要级——后者会砍残正文。
// 8000 字符足以容纳绝大多数单条 assistant 回复,又防极端超长正文撑爆 prompt。
export const FOLLOWUP_SEED_MAX = 8000;

// 硬超时兜底(FIX-1):正常收尾**只认 result 事件**(进程真实结束才收尾,语义对齐主会话);
// 此处仅作「进程彻底挂死、永不返回」的最后防线。窗口取 120s 量级,远大于推理模型/冷启动/
// 工具执行的事件间隔,故 init→(长思考静默)→text→result 的正常序列绝不会被它提前收尾。
// 到点按 error(超时)收尾而非静默 done。
export const FOLLOWUP_HARD_TIMEOUT_MS = 120_000;

// 历史拼接的总量预算(FIX-4):防多轮 done 答案无上限拼接触顶 ARG_MAX(E2BIG)。
// 超预算时丢弃最旧轮、保留最近若干轮(连贯优先近期)。
export const FOLLOWUP_HISTORY_MAX = 24_000;

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
  // 运行模式:沿用主会话档位,追问与主会话权限一致。与 tightenTools 自然叠加(更严者优先):
  // plan/accept-edits 产出非 bypass 标志,tightenTools 剥离 bypass 对其为 no-op;full-auto +
  // tightenTools 仍剥离 bypass → 安全。
  permissionMode?: PermissionMode;
  // true = 无项目会话:透传给 askFollowupStream,主进程据此收紧 tool 能力（R9/KTD8,FIX-3）。
  tightenTools?: boolean;
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
  // retryOf 命中某轮 id 时,用新一轮**替换**该轮(原位换成新 streaming 轮),而非追加(FIX-6)。
  ask(question: string, retryOf?: string): void;
  cancel(): void;
  reset(): void;
}

// ── 纯函数:拼 prompt / system prompt ─────────────────────────────────────

function clipSeed(text: string): string {
  if (text.length <= FOLLOWUP_SEED_MAX) return text;
  return text.slice(0, FOLLOWUP_SEED_MAX) + "\n…(正文过长已截断)";
}

// 最小转义(FIX-5):剔除插入正文里的字面标注闭合标签,防正文内 </assistant> 等逃逸出栅栏块、
// 篡改 prompt 结构(prompt 注入)。只处理本文件实际用到的标注标签的闭合形式;大小写不敏感。
const FOLLOWUP_TAGS = ["followup_seed", "followup_history", "user", "assistant"];
function escapeFollowupTags(text: string): string {
  let out = text;
  for (const tag of FOLLOWUP_TAGS) {
    // 把 </tag>（容忍标签内空白）替换为可见的全角尖括号,既不破坏块结构也保留可读性。
    out = out.replace(new RegExp(`</\\s*${tag}\\s*>`, "gi"), `〈/${tag}〉`);
  }
  return out;
}

// 种子正文 → appendSystemPrompt 块(KTD7,拼装风格仿 buildAttachmentSystemPrompt)。
// 用标注块包住正文 + 明确告诉 agent「这是用户想追问的一段历史回复」。正文级截断（非 200 摘要级）。
export function buildFollowupSystemPrompt(seedText: string): string {
  return [
    "<followup_seed>",
    "以下是用户正在浏览的一段历史回复。用户想就这段内容继续追问。",
    "请把它当作对话上下文来理解,据此回答用户接下来的问题。",
    "---",
    escapeFollowupTags(clipSeed(seedText)),
    "</followup_seed>",
  ].join("\n");
}

// 历史轮 → 角色标注块。把先前 agent 输出明确标为「你在本次追问会话中先前的回答」,
// 缓解无状态重发的指代漂移(KTD4):防止 print 模式进程把内嵌 assistant 段当成用户给的文本。
// question/answer 均做 tag 转义(FIX-5),防正文逃逸破坏块结构。
function turnToHistoryBlock(turn: Turn): string {
  const answer = turn.messages
    .map((m) => (m.kind === "text" ? messageText(m) : ""))
    .filter(Boolean)
    .join("\n");
  return [
    `<user>${escapeFollowupTags(turn.question)}</user>`,
    `<assistant>${escapeFollowupTags(answer)}</assistant>`,
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
// 历史块受 FOLLOWUP_HISTORY_MAX 总量预算约束(FIX-4):从最近一轮往回累加,超预算即停,
// 丢弃更旧的轮——长对话避免 argv 触顶 ARG_MAX(E2BIG),连贯优先近期。
export function buildFollowupPrompt(turns: Turn[], question: string): string {
  const history = turns.filter((t) => t.status === "done" && t.messages.length > 0);
  if (history.length === 0) return question;

  // 从最近往旧累加块,装不下就丢最旧;至少保留最近一轮(即便它单轮超预算)。
  const blocks: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const block = turnToHistoryBlock(history[i]!);
    const cost = block.length + 2; // +2 ≈ 块间分隔符 "\n\n"
    if (blocks.length > 0 && used + cost > FOLLOWUP_HISTORY_MAX) break;
    blocks.unshift(block); // 维持时间顺序(旧 → 新)
    used += cost;
  }

  return [
    "<followup_history>",
    "以下 <assistant> 段是你在本次追问会话中先前的回答(<user> 是用户先前的提问)。",
    "请把它们理解为「你自己之前说过的话」,据此连贯地继续回答末尾的新问题。",
    blocks.join("\n\n"),
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
  // 硬超时兜底定时器(FIX-1):仅防进程彻底挂死永不返回,不再做逐事件 1.5s 不活动超时。
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最新 seed/ctx 引用,避免 ask 回调闭包过期。
  const seedRef = useRef(seed);
  const ctxRef = useRef(sessionCtx);
  seedRef.current = seed;
  ctxRef.current = sessionCtx;

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // 把 active 轮标记终态并关 running（薄壳:守卫代际 + 调纯 settleTurn）。
  const settle = useCallback(
    (askId: string, status: Exclude<TurnStatus, "streaming">, error?: string) => {
      if (activeRef.current !== askId) return;
      clearTimer();
      activeRef.current = null;
      setRunning(false);
      setState((prev) => ({ ...prev, turns: settleTurn(prev.turns, prev.cursors, askId, status, error) }));
    },
    [clearTimer],
  );

  // 起手时 arm 一次硬超时(FIX-1):到点按 error(超时)收尾,而非静默 done。
  // 不逐事件重置——窗口 120s 量级远大于任何正常事件间隔,无需续期。
  const armHardTimeout = useCallback(
    (askId: string) => {
      clearTimer();
      timeoutRef.current = setTimeout(() => settle(askId, "error", "追问超时:未在限定时间内返回结果"), FOLLOWUP_HARD_TIMEOUT_MS);
    },
    [clearTimer, settle],
  );

  // 订阅事件流:守卫由纯 reducer 内做（applyFollowupEvent 比对 activeAskId）。
  // **正常收尾只认 result 事件**(FIX-1):text/tool/init 一律不触发收尾、不重置任何定时器,
  // 故推理模型/冷启动/工具执行造成的长间隔静默不会被误判 done、不会清空 activeRef。
  useEffect(() => {
    if (!bridge?.onAskFollowupEvent) return;
    const off = bridge.onAskFollowupEvent((askId, ev) => {
      if (activeRef.current !== askId) return; // 旧代际/迟到事件丢弃（reducer 内亦再守一次）
      // 守卫值传 askId 本身(而非懒读 activeRef.current):本回调已确认当前代际==askId,
      // 且下方 result 分支会同步把 activeRef.current 置 null——若 setState 更新器懒读 ref,
      // 会在 flush 时读到已清空的 null 致代际守卫误丢该 result 事件(收尾迁移丢失)。
      setState((prev) =>
        applyFollowupEvent(prev, askId, askId, ev, {
          agent: ctxRef.current.agent,
          time: hhmm(),
          newUid: foldUid,
        }),
      );
      if (ev.type === "result") {
        // result = 进程真实结束的唯一正常收尾信号。turns 状态迁移已在 applyFollowupEvent 内完成;
        // 此处收尾 hook 级在途态(清硬超时 + 清 activeRef + 关 running)。
        clearTimer();
        activeRef.current = null;
        setRunning(false);
      }
      // text/tool/init:不收尾、不动定时器(等 result)。
    });
    return off;
  }, [bridge, clearTimer]);

  const ask = useCallback(
    (question: string, retryOf?: string) => {
      const q = question.trim();
      if (!q) return;
      // bridge 或方法缺失（web/旧壳）→ 安全降级为 no-op（入口门控在 U5）。
      if (!bridge?.askFollowupStream) return;
      clearTimer();

      const askId = newAskId();
      activeRef.current = askId;

      const newTurn: Turn = { id: askId, question: q, status: "streaming", messages: [] };
      setState((prev) => {
        // 拼 prompt 的历史**始终排除被替换轮**(retryOf):重试是「换掉那轮」,不能把旧 error 轮
        // (恒被 done 过滤掉)或它本身计入历史。新轮本身也不进历史。
        const baseTurns = prev.turns.filter((t) => t.id !== retryOf);
        const prompt = buildFollowupPrompt(baseTurns, q);
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
            // auto 按当轮追问解析成具体档(adapter 不见 auto);追问不传目录授权(沿用打开/读取兜底)。
            permissionMode: resolveEffectiveMode(ctx.permissionMode, q),
            tightenTools: ctx.tightenTools,
            provider: ctx.provider,
          })
          .catch((err: unknown) => {
            settle(askId, "error", err instanceof Error ? err.message : String(err));
          });
        // retryOf 命中 → 原位替换该轮为新 streaming 轮(不并存,FIX-6);否则追加。
        const cursors = withCursor(prev.cursors, askId, emptyFoldCursor());
        if (retryOf && prev.turns.some((t) => t.id === retryOf)) {
          return { turns: prev.turns.map((t) => (t.id === retryOf ? newTurn : t)), cursors };
        }
        return { turns: [...prev.turns, newTurn], cursors };
      });
      setRunning(true);
      // 起手 arm 硬超时:即便进程彻底挂死、一个事件都不返回,也最终按超时收尾。
      armHardTimeout(askId);
    },
    [bridge, clearTimer, settle, armHardTimeout],
  );

  const cancel = useCallback(() => {
    const askId = activeRef.current;
    clearTimer();
    activeRef.current = null;
    setRunning(false);
    if (!askId) return;
    void bridge?.cancelFollowup?.(askId);
    setState((prev) => ({ ...prev, turns: markTurnCancelled(prev.turns, prev.cursors, askId) }));
  }, [bridge, clearTimer]);

  const reset = useCallback(() => {
    const askId = activeRef.current;
    clearTimer();
    activeRef.current = null;
    setRunning(false);
    if (askId) void bridge?.cancelFollowup?.(askId);
    setState({ turns: [], cursors: {} });
  }, [bridge, clearTimer]);

  // 卸载:退订由上面 useEffect 的 cleanup 负责;此处 cancel 在途（清子进程,避免孤儿进程 R7）。
  useEffect(() => {
    return () => {
      const askId = activeRef.current;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (askId) void bridge?.cancelFollowup?.(askId);
      activeRef.current = null;
    };
  }, [bridge]);

  return { turns: state.turns, running, ask, cancel, reset };
}
