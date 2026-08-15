// 运行过程详情弹层:Trajectory 形态(参照 deepseek-harness ui-trajectory 完全复刻界面交互)。
// 弹层只做壳(标题/关闭/尺寸),正文是 TrajectoryView(工具栏 + 概览时间线 + 事件台账 +
// 详情检查器)。数据源仍是瞬态运行事件流(usePersonalRunEvents,跨轮累积、不落盘)+
// 每轮用户 prompt 记录(usePersonalRunPrompts,拼出每轮的 USER 行)。
import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalRunEvents, usePersonalRunPrompts, usePersonalStore } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { TrajectoryView } from "./trajectory/TrajectoryView";

export function AgentTranscriptDialog({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  const { t } = useTranslation("chat");
  const events = usePersonalRunEvents(open ? sessionId : undefined);
  const prompts = usePersonalRunPrompts(open ? sessionId : undefined);
  const running = usePersonalStore((s) => !!s.runningBySession[sessionId]);

  if (!open) return null;

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
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
            onClose();
          }
        }}
      >
        <div className="pw-traj-dlg-head">
          <span className="pw-traj-dlg-title">{t("transcript.title")}</span>
          <button type="button" className="pw-icon-btn" title={t("transcript.close")} onClick={onClose}>
            <Icon.X size={15} />
          </button>
        </div>
        {events.length === 0 && prompts.length === 0 ? (
          <div className="pw-traj-dlg-empty">{t("transcript.empty")}</div>
        ) : (
          <TrajectoryView
            events={events}
            prompts={prompts}
            running={running}
            fallbackToolName={t("transcript.toolFallback")}
          />
        )}
      </div>
    </div>
  );
}
