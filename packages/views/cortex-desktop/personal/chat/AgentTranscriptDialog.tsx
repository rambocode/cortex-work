// 运行过程详情弹层:Trajectory 形态(参照 deepseek-harness ui-trajectory 完全复刻界面交互)。
// 弹层只做壳(标题/关闭/尺寸),正文是 TrajectoryView(工具栏 + 概览时间线 + 事件台账 +
// 详情检查器)。数据源仍是瞬态运行事件流(usePersonalRunEvents,跨轮累积、不落盘)+
// 每轮用户 prompt 记录(usePersonalRunPrompts,拼出每轮的 USER 行)。
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  usePersonalProcessArchive,
  usePersonalRunEvents,
  usePersonalRunPrompts,
  usePersonalStore,
  type RunEvent,
  type TurnProcessArchive,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { TrajectoryView } from "./trajectory/TrajectoryView";

function archiveToolCallId(key: string): string | undefined {
  return key.startsWith("tool-") ? key.slice("tool-".length) : undefined;
}

/**
 * 历史过程没有瞬态 RunEvent 时，按归档 invocation 重建只读的最小事件序列。
 *
 * 这不是原始事件的替代持久化：input/output 仍受 archive 既有上限约束。它只让活动行在重启后
 * 仍能进入同一个详情面板；缺失时间戳或 callId 时保守省略，TrajectoryView 会退回 overview。
 */
function archiveEvents(archive: TurnProcessArchive): RunEvent[] {
  return archive.invocations.flatMap((invocation, index) => {
    const callId = archiveToolCallId(invocation.key) ?? `archive-${index}`;
    const startedAt = invocation.startedAt ?? archive.startedAt;
    const endedAt = invocation.endedAt ?? archive.endedAt;
    const start: RunEvent = {
      runId: archive.runId,
      ts: startedAt,
      ev: {
        type: "tool",
        name: invocation.name,
        ...(invocation.detail ? { detail: invocation.detail } : {}),
        ...(invocation.input !== undefined ? { input: invocation.input } : {}),
        phase: "start",
        toolCallId: callId,
      },
    };
    if (invocation.running) return [start];
    return [
      start,
      {
        runId: archive.runId,
        ts: Math.max(startedAt, endedAt),
        ev: {
          type: "tool",
          name: invocation.name,
          ...(invocation.output !== undefined ? { output: invocation.output } : {}),
          isError: invocation.isError === true,
          phase: "end",
          toolCallId: callId,
        },
      },
    ];
  });
}

export function AgentTranscriptDialog({
  open,
  onClose,
  sessionId,
  target,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** 可选的原始 run/tool 定位；缺失或过期时 TrajectoryView 安全退回 overview。 */
  target?: { runId?: string; toolCallId?: string; initialTab?: "overview" | "input" | "output" | "error" };
}) {
  const { t } = useTranslation("chat");
  // 活动行是弹层的触发器。关闭后回到它，键盘用户不会在详情看完后丢失阅读位置。
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const activeElement = document.activeElement;
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
  }, [open]);
  const close = () => {
    onClose();
    // 面板卸载后再还焦点；同步 focus 会被 React 随后的 DOM 提交覆盖。
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  };
  const events = usePersonalRunEvents(open ? sessionId : undefined);
  const prompts = usePersonalRunPrompts(open ? sessionId : undefined);
  const archives = usePersonalProcessArchive(open ? sessionId : undefined);
  const running = usePersonalStore((s) => !!s.runningBySession[sessionId]);
  const archivedEvents = useMemo(() => {
    const archive = target?.runId ? archives.find((candidate) => candidate.runId === target.runId) : undefined;
    // 只在实时 ring 已经不含目标 run 时回退归档，避免同一 run 的事件被复制两遍。
    return archive && !events.some((event) => event.runId === archive.runId) ? archiveEvents(archive) : [];
  }, [archives, events, target?.runId]);
  const displayEvents = archivedEvents.length > 0 ? archivedEvents : events;

  if (!open) return null;

  return (
    <div className="pw-dlg-overlay" onClick={close}>
      <div
        className="pw-dlg pw-traj-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={t("transcript.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 时间线选区活动时其 track 已 stopPropagation 消费 Escape;走到这里的一律关弹层。
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="pw-traj-dlg-head">
          <span className="pw-traj-dlg-title">{t("transcript.title")}</span>
          <button type="button" className="pw-icon-btn" title={t("transcript.close")} onClick={close}>
            <Icon.X size={15} />
          </button>
        </div>
        {displayEvents.length === 0 && prompts.length === 0 ? (
          <div className="pw-traj-dlg-empty">{t("transcript.empty")}</div>
        ) : (
          <TrajectoryView
            events={displayEvents}
            prompts={prompts}
            running={running}
            fallbackToolName={t("transcript.toolFallback")}
            initialTarget={target}
          />
        )}
      </div>
    </div>
  );
}
