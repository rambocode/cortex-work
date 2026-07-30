// 阶段 timeline 视图（参照 IFocus Timeline）：日/周/月粒度切换（dayWidth 60/30/12）+「今天」
// 滚动居中 + 双层日期刻度 + 逐日网格底色（今天/周末）+ 今日红线（当天格中点，顶部圆点）+
// 每阶段独占一行的条形。全部几何来自 core stageTimeline 纯函数（表驱动测试覆盖）；
// 时间窗口固定今天前 14 天 ~ 后 28 天。activeStageId 过滤与列表视图一致（null=全部）。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildDateTicks,
  buildTimelineWindow,
  dayWidthFor,
  scrollLeftForToday,
  todayMarkerLeft,
  type TimelineGranularity,
} from "@cortex-work/core/personal/stageTimeline";
import { sortStages } from "@cortex-work/core/personal/projectStages";
import type { ProjectStage } from "@cortex-work/core/desktop/types";
import { StageTimelineHeader } from "./StageTimelineHeader";
import { StageTimelineRow } from "./StageTimelineRow";

const GRANULARITIES: readonly { value: TimelineGranularity; label: string }[] = [
  { value: "day", label: "日" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
];

export function StageTimeline({
  stages,
  activeStageId,
}: {
  stages: ProjectStage[];
  // 阶段 tab 过滤（与列表视图共用受控值）：null = 全部阶段。
  activeStageId: string | null;
}) {
  const [granularity, setGranularity] = useState<TimelineGranularity>("week");
  const scrollRef = useRef<HTMLDivElement>(null);

  const dayWidth = dayWidthFor(granularity);
  // 窗口/刻度按「今天」派生；粒度切换时重算。today 取渲染时刻（视图短生命周期，无需跨零点刷新）。
  const { window: win, ticks } = useMemo(() => {
    const w = buildTimelineWindow(new Date());
    return { window: w, ticks: buildDateTicks(w, granularity) };
  }, [granularity]);

  const visible = useMemo(() => {
    const sorted = sortStages(stages);
    return activeStageId ? sorted.filter((s) => s.id === activeStageId) : sorted;
  }, [stages, activeStageId]);

  // 「今天」滚动居中；初次挂载与粒度切换后也归位（列宽变了，今天的像素位随之变）。
  const scrollToToday = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo?.({ left: scrollLeftForToday(win, dayWidth, el.clientWidth), behavior: "smooth" });
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 挂载/切粒度直接定位（不平滑），避免每次切换都动画横扫。
    el.scrollLeft = scrollLeftForToday(win, dayWidth, el.clientWidth);
  }, [win, dayWidth]);

  const totalWidth = win.totalDays * dayWidth;
  const markerLeft = todayMarkerLeft(win, dayWidth);

  return (
    <div className="pw-tl">
      <div className="pw-tl-toolbar">
        <div className="pw-stages-viewswitch" role="group" aria-label="时间粒度">
          {GRANULARITIES.map((g) => (
            <button
              key={g.value}
              className={`pw-tl-gran${granularity === g.value ? " is-on" : ""}`}
              aria-pressed={granularity === g.value}
              onClick={() => setGranularity(g.value)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <button className="pw-ps-btn" onClick={scrollToToday}>
          今天
        </button>
      </div>
      <div className="pw-tl-scroll" ref={scrollRef}>
        <div className="pw-tl-canvas" style={{ width: totalWidth }}>
          <StageTimelineHeader ticks={ticks} dayWidth={dayWidth} />
          <div className="pw-tl-body">
            {/* 逐日网格底色层：今天列 / 周末列。pointer-events 关闭不挡条形交互。 */}
            <div className="pw-tl-grid" aria-hidden>
              {ticks.cells.map((c, i) => (
                <div
                  key={i}
                  className={`pw-tl-grid-col${c.isToday ? " is-today" : ""}${c.isWeekend ? " is-weekend" : ""}`}
                  style={{ width: dayWidth }}
                />
              ))}
            </div>
            {/* 今日红线：当天格中点 + 顶部圆点。 */}
            <div className="pw-tl-today" style={{ left: markerLeft }} aria-hidden>
              <span className="pw-tl-today-dot" />
            </div>
            {visible.length === 0 ? (
              <div className="pw-tl-empty">暂无阶段，在上方「添加」创建阶段并设置起止日期</div>
            ) : (
              visible.map((s) => <StageTimelineRow key={s.id} stage={s} window={win} dayWidth={dayWidth} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
