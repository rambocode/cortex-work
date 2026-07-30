// 阶段 timeline 双层日期刻度表头（参照 IFocus TimelineScale）：主表头（日「M/D 周X」/
// 周「M月 第N周」/ 月「YYYY年M月」）+ 子表头（日期数字 / 月粒度 W 周号），今天子格高亮。
// 全部宽度 = days × dayWidth（几何由 core stageTimeline 纯函数给出）；sticky 顶部随横向滚动。
import type { TimelineTicks } from "@cortex-work/core/personal/stageTimeline";

export function StageTimelineHeader({ ticks, dayWidth }: { ticks: TimelineTicks; dayWidth: number }) {
  return (
    <div className="pw-tl-head">
      <div className="pw-tl-head-row">
        {ticks.groups.map((g, i) => (
          <div key={i} className="pw-tl-head-group" style={{ width: g.days * dayWidth }}>
            {g.label}
          </div>
        ))}
      </div>
      <div className="pw-tl-head-row">
        {ticks.subs.map((s, i) => (
          <div
            key={i}
            className={`pw-tl-head-sub${s.isToday ? " is-today" : ""}`}
            style={{ width: s.days * dayWidth }}
          >
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}
