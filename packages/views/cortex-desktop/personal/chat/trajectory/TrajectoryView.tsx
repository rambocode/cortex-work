// Trajectory 视图组合层(复刻 deepseek-harness TrajectoryView 的状态编排):
// 工具栏(时长模式/全折叠/搜索) + 概览时间线 + 事件台账。数据来自会话的运行事件流与
// 每轮 prompt 记录,折叠由 trajectory-layout 完成。
import { useCallback, useMemo, useState } from "react";
import type { RunEvent, RunPromptRecord } from "@cortex-work/core";
import { buildTrajectoryLayout } from "./trajectory-layout";
import { trajectoryRecordId } from "./trajectory-model";
import { trajectorySearchMatches } from "./trajectory-search";
import {
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from "./trajectory-timeline-model";
import { TrajectoryTable } from "./TrajectoryTable";
import { TrajectoryTimeline } from "./TrajectoryTimeline";
import { TrajectoryToolbar } from "./TrajectoryToolbar";

const EMPTY_TURN_IDS: ReadonlySet<number> = new Set();
const EMPTY_RECORD_IDS: ReadonlySet<string> = new Set();

export interface TrajectoryViewProps {
  events: RunEvent[];
  prompts: RunPromptRecord[];
  running: boolean;
  /** tool 名兜底文案(i18n)。 */
  fallbackToolName: string;
}

export function TrajectoryView({ events, prompts, running, fallbackToolName }: TrajectoryViewProps) {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURN_IDS);
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(EMPTY_RECORD_IDS);
  const [timelineSelection, setTimelineSelection] = useState<TrajectoryTimeRange | null>(null);
  const [actualDuration, setActualDuration] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null);
  const [timelineRecordSelection, setTimelineRecordSelection] = useState<{ index: number } | null>(null);
  const [timelineRecordFocus, setTimelineRecordFocus] = useState<{ index: number } | null>(null);

  const { turns, requests } = useMemo(
    () => buildTrajectoryLayout({ events, prompts, running, fallbackToolName }),
    [events, prompts, running, fallbackToolName],
  );
  const timelineMode: TrajectoryTimelineMode = actualDuration ? "duration" : "sequence";
  const searchMatchIndexes = useMemo(() => trajectorySearchMatches(turns, searchQuery), [turns, searchQuery]);
  const timelineFocusIndexes = useMemo(
    () =>
      timelineSelection === null ? null : trajectoryTimelineFocusIndexes(turns, timelineSelection, timelineMode),
    [timelineMode, timelineSelection, turns],
  );

  // 台账里点选了聚焦区外的行 → 视为放弃时间线选区(参照实现 handleRecordSelect)。
  const handleRecordSelect = useCallback(
    (index: number) => {
      if (timelineFocusIndexes !== null && !timelineFocusIndexes.has(index)) {
        setTimelineSelection(null);
      }
    },
    [timelineFocusIndexes],
  );
  const handleTimelineRangeChange = useCallback((range: TrajectoryTimeRange | null) => {
    setTimelineSelection(range);
  }, []);
  const handleTimelineRecordSelect = useCallback((index: number) => {
    setTimelineSelection(null);
    setTimelineRecordSelection({ index });
    setSelectedTimelineIndex(index);
  }, []);
  const handleTimelineRecordFocus = useCallback((index: number) => {
    setTimelineRecordFocus({ index });
  }, []);

  // 可折叠对象集合(> 1 行的轮 / 后随工具行的 assistant),驱动全折叠按钮的开合态。
  const collapsibleTurnIds = useMemo(
    () =>
      turns
        .filter((turn) => turn.groups.reduce((count, group) => count + group.cells.length, 0) > 1)
        .map((turn) => turn.turn),
    [turns],
  );
  const allTurnsCollapsed =
    collapsibleTurnIds.length > 0 && collapsibleTurnIds.every((turn) => collapsedTurns.has(turn));
  const collapsibleAssistantIds = useMemo(() => {
    const ids: string[] = [];
    for (const turn of turns) {
      const cells = turn.groups.flatMap((group) => group.cells);
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (cell?.kind !== "message") continue;
        if (cells[i + 1]?.kind === "tool") ids.push(trajectoryRecordId(cell));
      }
    }
    return ids;
  }, [turns]);
  const allAssistantsCollapsed =
    collapsibleAssistantIds.length > 0 && collapsibleAssistantIds.every((id) => collapsedAssistants.has(id));

  const toggleTurn = (turn: number) => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current);
      if (collapsed.has(turn)) collapsed.delete(turn);
      else collapsed.add(turn);
      return collapsed;
    });
  };

  const toggleAllTurns = () => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current);
      for (const turn of collapsibleTurnIds) {
        if (allTurnsCollapsed) collapsed.delete(turn);
        else collapsed.add(turn);
      }
      return collapsed;
    });
  };

  const toggleAssistant = (id: string) => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current);
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      return collapsed;
    });
  };

  const toggleAllAssistants = () => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current);
      for (const id of collapsibleAssistantIds) {
        if (allAssistantsCollapsed) collapsed.delete(id);
        else collapsed.add(id);
      }
      return collapsed;
    });
  };

  return (
    <div className="pw-traj-root">
      <TrajectoryToolbar
        actualDuration={actualDuration}
        onActualDurationChange={(next) => {
          setActualDuration(next);
          setTimelineSelection(null);
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        allAssistantsCollapsed={allAssistantsCollapsed}
        onToggleAllAssistants={toggleAllAssistants}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />
      <TrajectoryTimeline
        turns={turns}
        mode={timelineMode}
        range={timelineSelection}
        selectedIndex={selectedTimelineIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={handleTimelineRangeChange}
        onRecordSelect={handleTimelineRecordSelect}
        onRecordFocus={handleTimelineRecordFocus}
      />
      <div className="pw-traj-ledger">
        <TrajectoryTable
          turns={turns}
          requests={requests}
          timelineFocusIndexes={timelineFocusIndexes}
          searchMatchIndexes={searchMatchIndexes}
          onSelectedIndexChange={setSelectedTimelineIndex}
          onRecordSelect={handleRecordSelect}
          recordSelection={timelineRecordSelection}
          recordFocus={timelineRecordFocus}
          onClearSelection={() => setTimelineSelection(null)}
          collapsedTurns={collapsedTurns}
          onToggleTurn={toggleTurn}
          collapsedAssistants={collapsedAssistants}
          onToggleAssistant={toggleAssistant}
          sessionRunning={running}
        />
      </div>
    </div>
  );
}
