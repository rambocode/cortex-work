// in-process 引擎的事件泵：把 `AgentSession.subscribe()` 的事件喂给现有的 `mapPiEvent`。
//
// ── 为什么可以直接复用 mapPiEvent（迁移计划 R2）────────────────────────────────────────
// `pi --mode json/rpc` 的 stdout 事件行**就是** `AgentEvent` / `AgentSessionEvent` 的 JSON 序列化
// （见 pi-coding-agent `modes/rpc/rpc-mode.js` 的 `output(event)`）。所以 in-process 拿到的对象与
// 旧路径 `JSON.parse(line)` 出来的对象**逐字段同源**，映射逻辑一行都不用改，只换输入来源。
// 也因此 `pi-rpc.test.ts` 里那 1288 行协议断言在迁移期继续有效，是这一层最好的回归网。
//
// ── 这一层唯一的新职责：异常边界（本次迁移最高风险项）────────────────────────────────
// `AgentSession._emit()` 对监听器**没有** try/catch（已核 0.82.1 源码：`for (const l of
// this._eventListeners) l(event)`）。旧路径下监听器抛错只会炸在主进程的 stdout 解析回调里；
// in-process 后它会**直接冒进 pi 的 agent loop**，让一次工具调用/一整轮对话中断，且错误被
// `stopReason:"error"` 吞掉（KTD5 的同类陷阱）。所以 `handle()` 必须**永不抛**。
//
// ── 序列化边界 ────────────────────────────────────────────────────────────────────────
// `PiSessionEvent` 最终要过 `webContents.send`（structured clone）。旧路径的事件天然是 JSON.parse
// 的产物，一定可克隆；in-process 拿到的是**活对象**，`tool-start.input` / `tool-end.output` 里可能
// 带 class 实例、函数或循环引用 —— 直接 send 会抛 "could not be cloned"，而且抛在 IPC 层、
// 堆栈里看不到 pi。故在这里做一次 JSON 往返净化，把问题挡在事件泵内。

import { mapPiEvent } from "./rpc-shared";
import { createLogger } from "../../log";
import type { PiSessionEvent } from "../../ipc/types";

const log = createLogger("pi-inproc-events");

/** 事件出口。`runId` 是 Cortex 自造的轮次代际，renderer 据此丢弃迟到/串台事件。 */
export type PiEventSink = (ev: PiSessionEvent, runId?: string) => void;

/**
 * 「agent 真在跑一轮」的事件类型。镜像 `pi-rpc.ts` 里的同名私有常量（U7 删除 pi-rpc 时以本份为准）。
 * 会话层用它取消「扩展命令补发收尾」的宽限定时器 —— 见 session.ts 的 finalize 说明。
 */
export const AGENT_TURN_EVENT_TYPES: ReadonlySet<PiSessionEvent["type"]> = new Set<PiSessionEvent["type"]>([
  "text",
  "reasoning",
  "tool-start",
  "tool-end",
  "turn-end",
  "result",
  "error", // 错误事件自带收尾路径，出现即不补发
]);

/** 判定一个归一化事件是否说明「agent 真在跑一轮」。 */
export function isAgentTurnEvent(ev: PiSessionEvent): boolean {
  return AGENT_TURN_EVENT_TYPES.has(ev.type);
}

export interface PiEventPumpOptions {
  /** 归一化事件出口（会话层转成 `pi:event` 推给 renderer）。 */
  onEvent: PiEventSink;
  /** 取当前轮 runId。每次事件到达时**现取**，因为 runId 在 prompt 时才绑定。 */
  getRunId?: () => string | undefined;
  /**
   * 事件处理内部出错时的回调（映射抛错 / sink 抛错 / 净化失败）。
   * 会话层据此决定是否上报 `crashed`。**不给默认实现**：静默吞错正是 KTD5 要避免的。
   */
  onFault?: (err: unknown, raw: unknown) => void;
  /** 已停止判定。停止后到达的残余事件一律丢弃（见下）。 */
  isStopped?: () => boolean;
  /**
   * 映射前的会话级装饰点。只允许补充宿主掌握的生命周期字段，不得改写模型/工具正文。
   * Cortex 用它把本地 checkpoint guard 触发的 agent_end 标成 willRetry。
   */
  prepareRaw?: (raw: unknown) => unknown;
}

export interface PiEventPump {
  /** 喂一个原始 `AgentSessionEvent`。**保证不抛**。 */
  handle(raw: unknown): void;
  /** 订阅一个 AgentSession，返回退订函数。 */
  attach(session: { subscribe(listener: (event: unknown) => void): () => void }): () => void;
}

/**
 * 深度净化：把活对象转成可结构化克隆的纯 JSON 值。
 *
 * 只对 `tool-start.input` / `tool-end.output` 这类**来自模型/工具的自由形状**字段做，
 * 其余字段（delta / name / toolCallId…）由 `mapPiEvent` 保证是原始类型。
 * 失败（循环引用、BigInt、含 toJSON 抛错的对象）返回 undefined 而不是抛 —— 丢一个展示用的
 * 详情字段，远好过让整条事件消失或炸掉 agent loop。
 */
function sanitizeForIpc(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

/** 对承载自由形状载荷的事件做一次净化（其余事件原样返回，避免无谓拷贝）。 */
export function sanitizePiSessionEvent(ev: PiSessionEvent): PiSessionEvent {
  // 只有 tool-start.input 是「模型自由构造的入参对象」，其余字段由 mapPiEvent 保证是原始类型
  //（todo 事件的 todos 已由 normalizePiTodos 逐字段重建，天然可克隆）。
  if (ev.type !== "tool-start" || ev.input === undefined) return ev;
  const input = sanitizeForIpc(ev.input);
  if (input !== undefined) return { ...ev, input };
  // 净化失败（循环引用等）：丢掉 input 而不是丢掉整条事件，工具行仍能正常展示名称与 detail。
  const rest: PiSessionEvent = { ...ev };
  delete (rest as { input?: unknown }).input;
  return rest;
}

/**
 * 建一个事件泵。
 *
 * 停止后丢弃残余事件的理由与旧路径 `PiRpcSession.feed()` 的 stopped 守卫**完全相同**：
 * 同一个 uiSessionId 重开会话时，旧 AgentSession 的 dispose 与新会话的 subscribe 之间存在
 * 微小窗口，不丢弃就会把上一个会话的尾巴事件串进新会话的消息流。
 */
export function createPiEventPump(options: PiEventPumpOptions): PiEventPump {
  const { onEvent, getRunId, onFault, isStopped, prepareRaw } = options;

  const handle = (raw: unknown): void => {
    // 整个函数体包在 try 里：见文件头「异常边界」——本函数在 pi 的 agent loop 栈上执行。
    try {
      if (isStopped?.()) return;
      const mapped = mapPiEvent(prepareRaw?.(raw) ?? raw);
      if (!mapped) return; // 忽略清单（entry_appended / bash_execution_update / summarization_* 等）
      onEvent(sanitizePiSessionEvent(mapped), getRunId?.());
    } catch (err) {
      try {
        log.error("pi in-process 事件处理失败（已隔离，不影响 agent loop）", {
          error: err instanceof Error ? err.message : String(err),
          rawType: (raw as { type?: unknown } | null)?.type,
        });
      } catch {
        /* 日志失败也不允许冒泡 */
      }
      try {
        onFault?.(err, raw);
      } catch {
        /* 故障回调自身抛错同样不允许冒泡 */
      }
    }
  };

  return {
    handle,
    attach: (session) => session.subscribe(handle),
  };
}
