// 个人会话内联工作过程（规格 3a §2–§4）：过程区挂在头像中轴的竖线上，每个「阶段」是折叠的
// 最小单位——运行中展开并实时追加，完成后自动折叠为摘要条；工具完成态收成单行胶囊，点开是终端块。
//
// 两个数据源，同一套渲染：
//  - 当前轮：瞬态过程流(messages) + 瞬态原始事件(usePersonalRunEvents)，逐 token 实时更新；
//  - 历史轮：传入 archive（core 在轮末打的快照，落 chats/<id>.process.json），不读瞬态流、
//    恒为完成态。这样重开会话/重启应用后，「已处理 8.8s · N 步 · 调用了 N 个工具」与工具输入
//    输出仍可展开回看。
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalRunEvents, usePersonalStore, type TurnProcessArchive } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { renderRich } from "../../rich";
import {
  buildCurrentRunToolInvocations,
  buildProcessEntries,
  currentRunTimeSpan,
  formatClock,
  formatDuration,
  groupProcessStages,
  inputTarget,
  isReadTool,
  jsonPreview,
  toolEntryRunning,
  toolEntryTarget,
  type ProcessEntry,
  type ProcessStage,
} from "./processTimeline";

// 规格 §4：终端输出超过 8 行截断，尾部给「查看完整输出」。
const TERMINAL_PREVIEW_LINES = 8;
// 规格 §4：运行中的工具只展开输出尾部最近 3 行，完成后才收起为单行胶囊。
const TERMINAL_TAIL_LINES = 3;

export { buildCurrentRunToolInvocations } from "./processTimeline";

/** 运行中的旋转指示器（规格 §3：12px、2px 描边、spin 1s linear infinite）。 */
function ProcessSpinner() {
  return <span className="pw-conversation-process-spinner" aria-hidden="true" />;
}

/** 工具调用输出的终端块：命令原文 → 参数/输出 → exit 行。 */
function ToolTerminal({
  command,
  input,
  output,
  isError,
  running,
  duration,
}: {
  command: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  running: boolean;
  duration?: string;
}) {
  const { t } = useTranslation("chat");
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => (output ? output.replace(/\s+$/, "").split("\n") : []), [output]);
  // 运行中盯的是「刚刚发生了什么」，取尾部 3 行；完成后是回顾，取头部 8 行再给完整入口。
  const limit = running ? TERMINAL_TAIL_LINES : TERMINAL_PREVIEW_LINES;
  const truncated = !showAll && lines.length > limit;
  const visible = truncated ? (running ? lines.slice(-limit) : lines.slice(0, limit)) : lines;
  const exitText = isError
    ? t("processInline.exitFailed")
    : `${t("processInline.exitOk")}${duration ? ` · ${duration}` : ""}`;

  return (
    <div className="pw-conversation-process-term">
      <div className="pw-conversation-process-term-cmd">$ {command}</div>
      {input !== undefined ? (
        <pre className="pw-conversation-process-term-input">{jsonPreview(input)}</pre>
      ) : null}
      {visible.length > 0 ? <pre className="pw-conversation-process-term-out">{visible.join("\n")}</pre> : null}
      {truncated ? (
        <button type="button" className="pw-conversation-process-term-more" onClick={() => setShowAll(true)}>
          {t("processInline.viewFullOutput", { count: lines.length - limit })}
        </button>
      ) : null}
      {/* 还在跑就没有退出码可言，只有收尾后才给 exit 行，避免展示一个尚不成立的结论。 */}
      {running ? null : (
        <div className="pw-conversation-process-term-exit" data-error={isError === true}>
          {isError ? "✕" : "✓"} {exitText}
        </div>
      )}
    </div>
  );
}

/** 单条思考行：正文弱化为 #8A8578，点开看完整 reasoning。 */
function ReasoningRow({ entry }: { entry: Extract<ProcessEntry, { kind: "reasoning" }> }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const active = entry.message.active === true;
  return (
    <div className="pw-conversation-process-item" data-kind="reasoning" data-active={active}>
      <button
        type="button"
        className="pw-conversation-process-item-main"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon.Sparkle size={13} />
        <span className={active ? "pw-conversation-process-live" : undefined}>
          {t(active ? "processInline.thinkingNow" : "processInline.thinking")}
        </span>
        <span className="pw-conversation-process-item-chevron" data-open={expanded} aria-hidden="true">
          <Icon.ChevronRight size={12} />
        </span>
      </button>
      {expanded ? <div className="pw-conversation-process-reasoning">{renderRich(entry.message.text)}</div> : null}
    </div>
  );
}

/**
 * 单个工具调用：完成态是一行胶囊（✓ 命令 参数 耗时 ▾），点开展开终端块。
 * 运行中默认展开输出尾部（规格 §4），完成后回到收起——用户手动切换后以手动状态为准。
 */
function ToolRow({ entry }: { entry: Extract<ProcessEntry, { kind: "tool" }> }) {
  const { t } = useTranslation("chat");
  const running = toolEntryRunning(entry);
  const invocation = entry.invocation;
  const failed = invocation?.isError === true;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // 运行→完成翻转时清掉手动状态，回到「完成即收起」的默认规则。
  useEffect(() => {
    setUserOpen(null);
  }, [running]);
  // 规格 §8：失败的工具默认展开 stderr——出错时用户第一件想看的就是输出，不该再点一次。
  const expanded = userOpen ?? (running || failed);

  const target = toolEntryTarget(entry);
  const hasDetails = invocation?.input !== undefined || invocation?.output !== undefined || !!target;
  const durationMs =
    invocation?.startedAt !== undefined && invocation?.endedAt !== undefined
      ? invocation.endedAt - invocation.startedAt
      : undefined;
  const duration = durationMs !== undefined ? formatDuration(durationMs) : undefined;
  // 终端首行尽量还原用户敲的那条命令；非命令类工具退回「工具名 + 目标」，不臆造 shell 语法。
  const rawCommand = inputTarget(invocation?.input);
  const command = rawCommand ?? `${invocation?.name ?? entry.item.toolName ?? ""}${target ? ` ${target}` : ""}`.trim();

  return (
    <div
      className="pw-conversation-process-item"
      data-kind="tool"
      data-active={running}
      data-error={failed}
    >
      <button
        type="button"
        className="pw-conversation-process-item-main"
        aria-expanded={expanded}
        onClick={() => setUserOpen(!expanded)}
      >
        <span className="pw-conversation-process-item-state" aria-hidden="true">
          {running ? (
            <ProcessSpinner />
          ) : failed ? (
            <Icon.XCircle size={12} />
          ) : isReadTool(entry.item.toolName ?? invocation?.name) ? (
            <Icon.File size={12} />
          ) : (
            <Icon.Check size={12} />
          )}
        </span>
        <span className={running ? "pw-conversation-process-live" : undefined}>{renderRich(entry.item.text)}</span>
        {duration ? <span className="pw-conversation-process-item-time">{duration}</span> : null}
        <span className="pw-conversation-process-item-chevron" data-open={expanded} aria-hidden="true">
          <Icon.Chevron size={11} />
        </span>
      </button>
      {expanded ? (
        <div className="pw-conversation-process-item-detail">
          {hasDetails ? (
            <ToolTerminal
              command={command || (entry.item.toolName ?? "")}
              input={invocation?.input}
              output={invocation?.output}
              isError={failed}
              running={running}
              duration={duration}
            />
          ) : (
            <div className="pw-conversation-process-empty">{t("processInline.noDetails")}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 阶段的分类统计文案（`N 步 · 读取 X 个文件 · 调用 Y 个工具`）。
 * 顶部的整轮行与阶段摘要条共用它——单阶段走 bare 形态时摘要条不渲染，统计必须由顶部行接住，
 * 否则「读了几个文件、调了几个工具」这条信息会随着少一层折叠一起消失。
 */
function stageSummary(
  t: (key: string, options?: Record<string, unknown>) => string,
  stage: ProcessStage,
  { withSteps }: { withSteps: boolean },
): string[] {
  const parts: string[] = [];
  if (withSteps) parts.push(t("agentLog.steps", { count: stage.stepCount }));
  if (stage.readCount > 0) {
    parts.push(
      t(stage.readCount === 1 ? "processInline.readSummaryOne" : "processInline.readSummaryMany", {
        count: stage.readCount,
      }),
    );
  }
  if (stage.toolCount > 0) {
    parts.push(
      t(stage.toolCount === 1 ? "processInline.toolSummaryOne" : "processInline.toolSummaryMany", {
        count: stage.toolCount,
      }),
    );
  }
  return parts;
}

/**
 * 一个阶段块：摘要条 + 展开明细面板，整体挂在时间线的一个节点上。
 * `sessionActive` 是会话级运行态——单条 reasoning/tool 切相时所有 message 都可能短暂 inactive，
 * 只看阶段内条目会触发「收起→展开」的布局闪烁，所以尾部阶段的折叠必须跟随会话生命周期。
 */
function ProcessStageBlock({
  stage,
  sessionActive,
  defaultLabel,
  bare = false,
}: {
  stage: ProcessStage;
  sessionActive: boolean;
  defaultLabel: string;
  /** 只有一个阶段时由外层的整轮开关直接管展开，这里省掉摘要条，避免两层折叠嵌套。 */
  bare?: boolean;
}) {
  const { t } = useTranslation("chat");
  const running = stage.running || sessionActive;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // 手动优先：记住用户的展开/收起，直到本阶段运行态翻转（= 下一阶段开始）才恢复自动规则。
  useEffect(() => {
    setUserOpen(null);
  }, [running]);
  // 规格 §8：失败的阶段不自动折叠——把错误藏进摘要条等于让用户找不到出问题的那一步。
  const expanded = userOpen ?? (running || stage.failed);

  // 运行中的阶段耗时靠「首个事件时刻 → 现在」逐秒推算；完成后固定为事件区间。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || stage.startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, stage.startedAt]);
  const elapsedMs = running
    ? stage.startedAt !== undefined
      ? Math.max(0, now - stage.startedAt)
      : undefined
    : stage.elapsedMs;

  // 具名阶段（三段编排）标题里没有步数，摘要要补上；缺省阶段的标题本身已含步数，不重复。
  const summary = stageSummary(t, stage, { withSteps: !!stage.label });

  const rows = stage.entries.map((entry) =>
    entry.kind === "reasoning" ? (
      <ReasoningRow key={entry.key} entry={entry} />
    ) : (
      <ToolRow key={entry.key} entry={entry} />
    ),
  );

  if (bare) return <div className="pw-conversation-process-list is-bare">{rows}</div>;

  return (
    <div className="pw-conversation-process-node" data-active={running} data-failed={stage.failed}>
      <span className="pw-conversation-process-dot" data-kind="stage" aria-hidden="true" />
      <button
        type="button"
        className="pw-conversation-process-header"
        aria-expanded={expanded}
        onClick={() => setUserOpen(!expanded)}
      >
        <span className="pw-conversation-process-header-state" aria-hidden="true">
          {running ? <ProcessSpinner /> : stage.failed ? <Icon.XCircle size={12} /> : <Icon.Check size={12} />}
        </span>
        <span className={running ? "pw-conversation-process-live" : undefined}>{stage.label ?? defaultLabel}</span>
        {/* 摘要段恒渲染（可能为空串）：它同时充当摘要条的弹性空间，让耗时与折起箭头始终贴右。 */}
        <span className="pw-conversation-process-summary">
          {summary.length > 0 ? `· ${summary.join(" · ")}` : ""}
        </span>
        {elapsedMs !== undefined ? (
          <span className="pw-conversation-process-elapsed">{formatClock(elapsedMs)}</span>
        ) : null}
        <span className="pw-conversation-process-header-chevron" data-open={expanded} aria-hidden="true">
          <Icon.ChevronRight size={12} />
        </span>
      </button>
      {expanded ? <div className="pw-conversation-process-list">{rows}</div> : null}
    </div>
  );
}

/**
 * Agent 回合的顶部行：`已处理 10s ›`。
 *
 * 个人工作区不再显示消息头像，这一行就是本回合的视觉起点——同时交代「花了多久」和「过程在这里进」。
 * 只有一个阶段时它直接接管展开（阶段摘要条走 bare 形态），不做两层折叠。
 */
export function ConversationProcessTimeline({
  messages,
  sessionId,
  archive,
}: {
  /** 当前轮的瞬态过程流；传 archive 时忽略（归档自带快照）。 */
  messages: Message[];
  sessionId?: string;
  /** 历史轮的过程归档。传入即切到「回看」模式：数据全取自快照，不订阅瞬态事件、恒非运行态。 */
  archive?: TurnProcessArchive;
}) {
  const { t } = useTranslation("chat");
  const requestOpenProcessPanel = usePersonalStore((state) => state.requestOpenProcessPanel);
  // 归档模式下不订阅瞬态事件：历史轮的事件早已被清掉/被后续轮覆盖，读它只会串到别的轮上。
  const liveEvents = usePersonalRunEvents(archive ? undefined : sessionId);
  const sourceMessages = archive ? archive.messages : messages;
  const invocations = useMemo(
    () => (archive ? archive.invocations : buildCurrentRunToolInvocations(liveEvents)),
    [archive, liveEvents],
  );
  const entries = useMemo(() => buildProcessEntries(sourceMessages, invocations), [sourceMessages, invocations]);
  const stages = useMemo(() => groupProcessStages(entries), [entries]);
  const span = useMemo(
    () => (archive ? { startedAt: archive.startedAt, endedAt: archive.endedAt } : currentRunTimeSpan(liveEvents)),
    [archive, liveEvents],
  );
  const messageActive = sourceMessages.some(
    (message) => (message.kind === "reasoning" || message.kind === "agentLog") && message.active === true,
  );
  const sessionRunning = usePersonalStore((state) =>
    !archive && sessionId ? !!state.runningBySession[sessionId] : false,
  );
  // 归档是已完成轮的快照：无论会话此刻是否在跑新一轮，它都不该显示成运行中。
  const active = !archive && (sessionRunning || messageActive);

  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // 运行中展开看实时过程，收尾后自动折回一行；用户手动切换在同一状态内不被刷新打断。
  useEffect(() => {
    setUserOpen(null);
  }, [active]);
  const expanded = userOpen ?? active;

  // 运行中逐秒推进耗时；收尾后固定为本轮事件的首尾区间。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || span.startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, span.startedAt]);
  const elapsedMs =
    span.startedAt === undefined
      ? undefined
      : active
        ? Math.max(0, now - span.startedAt)
        : span.endedAt !== undefined
          ? Math.max(0, span.endedAt - span.startedAt)
          : undefined;

  const totalSteps = stages.reduce((sum, stage) => sum + stage.stepCount, 0);
  if (totalSteps === 0) return null;

  const duration = elapsedMs !== undefined ? formatDuration(elapsedMs) : "";
  const headText = active
    ? t(duration ? "processInline.turnRunning" : "processInline.turnRunningNoTime", { duration })
    : t(duration ? "processInline.turnDone" : "processInline.turnDoneNoTime", { duration });
  const single = stages.length === 1;
  // readCount 是**按阶段去重**的文件数，跨阶段直接相加会把同一个文件重复计进去；多阶段时
  // 顶部行只报耗时，统计留在各自的摘要条上。
  const headSummary = single && stages[0] ? stageSummary(t, stages[0], { withSteps: true }) : [];

  return (
    <div className="pw-conversation-process-turn" data-active={active} data-open={expanded}>
      <button
        type="button"
        className="pw-conversation-process-turn-head"
        aria-expanded={expanded}
        onClick={() => setUserOpen(!expanded)}
      >
        <span className={active ? "pw-conversation-process-live" : undefined}>{headText}</span>
        {headSummary.length > 0 ? (
          <span className="pw-conversation-process-turn-summary">· {headSummary.join(" · ")}</span>
        ) : null}
        <span className="pw-conversation-process-turn-chevron" data-open={expanded} aria-hidden="true">
          <Icon.ChevronRight size={13} />
        </span>
      </button>
      {expanded ? (
        <div className="pw-conversation-process" data-testid="conversation-process" data-active={active}>
          {stages.map((stage, index) => (
            <ProcessStageBlock
              key={`${sessionId ?? ""}:${stage.key}`}
              stage={stage}
              // 只有尾部阶段跟随会话运行态；之前的阶段已经收尾，不该被新一轮拉回展开。
              sessionActive={active && index === stages.length - 1}
              defaultLabel={t("processInline.workTitle", { count: stage.stepCount })}
              bare={single}
            />
          ))}
          {/* 「查看完整过程」读的是瞬态原始事件（当前轮），历史轮没有对应数据，入口不给。 */}
          {sessionId && !archive ? (
            <div className="pw-conversation-process-node" data-kind="more">
              <span className="pw-conversation-process-dot" aria-hidden="true" />
              <button
                type="button"
                className="pw-conversation-process-more"
                onClick={() => requestOpenProcessPanel(sessionId)}
              >
                {t("processInline.openTranscript")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
