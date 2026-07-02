// 阶段 timeline 单行（每阶段独占一行，对齐 IFocus oneItemPerRow）：条形绝对定位
// （left/width 由 core stageBarGeometry 给出），状态色、标题 truncate；无日期阶段显行内提示。
import { stageBarGeometry, type TimelineWindow } from "@cortex-work/core/personal/stageTimeline";
import { stageStatusLabel } from "@cortex-work/core/personal/projectStages";
import type { ProjectStage } from "@cortex-work/core/desktop/types";

export function StageTimelineRow({
  stage,
  window,
  dayWidth,
}: {
  stage: ProjectStage;
  window: TimelineWindow;
  dayWidth: number;
}) {
  // 无起止日期（或非法）→ 不画条，行内提示引导去阶段编辑里补日期。
  const geo =
    stage.startDate && stage.dueDate ? stageBarGeometry(stage.startDate, stage.dueDate, window, dayWidth) : null;

  return (
    <div className="pw-tl-row" data-stage-id={stage.id}>
      {geo ? (
        <div
          className={`pw-tl-bar pw-tl-bar--${stage.status}`}
          style={{ left: geo.left, width: geo.width }}
          title={`${stage.name}（${stageStatusLabel(stage.status)}）${stage.startDate} ~ ${stage.dueDate}`}
        >
          <span className="pw-tl-bar-name">{stage.name}</span>
        </div>
      ) : (
        <div className="pw-tl-row-empty">「{stage.name}」未设起止日期</div>
      )}
    </div>
  );
}
