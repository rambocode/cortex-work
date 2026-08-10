// 个人会话内联工作过程：交互层级对齐 Kun。
// 第一层在轮次结束后只保留总步数和分类统计；第二层列出思考、读取文件与工具调用；
// 第三层按项展开 reasoning 或当前轮原始 tool input/output。完整事件仍是瞬态数据，不改变落盘边界。
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  cleanToolName,
  usePersonalRunEvents,
  usePersonalStore,
  type RunEvent,
} from "@cortex-work/core";
import type { AgentLogItem, Message } from "@cortex-work/core/types";
import { renderRich } from "../../rich";

type ProcessMessage = Extract<Message, { kind: "reasoning" | "agentLog" | "stageTitle" }>;

interface ToolInvocation {
  key: string;
  name: string;
  detail?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  running: boolean;
}

type ProcessEntry =
  | { kind: "reasoning"; key: string; message: Extract<ProcessMessage, { kind: "reasoning" }> }
  | { kind: "stage"; key: string; label: string }
  | { kind: "tool"; key: string; item: AgentLogItem; invocation?: ToolInvocation };

const READ_TOOLS = new Set(["read", "read_file", "readfile"]);
const TARGET_KEYS = ["file_path", "filePath", "path", "filename", "query", "pattern", "command", "cmd"];

function normalizedToolName(name: string | undefined): string {
  const raw = name?.trim().toLowerCase() ?? "";
  const mcpParts = raw.split("__").filter(Boolean);
  return mcpParts.length > 1 ? mcpParts[mcpParts.length - 1]! : raw;
}

function isReadTool(name: string | undefined): boolean {
  const normalized = normalizedToolName(name);
  return READ_TOOLS.has(normalized) || normalized.startsWith("read_") || normalized.endsWith("_read_file");
}

function jsonPreview(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/** 从常见工具参数中提取可读目标；未知工具仍回退 detail/现有摘要，不能猜测字段语义。 */
function inputTarget(input: unknown): string | undefined {
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
      });
    }
  }
  return invocations;
}

/** 把过程摘要与原始工具事件按顺序/名称对齐；原始事件缺失时仍保留摘要列表。 */
function buildProcessEntries(messages: Message[], invocations: ToolInvocation[]): ProcessEntry[] {
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

function ProcessEntryRow({ entry }: { entry: Exclude<ProcessEntry, { kind: "stage" }> }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  if (entry.kind === "reasoning") {
    const active = entry.message.active === true;
    return (
      <div className="pw-conversation-process-item" data-kind="reasoning" data-active={active}>
        <button
          type="button"
          className="pw-conversation-process-item-main"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon.Sparkle size={14} />
          <span className={active ? "pw-conversation-process-live" : undefined}>
            {t(active ? "processInline.thinkingNow" : "processInline.thinking")}
          </span>
          <span className="pw-conversation-process-item-chevron" data-open={expanded} aria-hidden="true">
            <Icon.ChevronRight size={13} />
          </span>
        </button>
        {expanded ? <div className="pw-conversation-process-reasoning">{renderRich(entry.message.text)}</div> : null}
      </div>
    );
  }

  const invocation = entry.invocation;
  const target = invocation?.detail ?? inputTarget(invocation?.input) ?? entry.item.detail;
  // process item 是用户可见状态真值；原始 start 未及时收到 end 时，后续摘要翻为 check 也必须停止流光。
  const running = entry.item.ic === "running" && (invocation?.running ?? true);
  const hasDetails = invocation?.input !== undefined || invocation?.output !== undefined || !!target;
  return (
    <div className="pw-conversation-process-item" data-kind="tool" data-active={running}>
      <button
        type="button"
        className="pw-conversation-process-item-main"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {isReadTool(entry.item.toolName ?? invocation?.name) ? (
          <Icon.File size={14} />
        ) : (
          <Icon.Terminal size={14} />
        )}
        <span className={running ? "pw-conversation-process-live" : undefined}>
          {renderRich(entry.item.text)}
        </span>
        {invocation?.isError ? <Icon.XCircle size={13} /> : null}
        <span className="pw-conversation-process-item-chevron" data-open={expanded} aria-hidden="true">
          <Icon.ChevronRight size={13} />
        </span>
      </button>
      {expanded ? (
        <div className="pw-conversation-process-item-detail">
          {invocation?.input !== undefined ? (
            <div className="pw-conversation-process-block">
              <span>{t("transcript.input")}</span>
              <pre>{jsonPreview(invocation.input)}</pre>
            </div>
          ) : null}
          {invocation?.output !== undefined ? (
            <div className="pw-conversation-process-block is-output">
              <span>{t("transcript.output")}</span>
              <pre>{invocation.output}</pre>
            </div>
          ) : null}
          {!hasDetails ? <div className="pw-conversation-process-empty">{t("processInline.noDetails")}</div> : null}
          {hasDetails && invocation?.input === undefined && invocation?.output === undefined ? (
            <div className="pw-conversation-process-target">{target}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ConversationProcessTimeline({ messages, sessionId }: { messages: Message[]; sessionId?: string }) {
  const { t } = useTranslation("chat");
  const requestOpenProcessPanel = usePersonalStore((state) => state.requestOpenProcessPanel);
  const runEvents = usePersonalRunEvents(sessionId);
  const invocations = useMemo(() => buildCurrentRunToolInvocations(runEvents), [runEvents]);
  const entries = useMemo(() => buildProcessEntries(messages, invocations), [messages, invocations]);
  const messageActive = messages.some(
    (message) => (message.kind === "reasoning" || message.kind === "agentLog") && message.active === true,
  );
  const sessionRunning = usePersonalStore((state) => (sessionId ? !!state.runningBySession[sessionId] : false));
  // 单条 reasoning/tool 在切相时会先收尾、再创建下一条，期间所有 message 都可能短暂 inactive。
  // 整段折叠必须跟随会话生命周期，否则一次切相就会触发「收起→展开」的布局闪烁。
  const active = sessionRunning || messageActive;
  const [expanded, setExpanded] = useState(active);
  const previousActive = useRef(active);
  const previousSessionId = useRef(sessionId);

  // 新一轮运行时自动展开；从运行态进入完成态时自动折叠。用户在同一状态内手动收起/展开不会被刷新打断。
  useEffect(() => {
    if (previousSessionId.current !== sessionId) {
      previousSessionId.current = sessionId;
      previousActive.current = active;
      setExpanded(active);
      return;
    }
    if (active !== previousActive.current) {
      setExpanded(active);
      previousActive.current = active;
    }
  }, [active, sessionId]);

  const actionableEntries = entries.filter((entry) => entry.kind !== "stage");
  if (actionableEntries.length === 0) return null;
  const readEntries = actionableEntries.filter(
    (entry): entry is Extract<ProcessEntry, { kind: "tool" }> =>
      entry.kind === "tool" && isReadTool(entry.item.toolName ?? entry.invocation?.name),
  );
  // 摘要说的是「文件」而不是「读取次数」：有路径时按路径去重；无法识别目标的调用各算一个。
  const knownReadTargets = new Set<string>();
  let unknownReadTargets = 0;
  for (const entry of readEntries) {
    const target = entry.invocation?.detail ?? inputTarget(entry.invocation?.input) ?? entry.item.detail;
    if (target) knownReadTargets.add(target);
    else unknownReadTargets += 1;
  }
  const readCount = knownReadTargets.size + unknownReadTargets;
  const toolCount = actionableEntries.filter(
    (entry) => entry.kind === "tool" && !isReadTool(entry.item.toolName ?? entry.invocation?.name),
  ).length;
  const summary: string[] = [];
  if (readCount > 0) {
    summary.push(t(readCount === 1 ? "processInline.readSummaryOne" : "processInline.readSummaryMany", { count: readCount }));
  }
  if (toolCount > 0) {
    summary.push(t(toolCount === 1 ? "processInline.toolSummaryOne" : "processInline.toolSummaryMany", { count: toolCount }));
  }

  return (
    <div className="pw-conversation-process" data-testid="conversation-process" data-active={active}>
      <button
        type="button"
        className="pw-conversation-process-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon.Task size={16} />
        <span className={active ? "pw-conversation-process-live" : undefined}>
          {t("processInline.workTitle", { count: actionableEntries.length })}
        </span>
        {summary.length > 0 ? <span className="pw-conversation-process-summary">· {summary.join(" · ")}</span> : null}
        <span className="pw-conversation-process-header-chevron" data-open={expanded} aria-hidden="true">
          <Icon.ChevronRight size={14} />
        </span>
      </button>
      {expanded ? (
        <div className="pw-conversation-process-list">
          {entries.map((entry) =>
            entry.kind === "stage" ? (
              <div className="pw-conversation-process-stage" key={entry.key}>{entry.label}</div>
            ) : (
              <ProcessEntryRow key={entry.key} entry={entry} />
            ),
          )}
          {sessionId ? (
            <button
              type="button"
              className="pw-conversation-process-more"
              onClick={() => requestOpenProcessPanel(sessionId)}
            >
              {t("processInline.openTranscript")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
