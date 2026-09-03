// 前置检索管线（chat-preflight）→ 过程时间线条目（Message kind:"retrieval"）的状态机。
//
// 生产方义务（与渲染侧契约对齐，见 types/index.ts 的 retrieval 变体注释）：
//  - 条目在首个状态事件时才写入（不发状态 = 不留条目），是本轮过程流的第一条消息；
//  - 状态推进一律**同 uid 原位替换**；
//  - 无论成败必须收敛到终态（active=false + endedAt），时间线绝不留悬挂 spinner——
//    调用方在发送路径 finally 里兜底 finalize。
//
// 刻意不 import messages.ts（setProcessMessages/uid/realHHMM 都在那里）：messages.ts 要
// import 本文件的调用点，反向引用会成环。写入通道由调用方注入（一个 updater→void 的写函数），
// 这也让本文件可以用一个数组 fake 完整单测。
import type { Message } from "../types";
import type { PreflightStatus } from "../research/chat-preflight";

/// 过程流写函数：调用方传 `(updater) => setProcessMessages(qc, sessionId, updater)`。
export type ProcessStreamWriter = (updater: (prev: Message[]) => Message[]) => void;

export interface RetrievalTimelineHandle {
  /// 按 chat-preflight 的状态事件推进条目；首个事件创建条目，后续同 uid 原位替换。
  update(status: PreflightStatus): void;
  /// 兜底收敛：若条目仍停留在非终态（管线中途被异常打断），归一为 failed/interrupted。
  /// 已是终态或从未创建则 no-op。调用方在发送路径 finally 里调它。
  finalize(): void;
}

type RetrievalMessage = Extract<Message, { kind: "retrieval" }>;

// 本地小工具：与 messages.ts 的 uid/realHHMM 同语义。就地复制三行而不是 import，
// 理由见文件头（避免与 messages.ts 成环）。
let seq = 0;
function localUid(): string {
  seq += 1;
  return `retrieval-${Date.now().toString(36)}-${seq}`;
}
function hhmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function isTerminal(phase: RetrievalMessage["phase"]): boolean {
  return phase === "done" || phase === "skipped" || phase === "failed";
}

/// 把一个 PreflightStatus 投影成条目字段（不含 uid/who/time 等身份字段）。
function projectStatus(
  status: PreflightStatus,
  startedAt: number,
): Omit<RetrievalMessage, "kind" | "who" | "time" | "uid"> {
  switch (status.phase) {
    case "understanding":
      return { phase: "understanding", startedAt, active: true };
    case "searching":
      return {
        phase: "searching",
        startedAt,
        active: true,
        // 改写真实生效才带 query（供过程面板回看）；原文照发时不重复存一份用户消息。
        ...(status.rewritten ? { query: status.query } : {}),
      };
    case "done":
      return {
        phase: "done",
        // documentCount 缺席 = 本轮只跑了意图理解（无检索链路），渲染方显示「已理解问题」；
        // 带值（含 0）= 检索执行完成。二者靠 resultCount 是否存在区分，不能混。
        ...(status.documentCount !== undefined ? { resultCount: status.documentCount } : {}),
        startedAt,
        endedAt: Date.now(),
        active: false,
      };
    case "skipped":
      return { phase: "skipped", skipReason: status.intent, startedAt, endedAt: Date.now(), active: false };
    case "failed":
      return { phase: "failed", error: status.reason, startedAt, endedAt: Date.now(), active: false };
  }
}

/// 创建一轮前置检索的时间线句柄。write 缺失（异常调用形态）时退化为 no-op。
export function beginRetrievalTimeline(write: ProcessStreamWriter | undefined, who: string): RetrievalTimelineHandle {
  if (!write) return { update: () => {}, finalize: () => {} };

  const uid = localUid();
  const startedAt = Date.now();
  let created = false;
  let lastPhase: RetrievalMessage["phase"] | undefined;
  // 中间态可能携带 query 等可选字段，终态投影不含它们；replace 语义必须整条重建而不是
  // 展开旧条目补丁，否则 searching 带上的 query 会在 done 后仍残留在不该有的分支上——
  // 这里 query 恰好该保留，所以单独记下来透传。
  let carriedQuery: string | undefined;

  const buildMessage = (status: PreflightStatus): RetrievalMessage => {
    const projected = projectStatus(status, startedAt);
    if (projected.phase === "searching" && projected.query) carriedQuery = projected.query;
    return {
      kind: "retrieval",
      who,
      time: hhmm(),
      uid,
      ...projected,
      ...(carriedQuery && !("query" in projected) ? { query: carriedQuery } : {}),
    };
  };

  const push = (message: RetrievalMessage) => {
    write((prev) => {
      const index = prev.findIndex((item) => item.uid === uid);
      if (index < 0) return [...prev, message];
      const next = [...prev];
      next[index] = message;
      return next;
    });
  };

  return {
    update(status: PreflightStatus): void {
      // 终态后禁止再迁移：编排层不该产生这种序列，真出现时保留已收敛的结论。
      if (lastPhase !== undefined && isTerminal(lastPhase)) return;
      const message = buildMessage(status);
      lastPhase = message.phase;
      created = true;
      push(message);
    },
    finalize(): void {
      if (!created || (lastPhase !== undefined && isTerminal(lastPhase))) return;
      lastPhase = "failed";
      push({
        kind: "retrieval",
        who,
        time: hhmm(),
        uid,
        phase: "failed",
        error: "interrupted",
        startedAt,
        endedAt: Date.now(),
        active: false,
        ...(carriedQuery ? { query: carriedQuery } : {}),
      });
    },
  };
}
