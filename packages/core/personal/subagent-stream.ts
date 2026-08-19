// 子会话过程流折叠(delegate 子代理的 thinking/tool → personalProcessKeys.detail(childSessionId))。
//
// 从 messages.ts 拆出(审阅意见:单文件超限 + 子/主折叠同构宜共用):本模块只做**过程流**折叠,
// 与主会话共用同一套底层原语(foldCliEvent/finalizeAgentLog/finalizeReasoning),二者的终态语义
// 因此不会各自漂移。chat 侧的子会话写入(任务/回复/todo 卡)仍在 messages.ts——那是持久聊天域,
// 不属于过程流。
//
// 与 messages.ts 存在模块级循环 import(本模块用它的折叠原语,它用本模块的折叠函数):
// 双方都只在函数调用期访问对方导出、模块求值期零依赖,ESM live binding 下安全;真正的解环
// 要等过程流原语独立成模块(见 docs/plans/2026-08-18-001 信封归一方案的后续拆分)。

import type { QueryClient } from "@tanstack/react-query";

import type { Message } from "../types";
import type { AgentKind, CliStreamEvent } from "../desktop/types";
import {
  emptyProcessCursor,
  finalizeAgentLog,
  finalizeReasoning,
  foldCliEvent,
  realHHMM,
  setProcessMessages,
  uid,
  type ProcessCursor,
} from "./messages";

/** 子会话过程流的折叠状态(信封归一 P2 后由 childStreams 注册表按 childSessionId 持有)。 */
export interface SubagentStreamState {
  childSessionId?: string;
  childAgent?: AgentKind;
  processCursor: ProcessCursor;
  reasoningUid?: string;
  reasoningText?: string;
  // toolCallId → 该工具项在过程流里的精确位置。并行工具时 end 帧不能按「最后一个 running 项」
  // 反查(A 先结束会错翻/错标 ⚠️ 到 B),必须按 id 定位;缺 id 的旧适配器仍走 last-running 兜底。
  openToolItems?: Map<string, { logUid: string; index: number }>;
}

// ── 子会话流注册表(信封归一 P2) ──────────────────────────────────────────────
//
// 主进程对每个子代理调用双发信封:父流(卡片语义,带标记)+ 子流(sessionId=childSessionId,
// runId=callId,事件已剥标记)。渲染端按注册表把子流信封直接路由到子会话 reducer,不再从父流
// 标记推断归属。注册由父流 init 驱动;HMR/刷新丢表后按持久 SessionMeta(relation:"side")兜底重建。
interface ChildStreamEntry {
  callId: string;
  state: SubagentStreamState;
}

const childStreams = new Map<string, ChildStreamEntry>();

/** 登记一个子会话流(幂等:同 childSessionId 重复登记沿用已有折叠状态)。 */
export function registerSubagentChildStream(
  childSessionId: string,
  callId: string,
  agent: AgentKind | undefined,
): ChildStreamEntry {
  const existing = childStreams.get(childSessionId);
  if (existing && existing.callId === callId) return existing;
  const entry: ChildStreamEntry = {
    callId,
    state: {
      childSessionId,
      childAgent: agent,
      processCursor: emptyProcessCursor(),
    },
  };
  childStreams.set(childSessionId, entry);
  return entry;
}

export function getSubagentChildStream(childSessionId: string): ChildStreamEntry | undefined {
  return childStreams.get(childSessionId);
}

export function unregisterSubagentChildStream(childSessionId: string): void {
  childStreams.delete(childSessionId);
}

/** 单测隔离:清空注册表(与 __resetPersonalMessageRunsForTest 一起调用)。 */
export function __resetSubagentChildStreamsForTest(): void {
  childStreams.clear();
}

/** 子会话思考流折叠:首个 delta 开 reasoning 块,后续累进同一块。 */
export function foldSubagentReasoning(qc: QueryClient, state: SubagentStreamState, delta: string): void {
  const childId = state.childSessionId;
  if (!childId || !delta) return;
  // 思考前先收尾打开的工具卡,保留「工具→再思考」的交错时间线(与主会话同规则)。
  finalizeSubagentProcessLog(qc, state);
  if (state.reasoningUid) {
    const text = (state.reasoningText ?? "") + delta;
    state.reasoningText = text;
    const ruid = state.reasoningUid;
    setProcessMessages(qc, childId, (prev) =>
      prev.map((m) => (m.uid === ruid && m.kind === "reasoning" ? { ...m, text, active: true } : m)),
    );
    return;
  }
  const ruid = uid("sre");
  state.reasoningUid = ruid;
  state.reasoningText = delta;
  setProcessMessages(qc, childId, (prev) => [
    ...prev,
    { kind: "reasoning", who: state.childAgent ?? "pi", time: realHHMM(), text: delta, active: true, uid: ruid },
  ]);
}

/** 子会话思考块收尾(翻完成态)。 */
export function finalizeSubagentReasoning(qc: QueryClient, state: SubagentStreamState): void {
  if (!state.childSessionId || !state.reasoningUid) return;
  const ruid = state.reasoningUid;
  setProcessMessages(qc, state.childSessionId, (prev) => finalizeReasoning(prev, ruid));
  state.reasoningUid = undefined;
  state.reasoningText = undefined;
}

/** 子会话工具事件折叠:tool start 进 agentLog 卡(连续 tool 并入同卡),并按 toolCallId 登记项位置。 */
export function foldSubagentToolIntoProcess(qc: QueryClient, state: SubagentStreamState, ev: CliStreamEvent): void {
  const childId = state.childSessionId;
  if (!childId || ev.type !== "tool") return;
  finalizeSubagentReasoning(qc, state);
  let nextCursor = state.processCursor;
  let openedIndex = -1;
  setProcessMessages(qc, childId, (prev) => {
    const folded = foldCliEvent(prev, ev, state.processCursor, {
      agent: state.childAgent ?? "pi",
      time: realHHMM(),
      newUid: uid,
    });
    nextCursor = folded.cursor;
    // 新项恒追加在当前 agentLog 卡末尾;记下下标供 end 帧按 toolCallId 精确回填。
    if (ev.toolCallId && folded.cursor.logUid) {
      const logMsg = folded.messages.find(
        (message) => message.uid === folded.cursor.logUid && message.kind === "agentLog",
      );
      if (logMsg && logMsg.kind === "agentLog") openedIndex = logMsg.items.length - 1;
    }
    return folded.messages;
  });
  state.processCursor = nextCursor;
  if (ev.toolCallId && openedIndex >= 0 && nextCursor.logUid) {
    (state.openToolItems ??= new Map()).set(ev.toolCallId, { logUid: nextCursor.logUid, index: openedIndex });
  }
}

/**
 * 子会话 tool-end 收尾。带 toolCallId 时按登记位置精确回填——无论该项是否已被后续折叠自动
 * 翻 check(foldCliEvent 并入新项会把既有项翻 check),失败标记都必须落在**自己**的项上:
 * 并行时 A 先失败,A 的 ⚠️ 不能因为"A 已非 running"而被吞掉(审阅修复)。
 * 缺 id 的旧适配器兜底翻最后一个 running 项(与主会话同款 best-effort)。
 */
export function finalizeSubagentToolItem(
  qc: QueryClient,
  state: SubagentStreamState,
  toolCallId: string | undefined,
  isError: boolean,
): void {
  const childId = state.childSessionId;
  if (!childId) return;
  const located = toolCallId ? state.openToolItems?.get(toolCallId) : undefined;
  if (located && toolCallId) {
    state.openToolItems?.delete(toolCallId);
    setProcessMessages(qc, childId, (prev) =>
      prev.map((m) => {
        if (m.uid !== located.logUid || m.kind !== "agentLog") return m;
        const items = [...m.items];
        const it = items[located.index];
        if (it) {
          const text =
            isError && typeof it.text === "string" && !it.text.startsWith("⚠️") ? `⚠️ ${it.text}` : it.text;
          items[located.index] = { ...it, ic: "check", text };
        }
        return { ...m, items };
      }),
    );
    return;
  }
  if (state.processCursor.lastKind !== "tool" || !state.processCursor.logUid) return;
  const logUid = state.processCursor.logUid;
  setProcessMessages(qc, childId, (prev) =>
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

/** 子会话 agentLog 收尾:全部步骤打勾并清游标。 */
export function finalizeSubagentProcessLog(qc: QueryClient, state: SubagentStreamState): void {
  const childId = state.childSessionId;
  if (!childId || state.processCursor.lastKind !== "tool" || !state.processCursor.logUid) return;
  const logUid = state.processCursor.logUid;
  setProcessMessages(qc, childId, (prev: Message[]) => finalizeAgentLog(prev, logUid));
  state.processCursor = emptyProcessCursor();
}
