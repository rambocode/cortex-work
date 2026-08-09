// 运行过程详情弹层(参考 multica agent transcript dialog):展示当前会话累积的原始运行事件——
// 每条工具调用的名称/完整输入参数/输出内容(可展开),支持按工具名与事件类型多选筛选,
// 顶部统计栏(耗时/事件数/工具调用数/tokens/费用)。数据源是瞬态运行事件流
// (usePersonalRunEvents,不落盘),start/end 事件在本组件 useMemo 内按 toolCallId 配对。
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { cleanToolName, usePersonalRunEvents, usePersonalStore, type RunEvent } from "@cortex-work/core";
import { CopyButton } from "../shared/CopyButton";
import { useDismissableMenu } from "../shared/useDismissableMenu";

// 工具行:调用(call)与结果(result)**各自成行**(multica 风格)——调用行带 input,结果行带
// output/isError;靠 toolCallId 关联:结果行补名字(claude 的 end 帧无 name)、调用行翻 running。
interface ToolRow {
  kind: "tool";
  phase: "call" | "result";
  key: string;
  name: string;
  detail?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  ts: number;
  running?: boolean; // call 专用:尚无对应结果帧 → 运行中转圈
}
// 非工具行(重试/轮结果):在时间线上保留失败与重试的可见性。
interface MiscRow {
  kind: "retry" | "result";
  key: string;
  ts: number;
  text: string;
  isError?: boolean;
}
// 模型输出段(全链路):text=回复正文、thinking=思考过程。recordRunEvent 已按段合并增量。
interface SegRow {
  kind: "text" | "thinking";
  key: string;
  ts: number;
  content: string;
}
type Row = ToolRow | MiscRow | SegRow;

interface Stats {
  durationMs: number;
  live: boolean; // 会话仍在运行 → 耗时实时增长
  eventCount: number;
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  // 命中 prompt cache 的 input 子集(codex ws 等透传):缓存部分计费远低于原价,单独展示
  // 避免累计 input 数字让用户误判真实成本。
  cachedInputTokens: number;
  costUsd?: number;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function jsonPreview(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

// 事件流 → 行列表 + 统计。工具 start/end 按 toolCallId 配对(无 id 的 start 各自成行,end 丢配即
// 单独成行兜底);tokens 按「每个 runId 取最后一条 usage」再求和——claude/codex exec 一轮一条为精确值,
// codex ws 的 tokenUsage 是累计快照,取末条避免逐条累加的重复计数。
function buildRows(events: RunEvent[], running: boolean, fallbackToolName: string): { rows: Row[]; stats: Stats } {
  const rows: Row[] = [];
  const openByCallId = new Map<string, ToolRow>();
  const lastUsageByRun = new Map<string, { input: number; output: number; cached: number; cost?: number }>();
  let toolCount = 0;
  let seq = 0;

  for (const { runId, ts, ev } of events) {
    if (ev.type === "tool") {
      if (ev.phase !== "end") {
        toolCount += 1;
        const row: ToolRow = {
          kind: "tool",
          phase: "call",
          key: `t-${seq++}`,
          name: cleanToolName(ev.name) || fallbackToolName,
          detail: ev.detail,
          input: ev.input,
          ts,
          running: true,
        };
        rows.push(row);
        if (ev.toolCallId) openByCallId.set(ev.toolCallId, row);
      } else {
        // 结果帧独立成行(multica 风格);从对应调用行借名字(claude end 帧无 name)并翻掉 running。
        const open = ev.toolCallId ? openByCallId.get(ev.toolCallId) : undefined;
        if (open) {
          open.running = false;
          // 回填调用行的空 detail:webSearch 等工具 start 时查询词尚未生成,end 帧才带上,
          // 不回填则调用行永远是空摘要。
          if (!open.detail && ev.detail) open.detail = ev.detail;
          // 输入参数同理:end 帧带完成 item(查询词等已就绪)时覆盖 started 的早期快照,
          // 避免展开后仍看到 query:"" 之类的占位。
          if (ev.input !== undefined) open.input = ev.input;
          if (ev.toolCallId) openByCallId.delete(ev.toolCallId);
        }
        rows.push({
          kind: "tool",
          phase: "result",
          key: `t-${seq++}`,
          name: cleanToolName(ev.name) || open?.name || fallbackToolName,
          detail: ev.detail,
          output: ev.output,
          isError: ev.isError,
          ts,
        });
      }
    } else if (ev.type === "text" || ev.type === "thinking") {
      rows.push({ kind: ev.type, key: `g-${seq++}`, ts, content: ev.delta });
    } else if (ev.type === "retry") {
      rows.push({ kind: "retry", key: `r-${seq++}`, ts, text: ev.reason ?? "", isError: false });
    } else if (ev.type === "result") {
      rows.push({ kind: "result", key: `s-${seq++}`, ts, text: ev.error ?? "", isError: !ev.ok });
    } else if (ev.type === "usage") {
      const prev = lastUsageByRun.get(runId);
      lastUsageByRun.set(runId, {
        input: ev.inputTokens ?? prev?.input ?? 0,
        output: ev.outputTokens ?? prev?.output ?? 0,
        cached: ev.cachedInputTokens ?? prev?.cached ?? 0,
        cost: ev.costUsd ?? prev?.cost,
      });
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd: number | undefined;
  for (const u of lastUsageByRun.values()) {
    inputTokens += u.input;
    outputTokens += u.output;
    cachedInputTokens += u.cached;
    if (u.cost !== undefined) costUsd = (costUsd ?? 0) + u.cost;
  }

  // 耗时按**最近一轮**(末条事件的 runId)计:事件按会话跨轮累积,首末事件差是「会话时间跨度」
  // 而非执行耗时。无事件时恒为 0(不能用 0 当起点 —— Date.now()-0 会显示成天文数字)。
  const lastRunId = events.length > 0 ? events[events.length - 1]!.runId : undefined;
  const lastRunEvents = lastRunId === undefined ? [] : events.filter((e) => e.runId === lastRunId);
  const first = lastRunEvents[0]?.ts;
  const last = lastRunEvents.length > 0 ? lastRunEvents[lastRunEvents.length - 1]!.ts : undefined;
  return {
    rows,
    stats: {
      durationMs: first === undefined ? 0 : running ? Date.now() - first : (last ?? first) - first,
      live: running && first !== undefined,
      eventCount: events.length,
      toolCount,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      costUsd,
    },
  };
}

const rowFilterKey = (row: Row): string => (row.kind === "tool" ? `tool:${row.name}` : `type:${row.kind}`);

// 工具行状态:调用行无对应结果帧 = 运行中;结果行 isError = 失败。(独立函数,避免 JSX 内三元触发 i18n lint 误报)
function toolRowStatus(row: ToolRow): "running" | "failed" | "done" {
  if (row.phase === "call") return row.running ? "running" : "done";
  return row.isError ? "failed" : "done";
}

export function AgentTranscriptDialog({
  open,
  onClose,
  sessionId,
  subagentCallId,
  subagentLabel,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** 传入后只展示某一次委派调用，避免同角色重复调用或主 Agent 事件混入。 */
  subagentCallId?: string;
  subagentLabel?: string;
}) {
  const { t } = useTranslation("chat");
  const allEvents = usePersonalRunEvents(open ? sessionId : undefined);
  const events = useMemo(
    () => subagentCallId ? allEvents.filter(({ ev }) => ev.subagentCallId === subagentCallId) : allEvents,
    [allEvents, subagentCallId],
  );
  const sessionRunning = usePersonalStore((s) => !!s.runningBySession[sessionId]);
  // 主 Agent 可能仍在整理最终答案，但已结束的子代理不应继续显示 live；作用域详情只看自身终态帧。
  const running = sessionRunning && (!subagentCallId || !events.some(({ ev }) => ev.type === "result"));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const filterMenu = useDismissableMenu();
  // 运行中时每秒重算耗时(仅弹层打开期间挂 interval)。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open || !running) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [open, running]);
  // 打开时重置筛选与展开态(会话切换后不残留)。
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setExpanded(new Set());
  }, [open, sessionId, subagentCallId]);

  const { rows, stats } = useMemo(
    () => buildRows(events, running, t("transcript.toolFallback")),
    [events, running, t],
  );

  // 筛选选项从已有行派生:工具名一项一选,retry/result 各一项。空选集 = 全部显示。
  const filterOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) keys.add(rowFilterKey(row));
    return [...keys].sort();
  }, [rows]);

  const visibleRows = useMemo(
    () => (selected.size === 0 ? rows : rows.filter((row) => selected.has(rowFilterKey(row)))),
    [rows, selected],
  );

  if (!open) return null;

  const toggleKey = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const optionLabel = (key: string): string => {
    if (key === "type:retry") return t("transcript.typeRetry");
    if (key === "type:result") return t("transcript.typeResult");
    if (key === "type:text") return t("transcript.typeText");
    if (key === "type:thinking") return t("transcript.typeThinking");
    return key.slice("tool:".length);
  };

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
      <div
        className="pw-dlg pw-transcript-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={subagentLabel ? t("transcript.subagentAria", { label: subagentLabel }) : t("transcript.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="pw-transcript-head">
          <span className="pw-transcript-title">
            {subagentLabel ? t("transcript.subagentTitle", { label: subagentLabel }) : t("transcript.title")}
          </span>
          {/* 筛选下拉:多选 checkbox,选项从事件派生。挂 useDismissableMenu 的点外/Esc 关闭范式。 */}
          <div className="pw-transcript-filter" ref={filterMenu.wrapRef}>
            <button
              type="button"
              className={`pw-tl-gen ${selected.size > 0 ? "is-active" : ""}`}
              onClick={() => filterMenu.setOpen((v) => !v)}
              aria-expanded={filterMenu.open}
            >
              <Icon.Filter size={13} />
              {t("transcript.filter")}
              {selected.size > 0 ? ` · ${selected.size}` : ""}
            </button>
            {filterMenu.open ? (
              <div className="pw-transcript-filter-menu">
                {filterOptions.map((key) => (
                  <label key={key} className="pw-transcript-filter-item">
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => setSelected((cur) => toggleKey(cur, key))}
                    />
                    <span>{optionLabel(key)}</span>
                  </label>
                ))}
                {selected.size > 0 ? (
                  <button
                    type="button"
                    className="pw-transcript-filter-clear"
                    onClick={() => setSelected(new Set())}
                  >
                    {t("transcript.filterClear")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <button type="button" className="pw-icon-btn" title={t("transcript.close")} onClick={onClose}>
            <Icon.X size={15} />
          </button>
        </div>

        {/* 统计栏:耗时(运行中实时)/事件数/工具调用数/tokens/费用(无 cost 数据时隐藏)。 */}
        <div className="pw-transcript-stats">
          <span className="pw-transcript-stat">
            <Icon.Clock size={12} />
            {t("transcript.statDuration")} {fmtDuration(stats.durationMs)}
            {stats.live ? <span className="pw-transcript-live" /> : null}
          </span>
          <span className="pw-transcript-stat">
            {t("transcript.statEvents")} {stats.eventCount}
          </span>
          <span className="pw-transcript-stat">
            {t("transcript.statTools")} {stats.toolCount}
          </span>
          {stats.inputTokens > 0 || stats.outputTokens > 0 ? (
            <span className="pw-transcript-stat">
              {t("transcript.statTokens")} ↑{stats.inputTokens.toLocaleString()}
              {/* 缓存命中的 input 子集单独标注:codex 多轮工具往返会重传整段上下文,累计 input
                  看起来很大,但缓存部分计费约为原价 1/10,不标注会让用户高估成本。 */}
              {stats.cachedInputTokens > 0
                ? `（${t("transcript.statTokensCached", { tokens: stats.cachedInputTokens.toLocaleString() })}）`
                : ""}{" "}
              ↓{stats.outputTokens.toLocaleString()}
            </span>
          ) : null}
          {stats.costUsd !== undefined ? (
            <span className="pw-transcript-stat">
              {t("transcript.statCost")} ${stats.costUsd.toFixed(4)}
            </span>
          ) : null}
        </div>

        <div className="pw-transcript-list">
          {visibleRows.length === 0 ? (
            <div className="pw-transcript-empty">
              {rows.length === 0 ? t("transcript.empty") : t("transcript.filterEmpty")}
            </div>
          ) : (
            visibleRows.map((row) => {
              if (row.kind === "retry" || row.kind === "result") {
                return (
                  <div key={row.key} className={`pw-transcript-row is-misc ${row.isError ? "is-error" : ""}`}>
                    <span className="pw-transcript-time">{fmtTime(row.ts)}</span>
                    <span className="pw-transcript-badge" data-kind={row.kind}>
                      {row.kind === "retry" ? t("transcript.typeRetry") : t("transcript.typeResult")}
                    </span>
                    <span className="pw-transcript-summary">
                      {row.kind === "result"
                        ? row.isError
                          ? `${t("transcript.resultFail")}${row.text ? ` · ${row.text}` : ""}`
                          : t("transcript.resultOk")
                        : row.text}
                    </span>
                  </div>
                );
              }
              // 模型输出段(text/thinking):摘要行可展开看全文。
              if (row.kind === "text" || row.kind === "thinking") {
                const isOpen = expanded.has(row.key);
                return (
                  <div key={row.key} className={`pw-transcript-row is-seg ${isOpen ? "is-open" : ""}`}>
                    <button
                      type="button"
                      className="pw-transcript-row-main"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded((cur) => toggleKey(cur, row.key))}
                    >
                      <span className="pw-transcript-time">{fmtTime(row.ts)}</span>
                      <span className="pw-transcript-badge" data-kind={row.kind}>
                        {row.kind === "text" ? t("transcript.typeText") : t("transcript.typeThinking")}
                      </span>
                      <span className="pw-transcript-summary">{row.content.split("\n")[0]}</span>
                      <span className={`pw-transcript-chev ${isOpen ? "is-open" : ""}`}>
                        <Icon.Chevron size={13} />
                      </span>
                    </button>
                    {isOpen ? (
                      <div className="pw-transcript-detail">
                        <div className="pw-transcript-block">
                          <div className="pw-transcript-block-h">
                            <span>{row.kind === "text" ? t("transcript.typeText") : t("transcript.typeThinking")}</span>
                            <CopyButton text={row.content} size={13} />
                          </div>
                          <pre>{row.content}</pre>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              }
              if (row.kind !== "tool") return null; // 穷尽守卫(上面已处理全部非 tool 行)
              // 工具调用/结果各自成行(multica 风格):调用行蓝系徽章 + 参数摘要,展开看完整 input;
              // 结果行灰系徽章 + 输出首行,展开看灰色输出正文。
              const isOpen = expanded.has(row.key);
              const status = toolRowStatus(row);
              const isResult = row.phase === "result";
              return (
                <div
                  key={row.key}
                  className={`pw-transcript-row is-tool ${isResult ? "is-tool-result" : "is-tool-call"} ${isOpen ? "is-open" : ""}`}
                >
                  <button
                    type="button"
                    className="pw-transcript-row-main"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded((cur) => toggleKey(cur, row.key))}
                  >
                    <span className="pw-transcript-time">{fmtTime(row.ts)}</span>
                    <span className="pw-transcript-badge" data-kind={isResult ? "tool-result" : "tool"}>
                      {row.name}
                    </span>
                    <span className="pw-transcript-summary">
                      {/* 结果行无输出正文时退回 detail(如 webSearch 完成帧只带查询词无输出),
                          仍无才显示「无输出」占位。 */}
                      {isResult
                        ? (row.output?.split("\n")[0] ?? row.detail ?? t("transcript.noOutput"))
                        : (row.detail ?? "")}
                    </span>
                    {/* 状态位:调用行运行中转圈;结果行失败红叉。其余留空,减少视觉噪音。 */}
                    {status === "running" ? (
                      <span className="pw-transcript-status" data-status="running">
                        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                      </span>
                    ) : status === "failed" ? (
                      <span className="pw-transcript-status" data-status="failed">
                        <Icon.XCircle size={13} />
                      </span>
                    ) : null}
                    <span className={`pw-transcript-chev ${isOpen ? "is-open" : ""}`}>
                      <Icon.Chevron size={13} />
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="pw-transcript-detail">
                      {isResult ? (
                        <div className="pw-transcript-block is-output">
                          <div className="pw-transcript-block-h">
                            <span>{t("transcript.output")}</span>
                            {row.output ? <CopyButton text={row.output} size={13} /> : null}
                          </div>
                          {row.output ? (
                            <pre>{row.output}</pre>
                          ) : (
                            <div className="pw-transcript-noout">{t("transcript.noOutput")}</div>
                          )}
                        </div>
                      ) : (
                        <div className="pw-transcript-block">
                          <div className="pw-transcript-block-h">
                            <span>{t("transcript.input")}</span>
                            {row.input !== undefined ? <CopyButton text={jsonPreview(row.input)} size={13} /> : null}
                          </div>
                          {/* 缺参数时的占位文案用 noInput 而非 noOutput:这里是输入参数块,
                              显示「无输出内容」会让用户误以为是工具没返回结果(实测被误读过)。 */}
                          {row.input !== undefined ? (
                            <pre>{jsonPreview(row.input)}</pre>
                          ) : (
                            <div className="pw-transcript-noout">{row.detail ?? t("transcript.noInput")}</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
