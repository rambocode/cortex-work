// 个人会话内联过程流的纯逻辑层：原始事件配对、阶段分组与耗时格式化。
// 从 ConversationProcessTimeline.tsx 抽出，渲染层只负责把这里的结果画成规格 3a 的时间线。
import { cleanToolName, type RunEvent } from "@cortex-work/core";
import type { AgentLogItem, Message } from "@cortex-work/core/types";

export type ProcessMessage = Extract<Message, { kind: "reasoning" | "agentLog" | "stageTitle" }>;

export interface ToolInvocation {
  key: string;
  name: string;
  detail?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  running: boolean;
  /** 工具 start 事件到达时刻；缺 start 帧（只收到 end）时为空，耗时不显示而非猜测。 */
  startedAt?: number;
  /** 工具 end 事件到达时刻；运行中为空。 */
  endedAt?: number;
}

export type ProcessEntry =
  | { kind: "reasoning"; key: string; message: Extract<ProcessMessage, { kind: "reasoning" }> }
  | { kind: "stage"; key: string; label: string }
  | { kind: "tool"; key: string; item: AgentLogItem; invocation?: ToolInvocation };

/** 一个可折叠的「阶段」：连续的思考 + 工具调用聚合体，是折叠的最小单位（规格 §3）。 */
export interface ProcessStage {
  key: string;
  /** 具名阶段（三段编排的 stageTitle）才有；缺省阶段由渲染层用「工作过程」兜底。 */
  label?: string;
  entries: Array<Exclude<ProcessEntry, { kind: "stage" }>>;
  /** 步数 = 思考行 + 工具行总数。 */
  stepCount: number;
  /** 去重后读取到的文件数。 */
  readCount: number;
  /** 非读取类工具调用次数。 */
  toolCount: number;
  /** 阶段内是否还有运行中的条目。 */
  running: boolean;
  /** 阶段内出现过失败的工具调用：规格 §8 要求失败的阶段保持展开、标题转红。 */
  failed: boolean;
  /** 阶段首个工具事件到达时刻；运行中的阶段靠它 + 现在时刻推算实时耗时。 */
  startedAt?: number;
  /** 阶段耗时（毫秒）；阶段内没有任何带时间戳的工具事件时为空。 */
  elapsedMs?: number;
}

const READ_TOOLS = new Set(["read", "read_file", "readfile"]);
const TARGET_KEYS = ["file_path", "filePath", "path", "filename", "query", "pattern", "command", "cmd"];

export function normalizedToolName(name: string | undefined): string {
  const raw = name?.trim().toLowerCase() ?? "";
  const mcpParts = raw.split("__").filter(Boolean);
  return mcpParts.length > 1 ? mcpParts[mcpParts.length - 1]! : raw;
}

export function isReadTool(name: string | undefined): boolean {
  const normalized = normalizedToolName(name);
  return READ_TOOLS.has(normalized) || normalized.startsWith("read_") || normalized.endsWith("_read_file");
}

export function jsonPreview(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/** 从常见工具参数中提取可读目标；未知工具仍回退 detail/现有摘要，不能猜测字段语义。 */
export function inputTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 原始事件按会话跨轮累积，内联过程只能消费最后一轮。工具 start/end 优先按 toolCallId 配对；
 * 缺 id 时回配最近同名的运行项，仍配不到才保留独立结果，避免悄悄丢失输出。
 */
export function buildCurrentRunToolInvocations(events: RunEvent[]): ToolInvocation[] {
  const lastRunId = events[events.length - 1]?.runId;
  if (!lastRunId) return [];
  const invocations: ToolInvocation[] = [];
  const openByCallId = new Map<string, ToolInvocation>();

  for (const record of events) {
    if (record.runId !== lastRunId || record.ev.type !== "tool") continue;
    const ev = record.ev;
    // 子代理的工具事件归它自己的卡片（预览 / 查看过程），不进主会话时间线——主会话的过程摘要
    // 与工具胶囊只描述这条会话自己干的活。core 侧已不把它们折进 process 流，这里同口径过滤，
    // 免得残留的原始事件被顺序回配到主会话某个工具行上，贴出另一个 agent 的 input/output。
    if (ev.subagentCallId || ev.roleId) continue;
    if (ev.phase !== "end") {
      const invocation: ToolInvocation = {
        key: ev.toolCallId ? `tool-${ev.toolCallId}` : `tool-${invocations.length}`,
        name: cleanToolName(ev.name) || ev.name,
        detail: ev.detail,
        input: ev.input,
        output: ev.output,
        isError: ev.isError,
        // 兼容未显式标 phase 的调用帧：只要尚无输出就先视为打开，最终还会与 process item 状态交叉确认。
        running: ev.output === undefined,
        startedAt: record.ts,
      };
      invocations.push(invocation);
      if (ev.toolCallId) openByCallId.set(ev.toolCallId, invocation);
      continue;
    }

    let open = ev.toolCallId ? openByCallId.get(ev.toolCallId) : undefined;
    if (!open) {
      const normalized = normalizedToolName(ev.name);
      open = [...invocations].reverse().find(
        (candidate) => candidate.running && normalizedToolName(candidate.name) === normalized,
      );
    }
    if (open) {
      open.detail = ev.detail ?? open.detail;
      open.input = ev.input ?? open.input;
      open.output = ev.output;
      open.isError = ev.isError;
      open.running = false;
      open.endedAt = record.ts;
      if (ev.toolCallId) openByCallId.delete(ev.toolCallId);
    } else {
      invocations.push({
        key: ev.toolCallId ? `tool-result-${ev.toolCallId}` : `tool-result-${invocations.length}`,
        name: cleanToolName(ev.name) || ev.name,
        detail: ev.detail,
        input: ev.input,
        output: ev.output,
        isError: ev.isError,
        running: false,
        endedAt: record.ts,
      });
    }
  }
  return invocations;
}

/** 把过程摘要与原始工具事件按顺序/名称对齐；原始事件缺失时仍保留摘要列表。 */
export function buildProcessEntries(messages: Message[], invocations: ToolInvocation[]): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  const usedInvocations = new Set<string>();

  const matchInvocation = (item: AgentLogItem): ToolInvocation | undefined => {
    const expected = normalizedToolName(item.toolName);
    const named = expected
      ? invocations.find(
          (invocation) => !usedInvocations.has(invocation.key) && normalizedToolName(invocation.name) === expected,
        )
      : undefined;
    const matched = named ?? invocations.find((invocation) => !usedInvocations.has(invocation.key));
    if (matched) usedInvocations.add(matched.key);
    return matched;
  };

  for (const message of messages) {
    if (message.kind === "reasoning") {
      entries.push({ kind: "reasoning", key: message.uid ?? `reasoning-${entries.length}`, message });
    } else if (message.kind === "stageTitle") {
      entries.push({ kind: "stage", key: message.uid ?? `stage-${entries.length}`, label: message.label });
    } else if (message.kind === "agentLog") {
      message.items.forEach((item, index) => {
        const invocation = matchInvocation(item);
        entries.push({
          kind: "tool",
          key: invocation?.key ?? `${message.uid ?? "agent-log"}-${index}`,
          item,
          invocation,
        });
      });
    }
  }

  // 列表结构只由 process 摘要决定；runEvents 仅补 input/output。两条流独立节流，若把尚未匹配的
  // 原始事件主动追加，摘要追上时同一工具会换位置/重建，流式输出期间会造成可见闪烁。
  return entries;
}

/** 单条工具条目的运行态：process item 是用户可见状态真值，原始事件只做交叉确认。 */
export function toolEntryRunning(entry: Extract<ProcessEntry, { kind: "tool" }>): boolean {
  return entry.item.ic === "running" && (entry.invocation?.running ?? true);
}

/** 工具条目的可读目标（文件路径 / 命令参数），用于摘要去重与胶囊上的参数段。 */
export function toolEntryTarget(entry: Extract<ProcessEntry, { kind: "tool" }>): string | undefined {
  return entry.invocation?.detail ?? inputTarget(entry.invocation?.input) ?? entry.item.detail;
}

/**
 * 按 stageTitle 把条目切成阶段。没有段边界信号的普通会话只会得到一个缺省阶段——这与规格
 * §3「连续的思考 + 工具调用聚合为一个阶段」一致，不为了分段而伪造后端不存在的阶段语义。
 */
export function groupProcessStages(entries: ProcessEntry[]): ProcessStage[] {
  const stages: ProcessStage[] = [];
  let current: ProcessStage | null = null;

  const ensure = (key: string, label?: string): ProcessStage => {
    const stage: ProcessStage = {
      key,
      label,
      entries: [],
      stepCount: 0,
      readCount: 0,
      toolCount: 0,
      running: false,
      failed: false,
    };
    stages.push(stage);
    current = stage;
    return stage;
  };

  for (const entry of entries) {
    if (entry.kind === "stage") {
      ensure(entry.key, entry.label);
      continue;
    }
    const stage = current ?? ensure("stage-default");
    stage.entries.push(entry);
  }

  for (const stage of stages) {
    // 摘要说的是「文件」而不是「读取次数」：有路径时按路径去重；无法识别目标的调用各算一个。
    const knownReadTargets = new Set<string>();
    let unknownReadTargets = 0;
    let firstTs: number | undefined;
    let lastTs: number | undefined;

    for (const entry of stage.entries) {
      stage.stepCount += 1;
      if (entry.kind === "reasoning") {
        stage.running ||= entry.message.active === true;
        continue;
      }
      const running = toolEntryRunning(entry);
      stage.running ||= running;
      stage.failed ||= entry.invocation?.isError === true;
      if (isReadTool(entry.item.toolName ?? entry.invocation?.name)) {
        const target = toolEntryTarget(entry);
        if (target) knownReadTargets.add(target);
        else unknownReadTargets += 1;
      } else {
        stage.toolCount += 1;
      }
      const started = entry.invocation?.startedAt;
      const ended = entry.invocation?.endedAt;
      if (started !== undefined) firstTs = firstTs === undefined ? started : Math.min(firstTs, started);
      if (ended !== undefined) lastTs = lastTs === undefined ? ended : Math.max(lastTs, ended);
    }

    stage.readCount = knownReadTargets.size + unknownReadTargets;
    stage.startedAt = firstTs;
    // 只有「首尾都拿到真实时间戳」才给耗时。运行中的阶段末尾时间未知，交给渲染层用现在时刻推算。
    if (firstTs !== undefined && lastTs !== undefined && lastTs >= firstTs) stage.elapsedMs = lastTs - firstTs;
  }

  return stages.filter((stage) => stage.entries.length > 0);
}

/**
 * 当前这一轮的真实时间跨度：取最后一个 runId 名下**所有**事件的首尾到达时刻。
 *
 * 刻意不复用阶段的 startedAt/elapsedMs——那两个只统计工具事件，遇到「只思考不调工具」的轮次
 * 会算不出耗时；也刻意不过滤子代理事件：委派出去的那段时间用户是真的在等，算进整轮耗时才诚实
 *（与「子代理工具不进主会话过程流」是两件事，后者说的是归属，这里说的是时长）。
 */
export function currentRunTimeSpan(events: RunEvent[]): { startedAt?: number; endedAt?: number } {
  const lastRunId = events[events.length - 1]?.runId;
  if (!lastRunId) return {};
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const record of events) {
    if (record.runId !== lastRunId) continue;
    if (startedAt === undefined || record.ts < startedAt) startedAt = record.ts;
    if (endedAt === undefined || record.ts > endedAt) endedAt = record.ts;
  }
  return { startedAt, endedAt };
}

/** 阶段/子任务级耗时：一律 `m:ss`（规格里的 1:12 / 0:41）。 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/** 单次工具耗时：不足一分钟用 `0.6s`（规格胶囊上的秒级精度），超过则退回 `m:ss`。 */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) return formatClock(ms);
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}
