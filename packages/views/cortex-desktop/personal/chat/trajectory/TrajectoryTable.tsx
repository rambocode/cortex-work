// 轮感知的 trajectory 事件台账(复刻 deepseek-harness TrajectoryTable):
// 两列表格(事件位 | 内容),轮标签 + 轮竖轨 + 选中竖轨 + 请求边界圆点;行点击进右侧
// 详情检查器,双击折叠轮/assistant 工具组;时间线聚焦淡出区外行并滚动就位;
// 底部跟随(贴底时新事件自动滚入)。虚拟化裁剪:事件流上限 1000 条,整表直渲足够。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  trajectoryRecordId,
  type TrajectoryCellKind,
  type TrajectoryRequestInfo,
  type TrajectoryTurnModel,
} from "./trajectory-model";
import {
  assistantToolCalls,
  collapseAssistantRecords,
  collapseTurnRecords,
  filterRecords,
  flattenRecords,
  indexRequestBoundaries,
  indexRequestNumbers,
  recordDisplayText,
  recordResultText,
  requestKey,
  sectionLabel,
  stateOf,
  toolCallTextParts,
  type SelectedRequest,
  type TableRecord,
} from "./trajectory-table-model";
import { detailTabs, TrajectoryDetails, type DetailTab } from "./TrajectoryDetails";

const BOTTOM_FOLLOW_THRESHOLD_PX = 2;

const KIND_LABEL: Record<TrajectoryCellKind, string> = {
  user: "USER",
  context: "CONTEXT",
  message: "ASSISTANT",
  tool: "TOOL",
};

const KIND_TAG_CLASS: Record<TrajectoryCellKind, string> = {
  user: "is-user",
  context: "is-context",
  message: "is-assistant",
  tool: "is-tool",
};

// 工具扳手图标(与参照实现同形)。
function ToolWrenchIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" />
    </svg>
  );
}

// CONTEXT 信息圈图标(与参照实现同形)。
function InformationIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.7" />
      <circle cx="8" cy="5.5" r=".85" fill="currentColor" stroke="none" />
      <path d="M8 7.75v3.4" strokeWidth="1.8" />
    </svg>
  );
}

// USER 头像图标。
function UserIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="5" r="2.8" />
      <path d="M2.6 14a5.4 5.4 0 0 1 10.8 0" />
    </svg>
  );
}

const KIND_ICON: Record<TrajectoryCellKind, ReactNode> = {
  user: <UserIcon />,
  context: <InformationIcon />,
  message: <Icon.Sparkle size={13} />,
  tool: <ToolWrenchIcon />,
};

export interface TrajectoryTableProps {
  turns: TrajectoryTurnModel[];
  requests: TrajectoryRequestInfo[];
  /** 时间线聚焦的记录序号集合(区外行淡出)。 */
  timelineFocusIndexes: ReadonlySet<number> | null;
  /** 搜索命中集合(null = 无查询)。 */
  searchMatchIndexes: ReadonlySet<number> | null;
  onSelectedIndexChange?: (index: number | null) => void;
  /** 选中某行后可能需要清掉时间线选区(行在区外时)。 */
  onRecordSelect?: (index: number) => void;
  /** 外部(时间线点击)请求选中;新对象重复触发。 */
  recordSelection: { index: number } | null;
  /** 外部请求仅滚动就位不改选中。 */
  recordFocus: { index: number } | null;
  onClearSelection?: () => void;
  collapsedTurns: ReadonlySet<number>;
  onToggleTurn: (turn: number) => void;
  collapsedAssistants: ReadonlySet<string>;
  onToggleAssistant: (id: string) => void;
  sessionRunning: boolean;
}

export function TrajectoryTable({
  turns,
  requests,
  timelineFocusIndexes,
  searchMatchIndexes,
  onSelectedIndexChange,
  onRecordSelect,
  recordSelection,
  recordFocus,
  onClearSelection,
  collapsedTurns,
  onToggleTurn,
  collapsedAssistants,
  onToggleAssistant,
  sessionRunning,
}: TrajectoryTableProps) {
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<SelectedRequest | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null);
  const [toolRequestOffset, setToolRequestOffset] = useState<number | null>(null);
  const appliedRecordSelection = useRef<{ index: number } | null>(null);
  const appliedRecordFocus = useRef<{ index: number } | null>(null);
  const tabHistory = useRef<Set<DetailTab>>(new Set(["overview"]));
  const rootRef = useRef<HTMLDivElement>(null);
  const tablePaneRef = useRef<HTMLDivElement>(null);
  const followsTableTail = useRef(true);
  const tableScrollInitialized = useRef(false);
  const pendingScrollRecordId = useRef<string | null>(null);

  const allRecords = useMemo(() => flattenRecords(turns), [turns]);
  const selected = useMemo(
    () =>
      selectedRecordId === null
        ? undefined
        : allRecords.find((record) => trajectoryRecordId(record.cell) === selectedRecordId),
    [allRecords, selectedRecordId],
  );
  const selectedIndex = selected?.cell.index ?? null;
  useEffect(() => {
    onSelectedIndexChange?.(selectedIndex);
  }, [onSelectedIndexChange, selectedIndex]);
  const requestBoundaries = useMemo(() => indexRequestBoundaries(allRecords), [allRecords]);
  const requestNumbers = useMemo(() => indexRequestNumbers(requests), [requests]);
  // 展示序:搜索命中过滤优先;否则套轮折叠 + assistant 折叠。
  const records = useMemo(() => {
    if (searchMatchIndexes !== null) return filterRecords(allRecords, searchMatchIndexes);
    const turnRecords = collapsedTurns.size === 0 ? allRecords : collapseTurnRecords(allRecords, collapsedTurns);
    return collapsedAssistants.size === 0 ? turnRecords : collapseAssistantRecords(turnRecords, collapsedAssistants);
  }, [allRecords, collapsedAssistants, collapsedTurns, searchMatchIndexes]);

  const selectedState = selected === undefined ? undefined : stateOf(selected, sessionRunning);
  const selectedRequestRecords = useMemo(
    () =>
      selectedRequest === null
        ? []
        : allRecords.filter(
            (record) => record.turn === selectedRequest.turn && record.group === selectedRequest.group,
          ),
    [allRecords, selectedRequest],
  );
  const selectedRequestNumber =
    selectedRequest === null ? undefined : requestNumbers.get(requestKey(selectedRequest.turn, selectedRequest.group));
  const selectedRequestInfo =
    selectedRequest === null
      ? undefined
      : requests.find(
          (request) => request.turn === selectedRequest.turn && request.group === selectedRequest.group,
        );
  // message 行 → 所属请求;tool 行 → 父 assistant 行(层级跳转)。
  const selectedAssistantRequest = useMemo(() => {
    if (selected?.cell.kind !== "message") return undefined;
    const number = requestNumbers.get(requestKey(selected.turn, selected.group));
    if (number === undefined) return undefined;
    return { target: { turn: selected.turn, group: selected.group }, number };
  }, [requestNumbers, selected]);
  const selectedParentMessage = useMemo(() => {
    if (selected?.cell.kind !== "tool") return undefined;
    const at = allRecords.findIndex((record) => record.cell.index === selected.cell.index);
    for (let i = at - 1; i >= 0; i--) {
      const candidate = allRecords[i];
      if (candidate === undefined || candidate.turn !== selected.turn || candidate.group !== selected.group) break;
      if (candidate.cell.kind === "message") return candidate;
    }
    return undefined;
  }, [allRecords, selected]);
  const activeTurn = selectedRequest === null ? selected?.turn : selectedRequest.turn;
  const splitStyle =
    toolRequestOffset === null
      ? undefined
      : ({ "--pw-traj-tool-request-width": `calc(58cqw - ${toolRequestOffset}px)` } as CSSProperties);

  const activateTab = (tab: DetailTab) => {
    tabHistory.current.delete(tab);
    tabHistory.current.add(tab);
    setActiveTab(tab);
  };

  const clearInspectorSelection = () => {
    setSelectedRecordId(null);
    setSelectedRequest(null);
  };

  const clearAllSelections = () => {
    clearInspectorSelection();
    onClearSelection?.();
  };

  // 选中一行:复用「最近用过且此类型可用」的页签(参照实现的 tab history 行为)。
  const selectRecord = useCallback(
    (index: number) => {
      const record = allRecords.find((candidate) => candidate.cell.index === index);
      onRecordSelect?.(index);
      setSelectedRequest(null);
      setSelectedRecordId(record === undefined ? null : trajectoryRecordId(record.cell));
      if (record === undefined) return;
      const tabs = detailTabs(record);
      const available = new Set(tabs.map((tab) => tab.id));
      const recent = [...tabHistory.current].reverse().find((tab) => available.has(tab));
      setActiveTab(recent ?? tabs[0]?.id ?? "overview");
    },
    [allRecords, onRecordSelect],
  );
  useEffect(() => {
    if (recordSelection === null || appliedRecordSelection.current === recordSelection) return;
    appliedRecordSelection.current = recordSelection;
    selectRecord(recordSelection.index);
    const record = allRecords.find((candidate) => candidate.cell.index === recordSelection.index);
    pendingScrollRecordId.current = record === undefined ? null : trajectoryRecordId(record.cell);
  }, [allRecords, recordSelection, selectRecord]);
  useEffect(() => {
    if (recordFocus === null || appliedRecordFocus.current === recordFocus) return;
    appliedRecordFocus.current = recordFocus;
    const record = allRecords.find((candidate) => candidate.cell.index === recordFocus.index);
    pendingScrollRecordId.current = record === undefined ? null : trajectoryRecordId(record.cell);
  }, [allRecords, recordFocus]);

  const selectRequest = (request: SelectedRequest, tab: "overview" | "timing" = "overview") => {
    setSelectedRecordId(null);
    setSelectedRequest(request);
    activateTab(tab);
  };

  // 打开某行 Summary:先展开其所在折叠轮/折叠 assistant,再选中并记待滚动。
  const openRecordSummary = (target: TableRecord) => {
    const targetAt = allRecords.findIndex((record) => record.cell.index === target.cell.index);
    if (collapsedTurns.has(target.turn)) onToggleTurn(target.turn);
    if (target.cell.kind === "tool") {
      for (let i = targetAt - 1; i >= 0; i--) {
        const candidate = allRecords[i];
        if (candidate === undefined || candidate.turn !== target.turn) break;
        if (candidate.cell.kind !== "message") continue;
        const assistantId = trajectoryRecordId(candidate.cell);
        if (collapsedAssistants.has(assistantId)) onToggleAssistant(assistantId);
        break;
      }
    }
    setSelectedRequest(null);
    setSelectedRecordId(trajectoryRecordId(target.cell));
    activateTab("overview");
    pendingScrollRecordId.current = trajectoryRecordId(target.cell);
  };

  // 待滚动的行渲染后平滑滚到视野中央。
  useEffect(() => {
    const id = pendingScrollRecordId.current;
    if (id === null) return;
    const position = records.findIndex(
      (record) => trajectoryRecordId(record.cell) === id && record.collapsedSummary === undefined,
    );
    if (position === -1) return;
    pendingScrollRecordId.current = null;
    followsTableTail.current = false;
    const recordIndex = records[position]?.cell.index;
    const row =
      recordIndex === undefined
        ? null
        : rootRef.current?.querySelector<HTMLElement>(`tr[data-record-index="${recordIndex}"]`);
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [records]);
  // 时间线聚焦变化:聚焦范围滚入视野(超屏对齐首行,否则居中)。
  useEffect(() => {
    if (timelineFocusIndexes === null || timelineFocusIndexes.size === 0) return;
    const ledger = tablePaneRef.current;
    if (ledger === null) return;
    const focusedRows = [...ledger.querySelectorAll<HTMLElement>('tr[data-timeline-focus="inside"]')];
    const firstRow = focusedRows[0];
    const lastRow = focusedRows[focusedRows.length - 1];
    if (firstRow === undefined || lastRow === undefined) return;
    const focusHeight = lastRow.getBoundingClientRect().bottom - firstRow.getBoundingClientRect().top;
    const target = focusHeight > ledger.clientHeight ? firstRow : focusedRows[Math.floor((focusedRows.length - 1) / 2)];
    if (target !== undefined && typeof target.scrollIntoView === "function") {
      followsTableTail.current = false;
      target.scrollIntoView({ behavior: "smooth", block: focusHeight > ledger.clientHeight ? "start" : "center" });
    }
  }, [timelineFocusIndexes]);
  // 初次挂载滚到底;此后贴底时新行保持贴底(跟随流式输出)。
  useLayoutEffect(() => {
    const pane = tablePaneRef.current;
    if (pane === null) return;
    if (!tableScrollInitialized.current) {
      tableScrollInitialized.current = true;
      followsTableTail.current = true;
      pane.scrollTop = pane.scrollHeight;
      return;
    }
    if (!followsTableTail.current) return;
    pane.scrollTop = pane.scrollHeight;
  }, [records]);

  return (
    <div ref={rootRef} className="pw-traj-split" style={splitStyle}>
      <div
        ref={tablePaneRef}
        className="pw-traj-table-pane"
        onScroll={(event) => {
          const pane = event.currentTarget;
          followsTableTail.current =
            pane.scrollHeight - pane.clientHeight - pane.scrollTop <= BOTTOM_FOLLOW_THRESHOLD_PX;
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearAllSelections();
        }}
      >
        <table className="pw-traj-table" aria-rowcount={records.length}>
          <colgroup>
            <col className="pw-traj-event-col" />
            <col className="pw-traj-content-col" />
          </colgroup>
          <tbody>
            {records.map((record, position) => {
              const isCollapsedSummary = record.collapsedSummary !== undefined;
              const key = requestKey(record.turn, record.group);
              const request =
                requestBoundaries.get(key) === record.cell.index &&
                !isCollapsedSummary &&
                !collapsedTurns.has(record.turn)
                  ? requestNumbers.get(key)
                  : undefined;
              const requestInfo =
                request === undefined ? undefined : requests.find((candidate) => candidate.number === request);
              const requestStatus = requestInfo?.status === "error" || record.cell.isError ? "error" : undefined;
              const requestLabel = request === undefined ? undefined : `Request #${request}`;
              const requestSelected =
                request !== undefined &&
                selectedRequest?.turn === record.turn &&
                selectedRequest.group === record.group;
              const state = stateOf(record, sessionRunning);
              const displayText = recordDisplayText(record.cell);
              const toolText = toolCallTextParts(record);
              const resultText = recordResultText(record.cell);
              const rowKey = isCollapsedSummary
                ? `${trajectoryRecordId(record.cell)}:summary:${record.collapsedSummaryKind}`
                : trajectoryRecordId(record.cell);
              const listText =
                toolText === undefined ? displayText : [toolText.name, toolText.args].filter(Boolean).join(" ");
              return (
                <tr
                  key={rowKey}
                  tabIndex={0}
                  aria-rowindex={position + 1}
                  aria-label={
                    isCollapsedSummary
                      ? `Collapsed ${record.collapsedSummaryKind} summary, ${record.collapsedSummary}`
                      : `${request === undefined ? "" : `Request ${request}, `}${KIND_LABEL[record.cell.kind]}, ${listText || "no content"}`
                  }
                  aria-selected={!isCollapsedSummary && selectedIndex === record.cell.index}
                  data-kind={record.cell.kind}
                  data-record-index={!isCollapsedSummary ? record.cell.index : undefined}
                  data-group-start={record.groupStart || undefined}
                  data-turn-start={record.turnStart || undefined}
                  data-error={record.cell.isError || undefined}
                  data-running={state === "running" || undefined}
                  data-turn-end={record.turnEnd || undefined}
                  data-collapsed-summary={record.collapsedSummaryKind}
                  data-selected={(!isCollapsedSummary && selectedIndex === record.cell.index) || undefined}
                  data-timeline-focus={
                    isCollapsedSummary || timelineFocusIndexes === null
                      ? undefined
                      : timelineFocusIndexes.has(record.cell.index)
                        ? "inside"
                        : "outside"
                  }
                  onClick={
                    isCollapsedSummary
                      ? () => {
                          if (record.collapsedSummaryKind === "turn") onToggleTurn(record.turn);
                          else onToggleAssistant(trajectoryRecordId(record.cell));
                        }
                      : () => selectRecord(record.cell.index)
                  }
                  onDoubleClick={(event) => {
                    if (isCollapsedSummary) return;
                    // 双击优先级:展开折叠轮 > 折叠 assistant 工具组 > 折叠整轮(轮首行)。
                    if (collapsedTurns.has(record.turn)) {
                      event.preventDefault();
                      onToggleTurn(record.turn);
                      return;
                    }
                    if (record.cell.kind === "message" && assistantToolCalls(allRecords, record.cell.index).length > 0) {
                      event.preventDefault();
                      onToggleAssistant(trajectoryRecordId(record.cell));
                      return;
                    }
                    if (!record.turnStart) return;
                    if (allRecords.filter((candidate) => candidate.turn === record.turn).length <= 1) return;
                    event.preventDefault();
                    onToggleTurn(record.turn);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (isCollapsedSummary) {
                      if (record.collapsedSummaryKind === "turn") onToggleTurn(record.turn);
                      else onToggleAssistant(trajectoryRecordId(record.cell));
                      return;
                    }
                    selectRecord(record.cell.index);
                  }}
                >
                  <td className="pw-traj-event">
                    {request !== undefined && (
                      <button
                        type="button"
                        className={
                          requestSelected
                            ? "pw-traj-request-boundary is-active"
                            : "pw-traj-request-boundary"
                        }
                        aria-label={requestLabel}
                        aria-pressed={requestSelected}
                        data-label={requestLabel}
                        data-request-status={requestStatus}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectRequest({ turn: record.turn, group: record.group });
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                      />
                    )}
                    {activeTurn === record.turn && <span className="pw-traj-turn-rail" aria-hidden="true" />}
                    {!isCollapsedSummary && selectedIndex === record.cell.index && (
                      <span className="pw-traj-selection-rail" aria-hidden="true" />
                    )}
                    {!isCollapsedSummary && record.turnStart && (
                      <span
                        className={
                          activeTurn === record.turn ? "pw-traj-turn-label is-active" : "pw-traj-turn-label"
                        }
                        aria-label={sectionLabel(record.turn)}
                      >
                        <span className="pw-traj-turn-label-full" aria-hidden="true">
                          {sectionLabel(record.turn)}
                        </span>
                        <span className="pw-traj-turn-label-compact" aria-hidden="true">
                          #{record.turn}
                        </span>
                      </span>
                    )}
                    <div className="pw-traj-event-inner">
                      {!isCollapsedSummary && (
                        <span className="pw-traj-kind-slot">
                          <span
                            className={`pw-traj-kind-tag ${KIND_TAG_CLASS[record.cell.kind]}`}
                            title={KIND_LABEL[record.cell.kind]}
                          >
                            <span className="pw-traj-kind-tag-icon" aria-hidden="true">
                              {KIND_ICON[record.cell.kind]}
                            </span>
                            <span className="pw-traj-kind-tag-label">{KIND_LABEL[record.cell.kind]}</span>
                          </span>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="pw-traj-content">
                    {record.collapsedSummary !== undefined ? (
                      <span className="pw-traj-collapsed-content" title={record.collapsedSummary}>
                        <span className="pw-traj-collapsed-ellipsis">…</span>
                        <span className="pw-traj-collapsed-text">{record.collapsedSummary}</span>
                      </span>
                    ) : (
                      <span
                        className={resultText === undefined ? "pw-traj-content-text" : "pw-traj-result-preview"}
                        title={resultText === undefined ? listText : `${listText} → ${resultText}`}
                      >
                        <span className={resultText === undefined ? undefined : "pw-traj-result-request"}>
                          {toolText === undefined ? (
                            displayText || "—"
                          ) : (
                            <>
                              <span className="pw-traj-tool-name">{toolText.name || "—"}</span>
                              {toolText.args !== undefined && (
                                <span className="pw-traj-tool-args">{toolText.args}</span>
                              )}
                            </>
                          )}
                        </span>
                        {resultText !== undefined && (
                          <span className={record.cell.isError ? "pw-traj-inline-result is-error" : "pw-traj-inline-result"}>
                            <span className="pw-traj-arrow">→</span>
                            <span
                              className={
                                resultText === "No output"
                                  ? "pw-traj-inline-result-text is-no-output"
                                  : "pw-traj-inline-result-text"
                              }
                            >
                              {resultText}
                            </span>
                          </span>
                        )}
                        {state === "running" && record.cell.kind === "tool" && (
                          <span className="pw-traj-running-dot" aria-hidden="true" />
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(selectedRequest !== null || (selected !== undefined && selectedState !== undefined)) && (
        <TrajectoryDetails
          selected={selected}
          selectedState={selectedState}
          selectedRequest={selectedRequest}
          requestInfo={selectedRequestInfo}
          requestNumber={selectedRequestNumber}
          requestRecords={selectedRequestRecords}
          activeTab={activeTab}
          onActivateTab={activateTab}
          onClose={clearInspectorSelection}
          onOpenRecord={openRecordSummary}
          onSelectRequest={selectRequest}
          selectedAssistantRequest={selectedAssistantRequest}
          selectedParentMessage={selectedParentMessage}
          detailsWidth={detailsWidth}
          onDetailsWidthChange={setDetailsWidth}
          toolRequestOffset={toolRequestOffset}
          onToolRequestOffsetChange={setToolRequestOffset}
        />
      )}
    </div>
  );
}
