// 子代理工具循环熔断器：只消费单个 child 的归一化工具事件，不持有父会话或进程对象。
// 调用方为每次 subagentCallId 新建实例，因此并行 child 的计数、挂起调用和熔断结果天然隔离。

import { createHash } from "node:crypto";

import type { CliStreamEvent } from "../../ipc/types";

/** 同一工具、参数和错误允许出现的最大次数；第 3 次失败完成后终止当前 child。 */
export const CHILD_TOOL_FAILURE_LIMIT = 3;
/** 无进展循环的观察窗口；前后各 4 次完全相同时判定为重复循环。 */
export const CHILD_TOOL_CYCLE_WINDOW = 8;

export type ChildToolLoopKind = "repeated-failure" | "repeating-cycle";

/** 熔断结果只包含可安全展示的摘要，不暴露可能含凭据或私有路径的工具参数与输出。 */
export interface ChildToolLoopTrip {
  kind: ChildToolLoopKind;
  message: string;
  toolName?: string;
  repeatCount: number;
}

interface PendingToolCall {
  toolName: string;
  callFingerprint: string;
}

interface CompletedToolCall {
  fingerprint: string;
  isError: boolean;
  toolName: string;
}

/**
 * 为 JSON 型工具参数生成稳定表示：对象键顺序不影响指纹，字符串内容（包括路径空格）原样保留。
 * 非 JSON 值仅作防御性编码；循环引用不会抛错，也不会把原值写入日志。
 */
function stableSerialize(value: unknown, parents = new Set<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Infinity) return "number:Infinity";
    if (value === -Infinity) return "number:-Infinity";
    return `number:${value}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "symbol") return `symbol:${value.description ?? ""}`;
  if (typeof value === "function") return `function:${value.name || "anonymous"}`;

  const object = value as object;
  if (parents.has(object)) return "[Circular]";
  parents.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item, parents)).join(",")}]`;
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item, parents)}`)
      .join(",")}}`;
  } finally {
    parents.delete(object);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function repeatedFailureMessage(toolName: string, count: number): string {
  return `子 Agent 工具「${toolName}」以相同参数和错误重复失败 ${count} 次，已停止当前子任务以避免继续重复调用。`;
}

function repeatingCycleMessage(): string {
  return `子 Agent 最近 ${CHILD_TOOL_CYCLE_WINDOW} 次工具调用形成重复且无进展的循环，已停止当前子任务以避免继续消耗资源。`;
}

/**
 * 观察一个 child 的工具 start/end 流，并在确定性重复失败或有错误的完整重复窗口出现时熔断。
 *
 * start/end 必须通过 toolCallId 配对；缺 ID 的旧事件不参与判断，避免并行工具完成乱序时误配。
 * 同一调用成功后会清除它此前的失败计数，允许真实的瞬态故障恢复；其他工具成功不会清除该计数，
 * 因而能识别“错误路径 A、成功路径 B、再次错误路径 A”的震荡。
 */
export class ChildToolLoopGuard {
  private readonly pending = new Map<string, PendingToolCall>();
  private readonly failureCounts = new Map<string, Map<string, number>>();
  private readonly completed: CompletedToolCall[] = [];
  private tripped = false;

  observe(event: CliStreamEvent): ChildToolLoopTrip | undefined {
    if (this.tripped || event.type !== "tool" || !event.toolCallId) return undefined;

    if (event.phase === "start") {
      this.pending.set(event.toolCallId, {
        toolName: event.name,
        callFingerprint: `${event.name}:${digest(event.input)}`,
      });
      return undefined;
    }
    if (event.phase !== "end") return undefined;

    const pending = this.pending.get(event.toolCallId);
    this.pending.delete(event.toolCallId);
    if (!pending || pending.toolName !== event.name) return undefined;

    const outputFingerprint = digest(event.output);
    this.completed.push({
      fingerprint: `${pending.callFingerprint}:${event.isError === true ? "error" : "ok"}:${outputFingerprint}`,
      isError: event.isError === true,
      toolName: event.name,
    });
    if (this.completed.length > CHILD_TOOL_CYCLE_WINDOW) this.completed.shift();

    if (event.isError === true) {
      const byOutput = this.failureCounts.get(pending.callFingerprint) ?? new Map<string, number>();
      const count = (byOutput.get(outputFingerprint) ?? 0) + 1;
      byOutput.set(outputFingerprint, count);
      this.failureCounts.set(pending.callFingerprint, byOutput);
      if (count >= CHILD_TOOL_FAILURE_LIMIT) {
        return this.trip({
          kind: "repeated-failure",
          message: repeatedFailureMessage(event.name, count),
          toolName: event.name,
          repeatCount: count,
        });
      }
    } else {
      // 同一参数已经成功，之前的失败属于可恢复故障；后续再失败应从 1 重新计数。
      this.failureCounts.delete(pending.callFingerprint);
    }

    if (this.isRepeatingErrorCycle()) {
      const toolNames = new Set(this.completed.map((item) => item.toolName));
      return this.trip({
        kind: "repeating-cycle",
        message: repeatingCycleMessage(),
        ...(toolNames.size === 1 ? { toolName: this.completed[0]?.toolName } : {}),
        repeatCount: CHILD_TOOL_CYCLE_WINDOW,
      });
    }
    return undefined;
  }

  private isRepeatingErrorCycle(): boolean {
    if (this.completed.length !== CHILD_TOOL_CYCLE_WINDOW) return false;
    if (!this.completed.some((item) => item.isError)) return false;
    const half = CHILD_TOOL_CYCLE_WINDOW / 2;
    for (let index = 0; index < half; index += 1) {
      if (this.completed[index]?.fingerprint !== this.completed[index + half]?.fingerprint) return false;
    }
    return true;
  }

  private trip(result: ChildToolLoopTrip): ChildToolLoopTrip {
    this.tripped = true;
    return result;
  }
}
