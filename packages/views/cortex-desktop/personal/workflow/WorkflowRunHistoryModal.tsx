// WorkflowRunHistoryModal.tsx — 运行历史弹窗（顶栏历史图标触发）。
// 展示该工作流全部运行记录（最新在前），支持按状态/触发/时间/消息/节点检索；
// 每条运行可展开查看各节点执行结果。
//
// ⚠️ 行容器用 <div role="button"> 而非 <button>：cortex-desktop.css 的全局未分层
//    `button{padding:0;...}` reset 会吃掉 Tailwind 内边距，div 不受影响。

import { useMemo, useState } from "react";
import type {
  WorkflowRun,
  WorkflowNode,
  WorkflowNodeRunResult,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import {
  fmtDuration,
  runStatusBadge,
  RunBadgeGlyph,
  statusDotClass,
} from "./WorkflowRunLogPanel";

// ── 工具 ──────────────────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<string, string> = {
  manual: "手动",
  schedule: "定时",
  webhook: "Webhook",
};

const STATUS_SEARCH: Record<string, string> = {
  success: "成功 success",
  error: "失败 error",
  running: "运行中 running",
  idle: "空闲 idle",
};

/** 运行开始时间：当天「今天 HH:MM:SS」，否则「MM-DD HH:MM」。 */
function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) {
    return `今天 ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 拼出一条运行可被检索的全文（状态/触发/时间/消息 + 各节点名与结果）。 */
function runSearchText(run: WorkflowRun, allNodes: WorkflowNode[]): string {
  const statusLabel = STATUS_SEARCH[run.status] ?? run.status;
  const nodeText = run.nodeResults
    .map((r) => {
      const n = allNodes.find((x) => x.id === r.nodeId);
      return `${n?.name ?? ""} ${n?.type ?? ""} ${r.status} ${r.message ?? ""} ${r.error ?? ""}`;
    })
    .join(" ");
  return `${statusLabel} ${run.trigger ?? ""} ${fmtTime(run.startedAt)} ${run.startedAt ?? ""} ${run.message ?? ""} ${nodeText}`.toLowerCase();
}

function durationOf(run: {
  startedAt?: string;
  finishedAt?: string;
}): number | undefined {
  if (!run.startedAt || !run.finishedAt) return undefined;
  const ms =
    new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isNaN(ms) || ms < 0 ? undefined : ms;
}

// ── 节点结果行 ────────────────────────────────────────────────────────────────

function NodeResultRow({
  result,
  nodeName,
}: {
  result: WorkflowNodeRunResult;
  nodeName: string;
}) {
  const dur = durationOf(result);
  return (
    <div className="rounded-lg border border-ds-border bg-ds-card/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(result.status)}`}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ds-ink">
          {nodeName}
        </span>
        {dur !== undefined ? (
          <span className="shrink-0 text-[10.5px] text-ds-faint">
            {fmtDuration(dur)}
          </span>
        ) : null}
      </div>
      {result.error ? (
        <pre className="mt-1.5 max-h-[100px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-red-500/20 bg-red-500/5 p-2 font-mono text-[11px] leading-relaxed text-red-600 dark:text-red-400">
          {result.error}
        </pre>
      ) : result.message ? (
        <p className="mt-1 break-words text-[11.5px] leading-relaxed text-ds-faint">
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

// ── 运行行 ────────────────────────────────────────────────────────────────────

function HistoryRunRow({
  run,
  allNodes,
  defaultOpen,
}: {
  run: WorkflowRun;
  allNodes: WorkflowNode[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const badge = runStatusBadge(run.status);
  const dur = durationOf(run);
  const trigger = TRIGGER_LABELS[run.trigger] ?? run.trigger;

  const sortedResults = [...run.nodeResults].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  const nodeName = (nodeId: string) => {
    const n = allNodes.find((x) => x.id === nodeId);
    return n?.name || n?.type || nodeId;
  };

  return (
    <div className={`rounded-xl border bg-ds-card ${badge.cardCls}`}>
      {/* 行头（div 充当按钮，规避全局 button reset）*/}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 transition hover:bg-ds-hover"
      >
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${badge.cls}`}
        >
          <RunBadgeGlyph icon={badge.icon} />
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ds-muted">
          {fmtTime(run.startedAt)}
        </span>
        {trigger ? (
          <span className="shrink-0 rounded bg-ds-main px-1.5 py-0.5 text-[10px] font-medium text-ds-faint">
            {trigger}
          </span>
        ) : null}
        {dur !== undefined ? (
          <span className="shrink-0 rounded bg-ds-main px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ds-faint">
            {fmtDuration(dur)}
          </span>
        ) : null}
        <Icon.ChevronRight
          size={12}
          sw={2}
          className={`shrink-0 text-ds-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
      </div>

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-ds-border p-2.5">
          {run.message ? (
            <div
              className={`flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] leading-relaxed ${
                run.status === "error"
                  ? "bg-red-500/5 text-red-600 dark:text-red-400"
                  : "bg-ds-main text-ds-faint"
              }`}
            >
              {run.status === "error" ? (
                <Icon.XCircle size={13} sw={2} className="mt-px shrink-0" />
              ) : (
                <Icon.Info size={13} sw={2} className="mt-px shrink-0" />
              )}
              <span className="min-w-0 break-words">{run.message}</span>
            </div>
          ) : null}
          {sortedResults.length === 0 ? (
            <p className="py-2 text-center text-[11.5px] text-ds-faint">
              暂无节点执行记录
            </p>
          ) : (
            sortedResults.map((r) => (
              <NodeResultRow
                key={r.nodeId}
                result={r}
                nodeName={nodeName(r.nodeId)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  /** 该工作流的全部运行记录（最新在前由本组件排序）。 */
  runs: WorkflowRun[];
  /** 工作流所有节点（解析节点名）。 */
  allNodes: WorkflowNode[];
  /** 关闭弹窗。 */
  onClose: () => void;
};

// ── WorkflowRunHistoryModal ───────────────────────────────────────────────────

export function WorkflowRunHistoryModal({ runs, allNodes, onClose }: Props) {
  const [query, setQuery] = useState("");

  const sorted = useMemo(
    () =>
      [...runs].sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      ),
    [runs],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q ? sorted.filter((r) => runSearchText(r, allNodes).includes(q)) : sorted,
    [q, sorted, allNodes],
  );

  return (
    <div
      className="ds-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-[640px] flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <header className="flex items-center justify-between border-b border-ds-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Icon.Clock size={17} sw={1.8} className="text-ds-muted" />
            <span className="text-[14px] font-semibold text-ds-ink">
              运行历史
            </span>
            <span className="rounded-full bg-ds-border/60 px-2 py-0.5 text-[11px] font-medium text-ds-faint">
              {sorted.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <Icon.X size={16} sw={1.8} />
          </button>
        </header>

        {/* 搜索 */}
        <div className="shrink-0 px-5 pb-3 pt-3">
          <div className="flex h-9 items-center gap-2 rounded-xl border border-ds-border bg-ds-main px-3 text-ds-faint transition focus-within:border-accent">
            <Icon.Search size={15} sw={1.9} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索运行记录（状态 / 触发 / 时间 / 节点 / 消息）…"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ds-ink outline-none placeholder:text-ds-faint"
            />
          </div>
        </div>

        {/* 列表 */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 pb-5">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ds-main">
                <Icon.Clock size={24} sw={1.5} className="text-ds-faint/50" />
              </div>
              <p className="text-[12.5px] font-medium text-ds-muted">
                暂无运行记录
              </p>
              <p className="text-[11px] text-ds-faint">
                点击「运行一次」触发首次执行
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-12 text-center text-[12.5px] text-ds-faint">
              没有匹配「{query}」的运行记录
            </p>
          ) : (
            filtered.map((run, idx) => (
              <HistoryRunRow
                key={run.id}
                run={run}
                allNodes={allNodes}
                defaultOpen={idx === 0 && !q}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
