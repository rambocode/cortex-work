// 个人会话内联工作过程：聊天流只呈现紧凑活动台账；原始 input/output/reasoning 永远留在完整过程面板。
//
// 两个数据源，同一套渲染：
//  - 当前轮：瞬态过程流(messages) + 瞬态原始事件(usePersonalRunEvents)，逐 token 实时更新；
//  - 历史轮：传入 archive（core 在轮末打的快照，落 chats/<id>.process.json），不读瞬态流、
//    恒为完成态。这样重开会话/重启应用后，「已处理 8.8s · N 步 · 调用了 N 个工具」与工具输入
//    输出仍可展开回看。
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  usePersonalRunEvents,
  usePersonalStore,
  type ProcessPanelTarget,
  type TurnProcessArchive,
} from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import {
  buildCurrentRunToolInvocations,
  buildProcessEntries,
  buildProcessPresentation,
  currentRunTimeSpan,
  formatDuration,
  groupProcessStages,
  type ProcessActivityRow,
} from "./processTimeline";

export { buildCurrentRunToolInvocations } from "./processTimeline";

/** 运行中的旋转指示器（规格 §3：12px、2px 描边、spin 1s linear infinite）。 */
function ProcessSpinner() {
  return <span className="pw-conversation-process-spinner" aria-hidden="true" />;
}

/** 轻量活动行；点击始终进入完整过程面板，聊天流绝不回退渲染终端/input/output。 */
function ActivityRow({
  row,
  sessionId,
  runId,
  onOpen,
}: {
  row: ProcessActivityRow;
  sessionId?: string;
  runId?: string;
  onOpen: (target: ProcessPanelTarget) => void;
}) {
  const { t } = useTranslation("chat");
  const failed = row.status === "failed";
  const running = row.status === "running";
  const readableLabels = row.kind === "read-group" ? row.labels.slice(0, 3) : [];
  const label =
    row.kind === "reasoning"
      ? t(running ? "processInline.thinkingNow" : "processInline.thinking")
      : row.kind === "read-group"
        ? t(
            row.count > readableLabels.length ? "processInline.readFilesMore" : "processInline.readFiles",
            { files: readableLabels.join("、"), count: row.count },
          )
        : row.label;
  const duration = "durationMs" in row && row.durationMs !== undefined ? formatDuration(row.durationMs) : undefined;
  const toolCallId = row.kind === "read-group" ? row.callIds[0] : "callId" in row ? row.callId : undefined;

  const open = () => {
    if (!sessionId) return;
    onOpen({
      sessionId,
      ...(runId ? { runId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(failed ? { initialTab: "error" as const } : {}),
    });
  };

  return (
    <button
      type="button"
      className="pw-conversation-process-activity"
      data-kind={row.kind}
      data-active={running}
      data-error={failed}
      onClick={open}
      disabled={!sessionId}
    >
      <span className="pw-conversation-process-item-state" aria-hidden="true">
        {running ? <ProcessSpinner /> : failed ? <Icon.XCircle size={12} /> : row.kind === "read-group" ? <Icon.File size={12} /> : <Icon.Check size={12} />}
      </span>
      <span className={running ? "pw-conversation-process-live" : "pw-conversation-process-activity-label"}>{label}</span>
      {duration ? <span className="pw-conversation-process-item-time">{duration}</span> : null}
      {failed ? <span className="pw-conversation-process-error-summary">{t("processInline.errorDetails")}</span> : null}
    </button>
  );
}

/**
 * Agent 回合的顶部行：`已处理 10s ›`。
 *
 * 个人工作区不再显示消息头像，这一行就是本回合的视觉起点——同时交代「花了多久」和「过程在这里进」。
 * 展开后只出现一层活动台账；阶段只保留为纯逻辑分组，不再在聊天流引入嵌套折叠。
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
  const cwd = usePersonalStore((state) => {
    const projectId = state.sessions.find((session) => session.id === sessionId)?.projectId;
    return state.projects.find((project) => project.id === projectId)?.path;
  });
  const presentation = useMemo(() => buildProcessPresentation(stages, { cwd }), [cwd, stages]);
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
  const failed = presentation.summary.failed > 0;

  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // 运行中展开看实时过程，收尾后自动折回一行；用户手动切换在同一状态内不被刷新打断。
  useEffect(() => {
    setUserOpen(null);
  }, [active]);
  // 失败轮默认保持展开，确保错误动作无需再点一次就能看见；用户手动状态仍优先。
  const expanded = userOpen ?? (active || failed);

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

  if (presentation.summary.steps === 0) return null;

  const duration = elapsedMs !== undefined ? formatDuration(elapsedMs) : "";
  const headText = active
    ? t(duration ? "processInline.turnRunning" : "processInline.turnRunningNoTime", { duration })
    : failed
      ? t(duration ? "processInline.turnFailed" : "processInline.turnFailedNoTime", { duration })
      : t(duration ? "processInline.turnDone" : "processInline.turnDoneNoTime", { duration });
  const headSummary = [
    presentation.summary.files > 0
      ? t(presentation.summary.files === 1 ? "processInline.readSummaryOne" : "processInline.readSummaryMany", { count: presentation.summary.files })
      : undefined,
    presentation.summary.commands > 0
      ? t(presentation.summary.commands === 1 ? "processInline.commandSummaryOne" : "processInline.commandSummaryMany", { count: presentation.summary.commands })
      : undefined,
    presentation.summary.tools > 0
      ? t(presentation.summary.tools === 1 ? "processInline.toolSummaryOne" : "processInline.toolSummaryMany", { count: presentation.summary.tools })
      : undefined,
  ].filter((value): value is string => value !== undefined);

  return (
    <div className="pw-conversation-process-turn" data-active={active} data-error={failed} data-open={expanded}>
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
          <div className="pw-conversation-process-list is-bare">
            {presentation.stages.flatMap((stage) =>
              stage.rows.map((row) => (
                <ActivityRow
                  key={`${sessionId ?? ""}:${row.key}`}
                  row={row}
                  sessionId={sessionId}
                  runId={archive?.runId ?? liveEvents.at(-1)?.runId}
                  onOpen={requestOpenProcessPanel}
                />
              )),
            )}
          </div>
          {/* 「查看完整过程」读的是瞬态原始事件（当前轮），历史轮没有对应数据，入口不给。 */}
          {sessionId && !archive ? (
            <div className="pw-conversation-process-node" data-kind="more">
              <span className="pw-conversation-process-dot" aria-hidden="true" />
              <button
                type="button"
                className="pw-conversation-process-more"
                onClick={() => requestOpenProcessPanel({ sessionId, ...(liveEvents.at(-1)?.runId ? { runId: liveEvents.at(-1)?.runId } : {}) })}
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
