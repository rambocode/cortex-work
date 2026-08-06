// pi-host worker 的 agent trace 出口（`main/ipc/agent-trace` 的 worker 侧替身）。
//
// ── 为什么需要替身 ────────────────────────────────────────────────────────────────────
// `main/ipc/agent-trace.ts` 顶层 `import { ipcMain, type WebContents } from "electron"`，并把
// 事件推给订阅的 `WebContents` —— 这两样在 worker 里都不存在。而被复用的能力模块
// （`pi-inproc/session.ts` 的 open/exit 留痕、`native-hooks.ts` 的审批留痕）在模块顶层就
// import 了它，不替换就会在 worker 里 `require("electron")` 取到一个没有 `ipcMain` 的对象，
// 并在 500 条环形缓冲里堆一份永远没人读的副本。
//
// ── 当前的降级语义（**已知限制，见文件末尾的协议诉求**）──────────────────────────────
// 协议（`pi-gateway/protocol.ts`）目前只有 `WorkerLog` 一条日志通道，没有 trace 通道。
// 所以这里把 trace 记录**降级成一条结构化日志**发回主进程：信息不丢，但进不了主进程的
// agent trace 环形缓冲，dev 的「运行过程」面板在 gateway 路径上会少掉 worker 侧那几条
// （会话 open/exit、工具审批决策）。
//
// 主进程侧仍然拥有完整的**事件流** trace：`pi-session.ts` 的 `emitEvent()` 对每条
// `PiSessionEvent` 都会 `recordAgentTrace` / `recordStreamDelta`，那部分不受影响。
// 换句话说，缺的只是 worker 内部的判定留痕，不是对话过程本身。
//
// ⚠️ 后续（需与 U1 对齐）：给协议加一条 `WorkerTrace { kind:"trace"; input: AgentTraceInput }`，
// 主进程收到后原样 `recordAgentTrace(input)`，本文件即可从「降级成日志」升级为「透传」。
// 那是纯增量改动，不影响已有消息。
//
// ⚠️ **构建期 alias 目标**：`electron.pi-host.config.ts` 把解析到 `src/main/ipc/agent-trace.ts`
// 的 import 重定向到本文件。导出面必须覆盖被复用模块真正用到的符号
// （`recordAgentTrace` / `recordStreamDelta`），少一个就是运行时 undefined 调用。

import { emitWorkerLog } from "./log";

/** 与 `main/ipc/agent-trace` 的 `AgentTraceInput` 结构一致（不 import 那个模块，避免把 electron 拖进来）。 */
export interface WorkerTraceInput {
  scope: string;
  phase: string;
  summary: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
  data?: unknown;
}

/** 与 `AgentTraceEvent` 的返回形状兼容。调用方一律忽略返回值，这里只为签名对齐。 */
export interface WorkerTraceEvent extends WorkerTraceInput {
  id: string;
  ts: number;
}

let seq = 0;

/**
 * 记一条 agent trace。当前降级为一条 `info` 级日志（见文件头）。
 *
 * `phase` 进消息前缀而不是塞进 data：主进程侧按文本 grep 定位「哪一步」比展开 JSON 快得多，
 * 而这条路径本来就是「出问题时的第一手线索」。
 */
export function recordAgentTrace(input: WorkerTraceInput): WorkerTraceEvent {
  const parts: string[] = [`trace ${input.scope}/${input.phase}: ${input.summary}`];
  if (input.sessionId) parts.push(`session=${input.sessionId}`);
  if (input.runId) parts.push(`run=${input.runId}`);
  if (input.data !== undefined) parts.push(safeJson(input.data));
  emitWorkerLog("info", "pi-host-trace", [parts.join(" ")]);
  return { ...input, id: `wt${++seq}`, ts: Date.now() };
}

/**
 * 记一条流式增量。**刻意什么都不做**。
 *
 * 理由：gateway 路径上，text/reasoning 增量最终由主进程的 `pi-session.emitEvent()` 记进
 * trace（那才是唯一真源）。worker 侧再记一遍既是重复，又会把每个 token 变成一条跨进程
 * 日志消息——那是会把协议通道打满的量级。返回一个占位事件仅为签名对齐。
 */
export function recordStreamDelta(input: {
  scope: string;
  segmentType: string;
  delta: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
}): WorkerTraceEvent {
  return {
    scope: input.scope,
    phase: "stream",
    summary: input.segmentType,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    id: `wt${++seq}`,
    ts: Date.now(),
  };
}

/** 序列化失败（循环引用 / BigInt）时退化为占位串，绝不抛——调用点在 pi 的 agent loop 栈上。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "(data 不可序列化)";
  }
}
