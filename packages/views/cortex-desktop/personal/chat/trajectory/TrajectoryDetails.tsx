// 详情检查器右栏(复刻 deepseek-harness TrajectoryTable 的 details aside):
// 头部(类型徽章 + 位置 + 关闭)、页签条、按行类型分发的面板(Summary/Preview/Raw/Payload/
// Result/Timing/Usage),以及左缘拖拽调宽把手(双击复位、方向键步进)。
import { useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@cortex-work/ui/icons";
import {
  formatDurationMs,
  formatElapsedSeconds,
  formatStartedAt,
  type TrajectoryRequestInfo,
  type TrajectoryUsage,
} from "./trajectory-model";
import {
  sectionLabel,
  statusLabel,
  type RecordState,
  type SelectedRequest,
  type TableRecord,
} from "./trajectory-table-model";

/** 详情页签闭集。 */
export type DetailTab = "overview" | "rendered" | "raw" | "input" | "output" | "timing" | "usage";

export interface DetailTabItem {
  id: DetailTab;
  label: string;
}

const REQUEST_TABS: DetailTabItem[] = [
  { id: "overview", label: "Summary" },
  { id: "usage", label: "Usage" },
  { id: "timing", label: "Timing" },
];

/** 行类型 → 可用页签(参照实现 detailTabs 的裁剪版:本仓库无 schema/source 数据)。 */
export function detailTabs(record: TableRecord): DetailTabItem[] {
  if (record.cell.kind === "tool") {
    return [
      { id: "overview", label: "Summary" },
      ...(record.cell.inputDetail ? [{ id: "input", label: "Payload" } as const] : []),
      ...(record.cell.outputDetail ? [{ id: "output", label: "Result" } as const] : []),
      { id: "timing", label: "Timing" },
    ];
  }
  return [
    { id: "overview", label: "Summary" },
    { id: "rendered", label: "Preview" },
    { id: "raw", label: "Raw" },
  ];
}

/** 请求检查器可用页签。 */
export function requestDetailTabs(): DetailTabItem[] {
  return REQUEST_TABS;
}

const KIND_LABEL: Record<TableRecord["cell"]["kind"], string> = {
  user: "USER",
  context: "CONTEXT",
  message: "ASSISTANT",
  tool: "TOOL",
};

const KIND_TAG_CLASS: Record<TableRecord["cell"]["kind"], string> = {
  user: "is-user",
  context: "is-context",
  message: "is-assistant",
  tool: "is-tool",
};

const DETAILS_MIN_WIDTH = 320;
const DETAILS_MAX_WIDTH = 720;
const TABLE_MIN_WIDTH = 280;
const DETAILS_RESIZE_STEP = 16;
const TOOL_REQUEST_SHARE = 0.58;
const TOOL_REQUEST_MIN_WIDTH = 180;
const TOOL_REQUEST_MAX_WIDTH = 480;
const DEFAULT_TOOL_REQUEST_SHARE = 0.36;
const DEFAULT_TOOL_REQUEST_OFFSET = 56;

interface DetailsResizeDrag {
  pointerId: number;
  startX: number;
  startWidth: number;
  splitWidth: number;
  startToolRequestOffset: number;
}

function clampDetailsWidth(width: number, splitWidth: number): number {
  const maxWidth = Math.max(DETAILS_MIN_WIDTH, Math.min(DETAILS_MAX_WIDTH, splitWidth - TABLE_MIN_WIDTH));
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maxWidth));
}

function defaultToolRequestWidth(splitWidth: number): number {
  return Math.min(
    Math.max(splitWidth * DEFAULT_TOOL_REQUEST_SHARE - DEFAULT_TOOL_REQUEST_OFFSET, TOOL_REQUEST_MIN_WIDTH),
    TOOL_REQUEST_MAX_WIDTH,
  );
}

/** 点击是否落在文本选区内(保留选区,不触发点击行为)。 */
function clickSelectsText(target: Node): boolean {
  const selection = window.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    selection.rangeCount > 0 &&
    selection.getRangeAt(0).intersectsNode(target)
  );
}

// 开始时间值:点击在本地时间与 Unix 时间戳之间切换(参照实现 StartedAtValue)。
function StartedAtValue({ timestamp }: { timestamp: number | null | undefined }) {
  const [showUnix, setShowUnix] = useState(false);
  const formatted = formatStartedAt(timestamp);
  if (formatted === null || timestamp === null || timestamp === undefined) return <dd>Not available</dd>;
  return (
    <dd>
      <button
        type="button"
        className="pw-traj-timestamp-toggle"
        title={showUnix ? "Show local time" : "Show Unix timestamp"}
        onClick={(event) => {
          if (clickSelectsText(event.currentTarget)) return;
          setShowUnix((current) => !current);
        }}
      >
        {showUnix ? (timestamp / 1_000).toFixed(3) : formatted}
      </button>
    </dd>
  );
}

// message 行 token 三行(总量 + 缩进的输入侧细分)。
function TokenRows({ record }: { record: TableRecord }) {
  const cell = record.cell;
  return (
    <>
      <div>
        <dt>Tokens</dt>
        <dd>{cell.output === undefined ? "—" : `${cell.output} tok`}</dd>
      </div>
      {cell.input !== undefined && (
        <div className="pw-traj-token-detail">
          <dt>Input</dt>
          <dd>{cell.input} tok</dd>
        </div>
      )}
      {cell.cacheRead !== undefined && (
        <div className="pw-traj-token-detail">
          <dt>Cached</dt>
          <dd>{cell.cacheRead} tok</dd>
        </div>
      )}
    </>
  );
}

function UsageRows({ usage }: { usage: TrajectoryUsage | undefined }) {
  if (usage === undefined) return <p className="pw-traj-no-payload">Usage not reported</p>;
  const totalInput =
    usage.input === undefined && usage.cacheRead === undefined ? undefined : (usage.input ?? 0) + (usage.cacheRead ?? 0);
  return (
    <dl className="pw-traj-overview">
      {totalInput !== undefined && (
        <div>
          <dt>Input</dt>
          <dd>{totalInput} tok</dd>
        </div>
      )}
      {usage.cacheRead !== undefined && (
        <div className="pw-traj-token-detail">
          <dt>Cached</dt>
          <dd>{usage.cacheRead} tok</dd>
        </div>
      )}
      {usage.input !== undefined && (
        <div className="pw-traj-token-detail">
          <dt>Other</dt>
          <dd>{usage.input} tok</dd>
        </div>
      )}
      {usage.output !== undefined && (
        <div>
          <dt>Output</dt>
          <dd>{usage.output} tok</dd>
        </div>
      )}
    </dl>
  );
}

// 概览分区:标题按钮跳到对应页签,正文是该页签的内容预览。
function OverviewSection({ label, onOpen, children }: { label: string; onOpen: () => void; children: ReactNode }) {
  return (
    <section className="pw-traj-overview-section">
      <h3 className="pw-traj-overview-heading">
        <button type="button" className="pw-traj-overview-title" onClick={onOpen}>
          <span>{label}</span>
          <Icon.ChevronRight size={12} />
        </button>
      </h3>
      <div className="pw-traj-overview-preview">{children}</div>
    </section>
  );
}

// Markdown 片段:rendered 走 react-markdown,raw 走 pre。
function MarkdownFragment({ text, rendered, preview }: { text: string; rendered: boolean; preview: boolean }) {
  if (rendered) {
    return (
      <div className={preview ? "pw-traj-md is-preview" : "pw-traj-md"}>
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
    );
  }
  return <pre className={`pw-traj-payload ${preview ? "is-preview" : ""}`}>{text}</pre>;
}

// user/context/message 行正文(思考段折叠引用块 + 正文,参照 MarkdownRecordContent)。
function MarkdownRecordContent({
  record,
  rendered,
  preview = false,
  thinkingExpanded,
  onThinkingExpandedChange,
}: {
  record: TableRecord;
  rendered: boolean;
  preview?: boolean;
  thinkingExpanded: boolean;
  onThinkingExpandedChange: (expanded: boolean) => void;
}) {
  const cell = record.cell;
  const source = cell.kind === "user" || cell.kind === "context" ? cell.inputDetail : cell.outputDetail;
  if (cell.thinkingDetail) {
    if (!rendered) {
      const raw = [cell.thinkingDetail, cell.outputDetail].filter((value) => value !== undefined && value !== "").join("\n\n");
      return <MarkdownFragment text={raw} rendered={false} preview={preview} />;
    }
    return (
      <div className="pw-traj-assistant-content">
        <div className={preview && !cell.outputDetail ? "pw-traj-thinking-quote is-only-preview" : "pw-traj-thinking-quote"}>
          <button
            type="button"
            className="pw-traj-thinking-toggle"
            aria-expanded={thinkingExpanded}
            onClick={() => onThinkingExpandedChange(!thinkingExpanded)}
          >
            Thinking
            <span className="pw-traj-thinking-chevron">
              <Icon.ChevronRight size={12} />
            </span>
          </button>
          {thinkingExpanded && <MarkdownFragment text={cell.thinkingDetail} rendered preview={preview} />}
        </div>
        {cell.outputDetail && (
          <div className="pw-traj-assistant-output">
            <MarkdownFragment text={cell.outputDetail} rendered preview={preview} />
          </div>
        )}
      </div>
    );
  }
  if (!source || source === "") {
    return <p className="pw-traj-no-payload">{cell.text || "No content"}</p>;
  }
  return <MarkdownFragment text={source} rendered={rendered} preview={preview} />;
}

// tool 行输入/输出面板:JSON 优先美化,错误红色,空态占位。
function RecordPayload({
  record,
  direction,
  preview = false,
}: {
  record: TableRecord;
  direction: "input" | "output";
  preview?: boolean;
}) {
  const value = direction === "input" ? record.cell.inputDetail : record.cell.outputDetail;
  const missing = direction === "input" ? "No payload captured" : "No result captured";
  if (!value) return <p className="pw-traj-no-payload">{missing}</p>;
  const error = direction === "output" && record.cell.isError === true;
  return (
    <pre
      className={[
        "pw-traj-payload",
        preview ? "is-preview" : "",
        error ? "is-error" : "",
        value === "No output" ? "is-no-output" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {value}
    </pre>
  );
}

// 记录 Timing 面板。
function RecordTiming({ record }: { record: TableRecord }) {
  return (
    <dl className="pw-traj-overview">
      <div>
        <dt>Started</dt>
        <StartedAtValue timestamp={record.cell.startedAt} />
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{formatElapsedSeconds(record.cell.timeSeconds)}</dd>
      </div>
      <div>
        <dt>Timing source</dt>
        <dd>{record.cell.timeSeconds === null ? "Not available" : "Session timestamps"}</dd>
      </div>
    </dl>
  );
}

// 请求 Timing 面板(优先 request 起止)。
function RequestTiming({ request, anchor }: { request: TrajectoryRequestInfo | undefined; anchor: TableRecord | undefined }) {
  if (request?.startedAt !== undefined) {
    const duration =
      request.completedAt === null || request.completedAt === undefined
        ? null
        : Math.max(0, (request.completedAt - request.startedAt) / 1000);
    return (
      <dl className="pw-traj-overview">
        <div>
          <dt>Started</dt>
          <StartedAtValue timestamp={request.startedAt} />
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatElapsedSeconds(duration)}</dd>
        </div>
        <div>
          <dt>Timing source</dt>
          <dd>{duration === null ? "Session timestamps (running)" : "Session timestamps"}</dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="pw-traj-overview">
      <div>
        <dt>Started</dt>
        <StartedAtValue timestamp={anchor?.cell.startedAt} />
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{formatElapsedSeconds(null)}</dd>
      </div>
    </dl>
  );
}

export interface TrajectoryDetailsProps {
  selected: TableRecord | undefined;
  selectedState: RecordState | undefined;
  selectedRequest: SelectedRequest | null;
  requestInfo: TrajectoryRequestInfo | undefined;
  requestNumber: number | undefined;
  /** 选中请求(Step)覆盖的行(计数与 assistant 定位)。 */
  requestRecords: TableRecord[];
  activeTab: DetailTab;
  onActivateTab: (tab: DetailTab) => void;
  onClose: () => void;
  /** 打开某行的 Summary(展开折叠并滚动)。 */
  onOpenRecord: (record: TableRecord) => void;
  onSelectRequest: (request: SelectedRequest, tab?: "overview" | "timing") => void;
  /** message 行所属请求(层级跳转)。 */
  selectedAssistantRequest?: { target: SelectedRequest; number: number } | undefined;
  /** tool 行的父 assistant 行(层级跳转)。 */
  selectedParentMessage?: TableRecord | undefined;
  detailsWidth: number | null;
  onDetailsWidthChange: (width: number | null) => void;
  toolRequestOffset: number | null;
  onToolRequestOffsetChange: (offset: number | null) => void;
}

export function TrajectoryDetails({
  selected,
  selectedState,
  selectedRequest,
  requestInfo,
  requestNumber,
  requestRecords,
  activeTab,
  onActivateTab,
  onClose,
  onOpenRecord,
  onSelectRequest,
  selectedAssistantRequest,
  selectedParentMessage,
  detailsWidth,
  onDetailsWidthChange,
  toolRequestOffset,
  onToolRequestOffsetChange,
}: TrajectoryDetailsProps) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const resizeDrag = useRef<DetailsResizeDrag | null>(null);
  const requestAssistant = requestRecords.find((record) => record.cell.kind === "message");
  const requestAnchor = requestAssistant ?? requestRecords[0];
  const requestToolCalls = requestRecords.filter((record) => record.cell.kind === "tool").length;
  const requestUsage =
    requestInfo?.usage ??
    (requestAssistant === undefined
      ? undefined
      : {
          ...(requestAssistant.cell.input === undefined ? {} : { input: requestAssistant.cell.input }),
          ...(requestAssistant.cell.cacheRead === undefined ? {} : { cacheRead: requestAssistant.cell.cacheRead }),
          ...(requestAssistant.cell.output === undefined ? {} : { output: requestAssistant.cell.output }),
        });
  const requestCumulativeUsage = requestInfo?.cumulativeUsage ?? requestUsage;
  const requestState: RecordState | undefined =
    selectedRequest === null ? undefined : (requestInfo?.status ?? "complete");
  const selectedTabs =
    selectedRequest !== null ? requestDetailTabs() : selected === undefined ? [] : detailTabs(selected);

  return (
    <aside
      className="pw-traj-details"
      aria-label="Event details"
      style={detailsWidth === null ? undefined : { width: detailsWidth }}
    >
      {/* 左缘调宽把手:拖拽改右栏宽,同步平移台账工具列的名称/结果分栏点;双击复位。 */}
      <div
        className="pw-traj-details-resize"
        role="separator"
        aria-label="Resize event details"
        aria-orientation="vertical"
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onDoubleClick={() => {
          onDetailsWidthChange(null);
          onToolRequestOffsetChange(null);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const details = event.currentTarget.parentElement;
          const split = details?.parentElement;
          if (!details || !split) return;
          const splitWidth = split.getBoundingClientRect().width;
          resizeDrag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: details.getBoundingClientRect().width,
            splitWidth,
            startToolRequestOffset:
              toolRequestOffset ?? splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const drag = resizeDrag.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          const nextWidth = clampDetailsWidth(drag.startWidth + drag.startX - event.clientX, drag.splitWidth);
          onDetailsWidthChange(nextWidth);
          onToolRequestOffsetChange(drag.startToolRequestOffset + (nextWidth - drag.startWidth) * TOOL_REQUEST_SHARE);
        }}
        onPointerUp={(event) => {
          if (resizeDrag.current?.pointerId !== event.pointerId) return;
          resizeDrag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          resizeDrag.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const details = event.currentTarget.parentElement;
          const split = details?.parentElement;
          if (!details || !split) return;
          const direction = event.key === "ArrowLeft" ? 1 : -1;
          const currentWidth = details.getBoundingClientRect().width;
          const splitWidth = split.getBoundingClientRect().width;
          const nextWidth = clampDetailsWidth(currentWidth + direction * DETAILS_RESIZE_STEP, splitWidth);
          const currentOffset =
            toolRequestOffset ?? splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth);
          onDetailsWidthChange(nextWidth);
          onToolRequestOffsetChange(currentOffset + (nextWidth - currentWidth) * TOOL_REQUEST_SHARE);
          event.preventDefault();
        }}
      />
      <div className="pw-traj-details-header">
        <div className="pw-traj-details-title">
          {selectedRequest !== null ? (
            <>
              <span className="pw-traj-request-dot" aria-hidden="true" />
              <span className="pw-traj-request-name">Request #{requestNumber ?? "—"}</span>
              <span className="pw-traj-details-location">{sectionLabel(selectedRequest.turn)}</span>
            </>
          ) : (
            selected !== undefined && (
              <>
                <span className={`pw-traj-kind-tag ${KIND_TAG_CLASS[selected.cell.kind]}`}>
                  {KIND_LABEL[selected.cell.kind]}
                </span>
                <span className="pw-traj-details-location">
                  {`${sectionLabel(selected.turn)} · ${selected.group}`}
                </span>
              </>
            )
          )}
        </div>
        <button type="button" className="pw-traj-details-close" aria-label="Close details" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="pw-traj-detail-tabs" role="tablist" aria-label="Event details">
        {selectedTabs.map((tab) => (
          <button
            key={tab.id}
            id={`pw-traj-detail-${tab.id}`}
            type="button"
            role="tab"
            aria-controls="pw-traj-detail-panel"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "pw-traj-detail-tab is-active" : "pw-traj-detail-tab"}
            onClick={() => onActivateTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="pw-traj-detail-panel"
        className={activeTab === "overview" ? "pw-traj-detail-body is-summary" : "pw-traj-detail-body"}
        role="tabpanel"
        aria-labelledby={`pw-traj-detail-${activeTab}`}
      >
        {selectedRequest !== null && requestState !== undefined && activeTab === "overview" && (
          <>
            <dl className="pw-traj-overview">
              <div>
                <dt>Status</dt>
                <dd className={requestState === "error" ? "is-error" : undefined}>{statusLabel(requestState)}</dd>
              </div>
              <div>
                <dt>Tool calls</dt>
                <dd>{requestToolCalls}</dd>
              </div>
              {requestInfo?.error !== undefined && (
                <div>
                  <dt>Error</dt>
                  <dd className="is-error">{requestInfo.error}</dd>
                </div>
              )}
              {requestInfo?.retries !== undefined && (
                <div>
                  <dt>Retries</dt>
                  <dd>{requestInfo.retries}</dd>
                </div>
              )}
              {requestInfo?.costUsd !== undefined && (
                <div>
                  <dt>Cost</dt>
                  <dd>${requestInfo.costUsd.toFixed(4)}</dd>
                </div>
              )}
              {requestAssistant !== undefined && (
                <div>
                  <dt>Result</dt>
                  <dd className="pw-traj-parent-links">
                    <button
                      type="button"
                      className="pw-traj-hierarchy-link"
                      onClick={() => onOpenRecord(requestAssistant)}
                    >
                      <span>Assistant Message</span>
                      <Icon.ChevronRight size={11} />
                    </button>
                  </dd>
                </div>
              )}
            </dl>
            <div className="pw-traj-overview-sections">
              <OverviewSection label="Usage" onOpen={() => onActivateTab("usage")}>
                <UsageRows usage={requestUsage} />
              </OverviewSection>
              <OverviewSection label="Timing" onOpen={() => onActivateTab("timing")}>
                <RequestTiming request={requestInfo} anchor={requestAnchor} />
              </OverviewSection>
            </div>
          </>
        )}
        {selectedRequest !== null && activeTab === "usage" && (
          <div className="pw-traj-usage-panel">
            <section className="pw-traj-usage-group">
              <h4 className="pw-traj-usage-heading">This request</h4>
              <UsageRows usage={requestUsage} />
            </section>
            <section className="pw-traj-usage-group">
              <h4 className="pw-traj-usage-heading">Session cumulative</h4>
              <UsageRows usage={requestCumulativeUsage} />
            </section>
          </div>
        )}
        {selectedRequest !== null && activeTab === "timing" && (
          <>
            <RequestTiming request={requestInfo} anchor={requestAnchor} />
            {requestInfo?.retries !== undefined && (
              <dl className="pw-traj-overview">
                <div>
                  <dt>Retries</dt>
                  <dd>{requestInfo.retries}</dd>
                </div>
              </dl>
            )}
          </>
        )}
        {selectedRequest === null && selected !== undefined && selectedState !== undefined && activeTab === "overview" && (
          <>
            <dl className="pw-traj-overview">
              {(selectedAssistantRequest !== undefined || selectedParentMessage !== undefined) && (
                <div>
                  <dt>{selectedAssistantRequest !== undefined && selectedParentMessage === undefined ? "Source" : "Hierarchy"}</dt>
                  <dd className="pw-traj-parent-links">
                    {selectedAssistantRequest !== undefined && (
                      <button
                        type="button"
                        className="pw-traj-hierarchy-link"
                        onClick={() => onSelectRequest(selectedAssistantRequest.target)}
                      >
                        <span>Request #{selectedAssistantRequest.number}</span>
                        <Icon.ChevronRight size={11} />
                      </button>
                    )}
                    {selectedParentMessage !== undefined && (
                      <button
                        type="button"
                        className="pw-traj-hierarchy-link"
                        onClick={() => onOpenRecord(selectedParentMessage)}
                      >
                        <span>Assistant Message</span>
                        <Icon.ChevronRight size={11} />
                      </button>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>Status</dt>
                <dd className={selectedState === "error" ? "is-error" : undefined}>{statusLabel(selectedState)}</dd>
              </div>
              {selected.cell.kind === "message" && <TokenRows record={selected} />}
              {(selected.cell.kind === "user" || selected.cell.kind === "context") && (
                <div>
                  <dt>Duration</dt>
                  <dd>{formatElapsedSeconds(selected.cell.timeSeconds)}</dd>
                </div>
              )}
            </dl>
            <div className="pw-traj-overview-sections">
              {selected.cell.kind !== "tool" ? (
                <OverviewSection label="Preview" onOpen={() => onActivateTab("rendered")}>
                  <MarkdownRecordContent
                    record={selected}
                    rendered
                    preview
                    thinkingExpanded={thinkingExpanded}
                    onThinkingExpandedChange={setThinkingExpanded}
                  />
                </OverviewSection>
              ) : (
                <>
                  {selected.cell.inputDetail && (
                    <OverviewSection label="Payload" onOpen={() => onActivateTab("input")}>
                      <RecordPayload record={selected} direction="input" preview />
                    </OverviewSection>
                  )}
                  {selected.cell.outputDetail !== undefined && (
                    <OverviewSection label="Result" onOpen={() => onActivateTab("output")}>
                      <RecordPayload record={selected} direction="output" preview />
                    </OverviewSection>
                  )}
                  <OverviewSection label="Timing" onOpen={() => onActivateTab("timing")}>
                    <RecordTiming record={selected} />
                  </OverviewSection>
                </>
              )}
              {selected.cell.kind === "message" && selectedAssistantRequest !== undefined && (
                <OverviewSection
                  label="Request Timing"
                  onOpen={() => onSelectRequest(selectedAssistantRequest.target, "timing")}
                >
                  <RecordTiming record={selected} />
                </OverviewSection>
              )}
            </div>
          </>
        )}
        {selectedRequest === null && selected !== undefined && activeTab === "rendered" && (
          <MarkdownRecordContent
            record={selected}
            rendered
            thinkingExpanded={thinkingExpanded}
            onThinkingExpandedChange={setThinkingExpanded}
          />
        )}
        {selectedRequest === null && selected !== undefined && activeTab === "raw" && (
          <MarkdownRecordContent
            record={selected}
            rendered={false}
            thinkingExpanded={thinkingExpanded}
            onThinkingExpandedChange={setThinkingExpanded}
          />
        )}
        {selectedRequest === null && selected !== undefined && activeTab === "input" && (
          <RecordPayload record={selected} direction="input" />
        )}
        {selectedRequest === null && selected !== undefined && activeTab === "output" && (
          <RecordPayload record={selected} direction="output" />
        )}
        {selectedRequest === null && selected !== undefined && activeTab === "timing" && (
          <RecordTiming record={selected} />
        )}
      </div>
    </aside>
  );
}

/** 请求耗时标签导出给行内使用(避免重复实现)。 */
export const formatRequestDuration = formatDurationMs;
