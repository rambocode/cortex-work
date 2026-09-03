// 时间线三泳道投影(复刻 deepseek-harness timeline.ts):sequence = 等宽序号域,
// duration = 真实起止时间域(压缩泳道间空闲)。供顶栏概览与台账聚焦互动共用。
import type { TrajectoryCellKind, TrajectoryCellProps, TrajectoryTurnModel } from "./trajectory-model";
import { formatDurationMillis } from "./trajectory-model";

/** 时间线水平投影模式(参照实现的 time/actual 档在 UI 上不可达,故裁剪)。 */
export type TrajectoryTimelineMode = "sequence" | "duration";

/** 当前投影域上的闭区间选择。 */
export interface TrajectoryTimeRange {
  start: number;
  end: number;
}

/** 一条台账记录在时间线上的区段。 */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  index: number;
  /** 未恢复的失败(已恢复的失败此处为 false,由 recovered 单独表达,时间线据此选红/琥珀)。 */
  isError: boolean;
  /** 失败已被同轮后续同名调用覆盖,见 TrajectoryCellProps.recovered。 */
  recovered: boolean;
  kind: TrajectoryCellKind;
  label: string;
  lane: number;
}

/** 一个轮边界(竖线)。 */
export interface TrajectoryTimelineTurnBoundary {
  turn: number;
  time: number;
}

/** 概览全域模型。 */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  spans: TrajectoryTimelineSpan[];
  turnBoundaries: TrajectoryTimelineTurnBoundary[];
}

/** 时间线偏移标签(整数毫秒 + 千分位)。 */
export function formatTimelineOffset(milliseconds: number): string {
  return formatDurationMillis(milliseconds);
}

// 泳道:0 = Input(user/context),1 = Model(message),2 = Tools。
function laneFor(kind: TrajectoryCellKind): number {
  if (kind === "tool") return 2;
  if (kind === "message") return 1;
  return 0;
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function cellRange(cell: TrajectoryCellProps): TrajectoryTimeRange | null {
  if (!finite(cell.startedAt)) return null;
  const durationMs = finite(cell.timeSeconds) ? Math.max(0, cell.timeSeconds * 1_000) : 0;
  return { start: cell.startedAt, end: cell.startedAt + durationMs };
}

/**
 * 把全部可见记录投影为稳定三泳道时间线。
 * sequence 模式一格一记录;duration 模式按真实起止(压缩记录间的空闲间隔)。
 */
export function deriveTrajectoryTimeline(
  turns: TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = "sequence",
): TrajectoryTimelineModel | null {
  if (mode === "duration") return deriveTimedTimeline(turns);
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];

  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) => group.cells);
    if (cells.length === 0) continue;
    turnBoundaries.push({ turn: turn.turn, time: spans.length });
    spans.push(
      ...cells.map(
        (cell, offset): TrajectoryTimelineSpan => ({
          start: spans.length + offset,
          end: spans.length + offset + 1,
          index: cell.index,
          isError: cell.isError === true && cell.recovered !== true,
          recovered: cell.recovered === true,
          kind: cell.kind,
          label: cell.text,
          lane: laneFor(cell.kind),
        }),
      ),
    );
  }

  if (spans.length === 0) return null;
  return { start: 0, end: spans.length, spans, turnBoundaries };
}

function deriveTimedTimeline(turns: TrajectoryTurnModel[]): TrajectoryTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = turn.groups.flatMap((group) =>
      group.cells.flatMap((cell): TrajectoryTimelineSpan[] => {
        const range = cellRange(cell);
        return range === null
          ? []
          : [
              {
                ...range,
                index: cell.index,
                isError: cell.isError === true && cell.recovered !== true,
                recovered: cell.recovered === true,
                kind: cell.kind,
                label: cell.text,
                lane: laneFor(cell.kind),
              },
            ];
      }),
    );
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const rawSpans = timedTurns.flatMap((turn) => turn.rawSpans);
  if (rawSpans.length === 0) return null;

  // 压缩空闲:按开始时间扫描,记录每个区段之前累计移除的空闲时长,再整体左移。
  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...rawSpans].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const turn of timedTurns) {
    const projected = turn.rawSpans.map((span): TrajectoryTimelineSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return { ...span, start: span.start - offset, end: span.end - offset };
    });
    spans.push(...projected);
    turnBoundaries.push({ turn: turn.turn, time: Math.min(...projected.map((span) => span.start)) });
  }

  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
  };
}

/**
 * 选中区间内活动的记录序号集合(台账聚焦/淡出用)。
 */
export function trajectoryTimelineFocusIndexes(
  turns: TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = "sequence",
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    model?.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  );
}
