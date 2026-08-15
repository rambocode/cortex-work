// Trajectory 顶部工具栏(复刻 deepseek-harness TrajectoryToolbar):时长模式切换、
// 全轮/全调用折叠、右侧实时搜索。按钮文案沿用参照实现 zh 词典(Duration/Turns/Calls 保持英文)。
import { Icon } from "@cortex-work/ui/icons";

export interface TrajectoryToolbarProps {
  /** 时间线是否按真实时长投影(false = 等宽序号)。 */
  actualDuration: boolean;
  onActualDurationChange: (actualDuration: boolean) => void;
  /** 全部可折叠轮当前是否都已折叠。 */
  allTurnsCollapsed: boolean;
  onToggleAllTurns: () => void;
  /** 全部可折叠 assistant 的工具调用是否都已折叠。 */
  allAssistantsCollapsed: boolean;
  onToggleAllAssistants: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}

export function TrajectoryToolbar({
  actualDuration,
  onActualDurationChange,
  allTurnsCollapsed,
  onToggleAllTurns,
  allAssistantsCollapsed,
  onToggleAllAssistants,
  searchQuery,
  onSearchQueryChange,
}: TrajectoryToolbarProps) {
  return (
    <div className="pw-traj-toolbar" role="toolbar" aria-label="Trajectory toolbar">
      <div className="pw-traj-toolbar-inner">
        <div className="pw-traj-toolbar-actions">
          <button
            type="button"
            className="pw-traj-toolbar-toggle"
            aria-label="Use actual duration"
            aria-pressed={actualDuration}
            title={actualDuration ? "Use equal-width operations" : "Use actual duration"}
            onClick={() => onActualDurationChange(!actualDuration)}
          >
            {/* 时钟图标:与参照实现同一 16 视口圆 + 指针形状 */}
            <svg className="pw-traj-toolbar-toggle-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5.25" />
              <path d="M8 4.75V8l2.25 1.5" />
            </svg>
            Duration
          </button>
          <button
            type="button"
            className="pw-traj-toolbar-action"
            aria-label={allTurnsCollapsed ? "Expand turns" : "Collapse turns"}
            aria-pressed={allTurnsCollapsed}
            title={allTurnsCollapsed ? "Expand turns" : "Collapse turns"}
            onClick={onToggleAllTurns}
          >
            <span className="pw-traj-toolbar-action-icon" aria-hidden="true">
              {allTurnsCollapsed ? "⊞" : "⊟"}
            </span>
            Turns
          </button>
          <button
            type="button"
            className="pw-traj-toolbar-action"
            aria-label={allAssistantsCollapsed ? "Expand calls" : "Collapse calls"}
            aria-pressed={allAssistantsCollapsed}
            title={allAssistantsCollapsed ? "Expand calls" : "Collapse calls"}
            onClick={onToggleAllAssistants}
          >
            <span className="pw-traj-toolbar-action-icon" aria-hidden="true">
              {allAssistantsCollapsed ? "⊞" : "⊟"}
            </span>
            Calls
          </button>
        </div>
        <div className="pw-traj-toolbar-search">
          <Icon.Search size={11} />
          <input
            type="search"
            className="pw-traj-toolbar-search-input"
            aria-label="Search trajectory"
            placeholder="搜索"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          />
        </div>
      </div>
    </div>
  );
}
