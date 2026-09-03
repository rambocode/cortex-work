// Chrome Network 式概览时间线(复刻 deepseek-harness TrajectoryTimeline 的全部交互):
// 左键拖拽框选聚焦区间、点击空白就近聚焦、点中区块直接选中记录、滚轮缩放、右键拖拽平移、
// 框选拖拽到边缘自动平移、双击/Escape 复位、悬停竖线与 500ms 延迟 tooltip。
// 参照实现每个区块包一层 Tooltip 组件;此处用轨道级事件代理 + 单例浮层实现同等观感。
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { TrajectoryCellKind, TrajectoryCellProps, TrajectoryTurnModel } from "./trajectory-model";
import {
  deriveTrajectoryTimeline,
  formatTimelineOffset,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from "./trajectory-timeline-model";

const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_OPERATIONS = 4;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;
const TIMELINE_TOOLTIP_DELAY_MS = 500;

interface TimelineRecordDetail {
  durationMs?: number;
  startedAt?: number;
}

interface FractionRange {
  start: number;
  end: number;
}

interface HoverPoint {
  fraction: number;
  recordIndex: number | null;
}

interface PanGesture {
  anchorClientX: number;
  anchorStart: number;
  moved: boolean;
  pannable: boolean;
  pointerId: number;
}

interface TooltipState {
  left: number;
  top: number;
  text: string;
}

function timelineRecordDetail(cell: TrajectoryCellProps): TimelineRecordDetail {
  const durationMs =
    cell.timeSeconds === null || !Number.isFinite(cell.timeSeconds)
      ? undefined
      : Math.max(0, cell.timeSeconds * 1_000);
  const startedAt =
    cell.startedAt === null || cell.startedAt === undefined || !Number.isFinite(cell.startedAt)
      ? undefined
      : cell.startedAt;
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

function timelineKindLabel(kind: TrajectoryCellKind): string {
  switch (kind) {
    case "user":
      return "USER";
    case "context":
      return "CONTEXT";
    case "message":
      return "ASSISTANT";
    case "tool":
      return "TOOL";
  }
}

function formatRecordedTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

// tooltip 文案:类型行 + 起止/开始行 + 总时长行(与参照实现同构,缺项行省略)。
function timelineTooltipLabel(kind: TrajectoryCellKind, detail: TimelineRecordDetail | undefined): string {
  const heading = timelineKindLabel(kind);
  if (detail === undefined) return heading;
  const duration = detail.durationMs === undefined ? null : `Total ${formatTimelineOffset(detail.durationMs)}`;
  const range =
    detail.startedAt === undefined
      ? null
      : detail.durationMs === undefined
        ? `Started ${formatRecordedTime(detail.startedAt)}`
        : `${formatRecordedTime(detail.startedAt)} → ${formatRecordedTime(detail.startedAt + detail.durationMs)}`;
  return [heading, range, duration].filter((value) => value !== null && value !== "").join("\n");
}

export interface TrajectoryTimelineProps {
  turns: TrajectoryTurnModel[];
  mode: TrajectoryTimelineMode;
  range: TrajectoryTimeRange | null;
  selectedIndex?: number | null;
  /** 命中当前搜索的记录序号,无查询为 null。 */
  searchMatchIndexes?: ReadonlySet<number> | null;
  onRangeChange: (range: TrajectoryTimeRange | null) => void;
  /** 点中时间线区块直接选中记录。 */
  onRecordSelect?: (index: number) => void;
  /** 点击空白后把最近的记录滚入视野。 */
  onRecordFocus?: (index: number) => void;
}

function orderedRange(left: number, right: number): FractionRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function centeredRange(center: number, width: number, minimum: number, maximum: number): FractionRange {
  const clampedWidth = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(Math.max(center - clampedWidth / 2, minimum), maximum - clampedWidth);
  return { start, end: start + clampedWidth };
}

function rangeFraction(
  range: TrajectoryTimeRange,
  start: number,
  duration: number,
  minimum: number,
  maximum: number,
): FractionRange {
  const bounded = orderedRange(
    Math.min(maximum, Math.max(minimum, range.start)),
    Math.min(maximum, Math.max(minimum, range.end)),
  );
  return { start: (bounded.start - start) / duration, end: (bounded.end - start) / duration };
}

function LaneLabels() {
  return (
    <div className="pw-traj-tl-labels" aria-hidden="true">
      <span>Input</span>
      <span>Model</span>
      <span>Tools</span>
    </div>
  );
}

export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  turns,
  mode,
  range,
  selectedIndex = null,
  searchMatchIndexes = null,
  onRangeChange,
  onRecordSelect,
  onRecordFocus,
}: TrajectoryTimelineProps) {
  const model = useMemo(() => deriveTrajectoryTimeline(turns, mode), [mode, turns]);
  const detailByIndex = useMemo(
    () =>
      new Map(
        turns.flatMap((turn) =>
          turn.groups.flatMap((group) => group.cells.map((cell) => [cell.index, timelineRecordDetail(cell)] as const)),
        ),
      ),
    [turns],
  );
  const kindByIndex = useMemo(
    () =>
      new Map(
        turns.flatMap((turn) =>
          turn.groups.flatMap((group) => group.cells.map((cell) => [cell.index, cell.kind] as const)),
        ),
      ),
    [turns],
  );
  const dragRef = useRef<{
    pointerId: number;
    anchorTime: number;
    anchorClientX: number;
    recordIndex: number | null;
  } | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<TrajectoryTimeRange | null>(null);
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [panning, setPanning] = useState(false);
  const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null);
  const [animateViewport, setAnimateViewport] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTooltip = () => {
    if (tooltipTimer.current !== null) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
    setTooltip(null);
  };
  // 选区落到当前域之外(数据被清/切轮)时自动复位。
  useEffect(() => {
    if (model !== null && range !== null && (range.end < model.start || range.start > model.end)) {
      onRangeChange(null);
    }
  }, [model, onRangeChange, range]);
  useEffect(() => {
    if (model === null) return;
    setAnimateViewport(false);
    setViewport((current) =>
      current !== null && (current.end < model.start || current.start > model.end) ? null : current,
    );
  }, [model]);
  // 台账选中记录不在缩放视口内时,平移视口带它进来(参照实现同款寻址逻辑)。
  useEffect(() => {
    if (model === null || selectedIndex === null) return;
    const selectedSpan = model.spans.find((span) => span.index === selectedIndex);
    if (selectedSpan === undefined) return;
    setAnimateViewport(true);
    setViewport((current) => {
      if (current === null) return current;
      if (selectedSpan.end > current.start && selectedSpan.start < current.end) return current;
      const duration = Math.max(1, current.end - current.start);
      const desiredStart = selectedSpan.end <= current.start ? selectedSpan.start : selectedSpan.end - duration;
      const nextStart = Math.min(Math.max(desiredStart, model.start), Math.max(model.start, model.end - duration));
      if (nextStart === current.start) return current;
      return { start: nextStart, end: nextStart + duration };
    });
  }, [model, selectedIndex]);
  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
  const viewportDuration = Math.min(fullDuration, Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)));
  const viewportStart =
    model === null || viewport === null
      ? (model?.start ?? 0)
      : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
  const domainDuration = viewport === null ? fullDuration : viewportDuration;
  const domainStart = viewport === null ? (model?.start ?? 0) : viewportStart;
  const projectedDomainStyle =
    model === null
      ? undefined
      : ({
          "--pw-traj-domain-left": `${(-(domainStart - model.start) / domainDuration) * 100}%`,
          "--pw-traj-domain-width": `${(fullDuration / domainDuration) * 100}%`,
        } as CSSProperties);
  const committed =
    model === null || range === null ? null : rangeFraction(range, domainStart, domainDuration, model.start, model.end);
  const draftFraction =
    model === null || draft === null ? null : rangeFraction(draft, domainStart, domainDuration, model.start, model.end);
  const visibleRange = draftFraction ?? committed;
  const activeRange = draft ?? range;
  // 滚轮缩放:以指针所在时刻为锚点,指数缩放并夹在[最小可辨窗口,全域]。
  // passive:false 才能 preventDefault 拦掉页面滚动,故手挂原生监听。
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault();
      const track = trackRef.current;
      if (track === null || model === null) return;
      setAnimateViewport(false);
      const rect = track.getBoundingClientRect();
      const anchorFraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
      const nextDuration = Math.min(
        fullDuration,
        Math.max(
          Math.min(mode === "sequence" ? MINIMUM_ZOOM_OPERATIONS : 20, fullDuration),
          domainDuration * Math.exp(event.deltaY * 0.0015),
        ),
      );
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null);
        return;
      }
      const anchorTime = domainStart + anchorFraction * domainDuration;
      const nextStart = Math.min(Math.max(anchorTime - anchorFraction * nextDuration, model.start), model.end - nextDuration);
      setViewport({ start: nextStart, end: nextStart + nextDuration });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [domainDuration, domainStart, fullDuration, mode, model]);
  useEffect(
    () => () => {
      if (tooltipTimer.current !== null) clearTimeout(tooltipTimer.current);
    },
    [],
  );

  if (model === null) {
    return (
      <section ref={rootRef} className="pw-traj-tl" aria-label="Trajectory timeline">
        <div className="pw-traj-tl-plot">
          <LaneLabels />
          <div className="pw-traj-tl-track">
            <span className="pw-traj-tl-empty">No timing data</span>
          </div>
        </div>
      </section>
    );
  }

  const minimumSelectionDuration = Math.min(domainDuration, fullDuration / model.spans.length);

  const fractionAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
  };

  const recordIndexAt = (event: PointerEvent<HTMLDivElement>): number | null => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const value = target?.closest<HTMLElement>("[data-timeline-record-index]")?.dataset.timelineRecordIndex;
    if (value === undefined) return null;
    const index = Number(value);
    return Number.isFinite(index) ? index : null;
  };

  // 悬停区块 500ms 后展示 tooltip(位置取指针下方,随移动刷新内容与位置)。
  const scheduleTooltip = (event: PointerEvent<HTMLDivElement>, recordIndex: number | null) => {
    if (recordIndex === null || dragRef.current !== null || panRef.current !== null) {
      clearTooltip();
      return;
    }
    const kind = kindByIndex.get(recordIndex);
    if (kind === undefined) {
      clearTooltip();
      return;
    }
    const text = timelineTooltipLabel(kind, detailByIndex.get(recordIndex));
    const left = event.clientX;
    const top = event.currentTarget.getBoundingClientRect().bottom + 6;
    if (tooltip !== null) {
      setTooltip({ left, top, text });
      return;
    }
    if (tooltipTimer.current !== null) clearTimeout(tooltipTimer.current);
    tooltipTimer.current = setTimeout(() => {
      tooltipTimer.current = null;
      setTooltip({ left, top, text });
    }, TIMELINE_TOOLTIP_DELAY_MS);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    clearTooltip();
    // 右键:平移已缩放的视口;未移动的右键单击复位选区。
    if (event.button === 2) {
      panRef.current = {
        anchorClientX: event.clientX,
        anchorStart: domainStart,
        moved: false,
        pannable: viewport !== null,
        pointerId: event.pointerId,
      };
      if (viewport !== null) setAnimateViewport(false);
      setPanning(true);
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (event.button !== 0) return;
    const anchor = fractionAt(event);
    const anchorTime = domainStart + anchor * domainDuration;
    const recordIndex = recordIndexAt(event);
    setHover({ fraction: anchor, recordIndex });
    dragRef.current = { pointerId: event.pointerId, anchorTime, anchorClientX: event.clientX, recordIndex };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDraft({ start: anchorTime, end: anchorTime });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = fractionAt(event);
    const recordIndex = recordIndexAt(event);
    setHover({ fraction, recordIndex });
    scheduleTooltip(event, recordIndex);
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
      if (!pan.pannable) return;
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
      const nextStart = Math.min(Math.max(pan.anchorStart - delta * domainDuration, model.start), model.end - domainDuration);
      setViewport({ start: nextStart, end: nextStart + domainDuration });
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    // 框选拖到轨道边缘:按接近程度加速平移视口(仅缩放态)。
    let nextDomainStart = domainStart;
    if (viewport !== null) {
      const localX = event.clientX - rect.left;
      const edgeWidth = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION));
      const direction = localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0;
      if (direction !== 0) {
        const edgeDistance = direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
        const strength = clampFraction(edgeDistance / edgeWidth);
        const desiredStart = domainStart + direction * domainDuration * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
        nextDomainStart = Math.min(Math.max(desiredStart, model.start), model.end - domainDuration);
        if (nextDomainStart !== domainStart) {
          setAnimateViewport(false);
          setViewport({ start: nextDomainStart, end: nextDomainStart + domainDuration });
        }
      }
    }
    const pointTime = nextDomainStart + fraction * domainDuration;
    setDraft(orderedRange(drag.anchorTime, pointTime));
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
      panRef.current = null;
      setPanning(false);
      if (!moved) onRangeChange(null);
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointFraction = fractionAt(event);
    const pointTime = domainStart + pointFraction * domainDuration;
    const selected = orderedRange(drag.anchorTime, pointTime);
    setHover({ fraction: pointFraction, recordIndex: recordIndexAt(event) });
    dragRef.current = null;
    setDraft(null);
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    const clickedSpan =
      click && drag.recordIndex !== null ? model.spans.find((span) => span.index === drag.recordIndex) : undefined;
    if (clickedSpan !== undefined) {
      onRangeChange(null);
      onRecordSelect?.(clickedSpan.index);
      return;
    }
    // 过窄的框选按最小可辨宽度居中展开;单击空白按点位展开并聚焦最近记录。
    const committedRange =
      selected.end - selected.start < minimumSelectionDuration
        ? centeredRange(
            click ? selected.start : (selected.start + selected.end) / 2,
            minimumSelectionDuration,
            model.start,
            model.end,
          )
        : selected;
    onRangeChange(committedRange);
    if (click) {
      const timelinePoint = selected.start;
      const nearest = model.spans.reduce((candidate, span) => {
        const candidateDistance =
          timelinePoint < candidate.start
            ? candidate.start - timelinePoint
            : timelinePoint > candidate.end
              ? timelinePoint - candidate.end
              : 0;
        const spanDistance =
          timelinePoint < span.start ? span.start - timelinePoint : timelinePoint > span.end ? timelinePoint - span.end : 0;
        return spanDistance < candidateDistance ? span : candidate;
      });
      onRecordFocus?.(nearest.index);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || range === null) return;
    // 有活动选区时 Escape 只清选区,不冒泡关弹层。
    event.preventDefault();
    event.stopPropagation();
    onRangeChange(null);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    panRef.current = null;
    setDraft(null);
    setHover(null);
    setPanning(false);
    clearTooltip();
  };

  return (
    <section ref={rootRef} className="pw-traj-tl" aria-label="Trajectory timeline">
      <div className="pw-traj-tl-plot">
        <LaneLabels />
        <div
          ref={trackRef}
          className="pw-traj-tl-track"
          data-panning={panning || undefined}
          aria-label="Timeline overview; drag horizontally to focus events"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            if (dragRef.current === null && panRef.current === null) setHover(null);
            clearTooltip();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRangeChange(null);
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {hover !== null && hover.recordIndex === null && draft === null && (
            <div
              className="pw-traj-tl-hover-line"
              aria-hidden="true"
              style={{ "--pw-traj-hover-left": `${hover.fraction * 100}%` } as CSSProperties}
            />
          )}
          {visibleRange !== null && (
            <>
              <div
                className="pw-traj-tl-selection"
                data-dragging={draft === null ? undefined : "true"}
                aria-hidden="true"
                style={
                  {
                    "--pw-traj-selection-left": `${visibleRange.start * 100}%`,
                    "--pw-traj-selection-width": `${(visibleRange.end - visibleRange.start) * 100}%`,
                  } as CSSProperties
                }
              />
              <div
                className="pw-traj-tl-selection-edges"
                data-dragging={draft === null ? undefined : "true"}
                aria-hidden="true"
                style={
                  {
                    "--pw-traj-selection-left": `${visibleRange.start * 100}%`,
                    "--pw-traj-selection-width": `${(visibleRange.end - visibleRange.start) * 100}%`,
                  } as CSSProperties
                }
              />
            </>
          )}
          <div
            className="pw-traj-tl-turn-boundaries"
            data-animate-viewport={animateViewport || undefined}
            aria-hidden="true"
            style={projectedDomainStyle}
          >
            {model.turnBoundaries
              .filter(
                (boundary) =>
                  boundary.time > model.start &&
                  boundary.time >= domainStart &&
                  boundary.time <= domainStart + domainDuration,
              )
              .map((boundary) => (
                <span
                  className="pw-traj-tl-turn-boundary"
                  key={boundary.turn}
                  style={{ "--pw-traj-turn-left": `${((boundary.time - model.start) / fullDuration) * 100}%` } as CSSProperties}
                />
              ))}
          </div>
          <div className="pw-traj-tl-lanes" data-animate-viewport={animateViewport || undefined} style={projectedDomainStyle}>
            {model.spans
              .filter(
                (span) =>
                  span.index === selectedIndex ||
                  (span.end >= domainStart && span.start <= domainStart + domainDuration),
              )
              .map((span) => {
                const left = (span.start - model.start) / fullDuration;
                const width = (span.end - span.start) / fullDuration;
                const widthPercent = width * 100;
                return (
                  <span
                    key={span.index}
                    aria-hidden="true"
                    className="pw-traj-tl-span"
                    data-timeline-span={span.kind}
                    data-timeline-record-index={span.index}
                    data-error={span.isError || undefined}
                    data-recovered={span.recovered || undefined}
                    data-current={span.index === selectedIndex || undefined}
                    data-hovered={hover?.recordIndex === span.index || undefined}
                    data-search-match={
                      searchMatchIndexes === null ? undefined : searchMatchIndexes.has(span.index) ? "true" : "false"
                    }
                    data-selected={
                      activeRange === null
                        ? undefined
                        : span.start <= activeRange.end && span.end >= activeRange.start
                          ? "true"
                          : "false"
                    }
                    style={
                      {
                        "--pw-traj-span-left": `${left * 100}%`,
                        "--pw-traj-span-width": `${widthPercent}%`,
                        "--pw-traj-span-gap": `min(${widthPercent * 0.08}%, 1px)`,
                        "--pw-traj-span-lane": span.lane,
                      } as CSSProperties
                    }
                  />
                );
              })}
          </div>
        </div>
      </div>
      {tooltip !== null && (
        <div className="pw-traj-tl-tooltip" role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
          {tooltip.text}
        </div>
      )}
    </section>
  );
});
