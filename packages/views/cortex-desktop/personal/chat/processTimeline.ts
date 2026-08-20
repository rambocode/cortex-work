// 个人会话内联过程流的纯逻辑层：阶段分组、摘要统计与耗时格式化。
// 从 ConversationProcessTimeline.tsx 抽出，渲染层只负责把这里的结果画成规格 3a 的时间线。
//
// 工具 start/end 的配对与本轮时间跨度已下沉到 core 的 process-archive.ts —— 归档(历史轮)与内联
// 时间线(当前轮)必须用同一份配对逻辑，否则「实时看到的过程」与「回看的过程」会漂移。
import { collectRunInvocations, normalizedToolName, runTimeSpan, type RunEvent } from "@cortex-work/core";
import type { ArchivedToolInvocation } from "@cortex-work/core";
import type { AgentLogItem, Message, RichText } from "@cortex-work/core/types";

export type ProcessMessage = Extract<Message, { kind: "reasoning" | "agentLog" | "stageTitle" }>;

/** 一次工具调用（含输入/输出快照）。结构由 core 定义，归档与内联时间线共用同一形状。 */
export type ToolInvocation = ArchivedToolInvocation;

export { normalizedToolName };

export type ProcessEntry =
  | { kind: "reasoning"; key: string; message: Extract<ProcessMessage, { kind: "reasoning" }> }
  | { kind: "stage"; key: string; label: string }
  | { kind: "tool"; key: string; item: AgentLogItem; invocation?: ToolInvocation };

/** 聊天流的紧凑活动行；详情仍由原始 invocation 与完整过程面板承担。 */
export type ProcessActivityRow =
  | {
      kind: "reasoning";
      key: string;
      /** 完整思考正文；200 字预览与展开只属于渲染层，归档数据不能在这里被截断。 */
      text: string;
      status: "running" | "done";
    }
  | {
      kind: "read-group";
      key: string;
      labels: string[];
      count: number;
      callIds: string[];
      status: "running" | "done" | "failed";
    }
  | {
      kind: "file";
      key: string;
      action: "modify" | "delete";
      label: string;
      callId?: string;
      status: "running" | "done" | "failed";
      durationMs?: number;
    }
  | {
      kind: "command";
      key: string;
      action: "execute";
      callId?: string;
      status: "running" | "done" | "failed";
      durationMs?: number;
    };

export interface ProcessPresentation {
  stages: Array<{
    key: string;
    label?: string;
    rows: ProcessActivityRow[];
    running: boolean;
    failed: boolean;
  }>;
  summary: {
    steps: number;
    files: number;
    commands: number;
    tools: number;
    failed: number;
    running: boolean;
  };
}

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
 * 原始事件按会话跨轮累积，内联过程只能消费最后一轮：取末条事件的 runId 交给 core 的配对逻辑。
 */
export function buildCurrentRunToolInvocations(events: RunEvent[]): ToolInvocation[] {
  return collectRunInvocations(events, events[events.length - 1]?.runId);
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

const COMMAND_TOOLS = new Set(["bash", "shell", "command", "exec", "run_command"]);
const HIDDEN_ACTIVITY_TOOLS = new Set(["tool_search", "toolsearch"]);
const TODO_TOOLS = new Set(["todo_write", "todowrite"]);
const MODIFY_FILE_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "edit_file",
  "write_file",
  "replace_file",
  "patch_file",
]);
const DELETE_FILE_TOOLS = new Set(["delete", "remove", "unlink", "delete_file", "remove_file", "unlink_file"]);

/** tool invocation 的稳定 callId；历史归档兼容旧格式时只能由 key 反推。 */
function callIdOf(entry: Extract<ProcessEntry, { kind: "tool" }>): string | undefined {
  const key = entry.invocation?.key;
  return key?.startsWith("tool-") ? key.slice("tool-".length) : undefined;
}

/**
 * 聊天流只显示文件名，绝不暴露工作区路径；POSIX 与 Windows 分隔符都在这里统一处理。
 * 目标为空或只含分隔符时保留原值，避免伪造一个不存在的文件名。
 */
function displayFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

/** 过程摘要兼容 RichText；活动台账只需要无样式的可读文字，链接/代码样式由完整面板保留。 */
function plainText(value: RichText): string {
  return typeof value === "string" ? value : value.parts.map((part) => part.v).join("");
}

function entryStatus(entry: Extract<ProcessEntry, { kind: "tool" }>): "running" | "done" | "failed" {
  if (entry.invocation?.isError) return "failed";
  return toolEntryRunning(entry) ? "running" : "done";
}

function entryDuration(entry: Extract<ProcessEntry, { kind: "tool" }>): number | undefined {
  const { startedAt, endedAt } = entry.invocation ?? {};
  return startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt ? endedAt - startedAt : undefined;
}

/**
 * 由过程条目生成聊天流唯一的活动台账。
 *
 * 这层只投影展示：不改变 entries、invocation 或归档，也不会丢掉完整 input/output。连续成功 read
 * 才能聚合；失败 read 独立保留，避免用户在一条「读取成功」里看不到真实失败。
 */
export function buildProcessPresentation(
  stages: ProcessStage[],
): ProcessPresentation {
  const summary: ProcessPresentation["summary"] = {
    steps: 0,
    files: 0,
    commands: 0,
    tools: 0,
    failed: 0,
    running: false,
  };
  const successfulReadTargets = new Set<string>();

  const presentationStages = stages.map((stage) => {
    const rows: ProcessActivityRow[] = [];
    // 展示标签只留 basename，但计数仍按真实目标去重；否则 `src/a.ts` 与 `test/a.ts` 会被误算成
    // 同一个文件。该集合不进入返回值，工作区路径不会泄露到聊天流的展示模型。
    const readTargetsByRow = new Map<string, Set<string>>();
    for (const entry of stage.entries) {
      if (entry.kind === "reasoning") {
        const status = entry.message.active ? "running" : "done";
        const text = plainText(entry.message.text).trim();
        const previous = rows.at(-1);
        // reasoning 是流式增量；同一段只保留一条最新状态，不能随着 token 增长堆出列表。
        if (previous?.kind === "reasoning") {
          previous.status = status;
          previous.text = text || previous.text;
        } else {
          rows.push({ kind: "reasoning", key: entry.key, text, status });
        }
        summary.steps += 1;
        summary.running ||= status === "running";
        continue;
      }

      const name = normalizedToolName(entry.item.toolName ?? entry.invocation?.name);
      if (HIDDEN_ACTIVITY_TOOLS.has(name)) continue;
      const status = entryStatus(entry);
      const callId = callIdOf(entry);
      const target = toolEntryTarget(entry);
      const isRead = isReadTool(entry.item.toolName ?? entry.invocation?.name);

      if (isRead) {
        const path = target ? displayFileName(target) : plainText(entry.item.text);
        const identity = target ?? entry.key;
        const previous = rows.at(-1);
        if (status !== "failed" && previous?.kind === "read-group" && previous.status !== "failed") {
          if (!previous.labels.includes(path)) previous.labels.push(path);
          if (callId && !previous.callIds.includes(callId)) previous.callIds.push(callId);
          const identities = readTargetsByRow.get(previous.key) ?? new Set<string>();
          identities.add(identity);
          readTargetsByRow.set(previous.key, identities);
          previous.count = identities.size;
          previous.status = status;
        } else {
          rows.push({
            kind: "read-group",
            key: entry.key,
            labels: [path],
            count: 1,
            callIds: callId ? [callId] : [],
            status,
          });
          if (status !== "failed") readTargetsByRow.set(entry.key, new Set([identity]));
        }
        if (status !== "failed") successfulReadTargets.add(target ?? path);
        summary.steps += 1;
        if (status === "failed") summary.failed += 1;
        summary.running ||= status === "running";
        continue;
      }

      const command = COMMAND_TOOLS.has(name);
      const fileAction = MODIFY_FILE_TOOLS.has(name) ? "modify" : DELETE_FILE_TOOLS.has(name) ? "delete" : undefined;
      const common = {
        key: entry.key,
        ...(callId ? { callId } : {}),
        status,
        ...(entryDuration(entry) !== undefined ? { durationMs: entryDuration(entry) } : {}),
      };
      // 文件动作只有拿到明确目标时才显示文件名；参数缺失时宁可降级成「执行命令」，不能把
      // agentLog 的自由文本误当成文件名。完整名称、参数和输出仍保留在过程面板。
      const row: ProcessActivityRow = fileAction && target
        ? { kind: "file", action: fileAction, label: displayFileName(target), ...common }
        : { kind: "command", action: "execute", ...common };

      // todo_write 的每个调用都是整表快照，连续快照只以最新状态替换前一个活动行。
      const previous = rows.at(-1);
      if (TODO_TOOLS.has(name) && previous?.kind === "command" && previous.key.startsWith("todo-")) {
        rows[rows.length - 1] = { ...row, key: `todo-${entry.key}` };
      } else {
        rows.push(TODO_TOOLS.has(name) ? { ...row, key: `todo-${entry.key}` } : row);
      }
      summary.steps += 1;
      if (command) summary.commands += 1;
      else summary.tools += 1;
      if (status === "failed") summary.failed += 1;
      summary.running ||= status === "running";
    }

    return { key: stage.key, label: stage.label, rows, running: stage.running, failed: stage.failed };
  });

  summary.files = successfulReadTargets.size;
  return { stages: presentationStages, summary };
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
 * 当前这一轮的真实时间跨度：取最后一个 runId 名下**所有**事件的首尾到达时刻（实现在 core，
 * 与归档共用）。
 *
 * 刻意不复用阶段的 startedAt/elapsedMs——那两个只统计工具事件，遇到「只思考不调工具」的轮次
 * 会算不出耗时；也刻意不过滤子代理事件：委派出去的那段时间用户是真的在等，算进整轮耗时才诚实
 *（与「子代理工具不进主会话过程流」是两件事，后者说的是归属，这里说的是时长）。
 */
export function currentRunTimeSpan(events: RunEvent[]): { startedAt?: number; endedAt?: number } {
  return runTimeSpan(events, events[events.length - 1]?.runId);
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
