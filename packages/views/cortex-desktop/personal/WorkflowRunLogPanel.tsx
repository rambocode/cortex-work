// WorkflowRunLogPanel.tsx — 工作流运行日志面板。
// 对照 Kun WorkflowRunLogPanel（155 行），展示最近一次运行的各节点执行结果。
// 数据来源：useWorkflowRuns(workflowId) — React Query 缓存，由 onWorkflowRunEvent 驱动实时更新。
//
// 渲染结构：
//   - 运行列表（最新在前，最多展示 20 条）
//   - 每条运行展开 → 各节点结果行（RunLogRow）
//   - 节点行可展开：input/output/error/message/threadId

import { useState } from "react";
import { useWorkflowRuns } from "@cortex-work/core";
import type { WorkflowRun, WorkflowNodeRunResult, WorkflowNode } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 格式化毫秒为可读时长（对照 Kun fmtDuration）。 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

/** 节点运行状态 → 颜色 class（对照 Kun statusDotClass）。 */
function statusDotClass(status: WorkflowNodeRunResult["status"]): string {
  switch (status) {
    case "running":
      return "bg-amber-500 animate-pulse";
    case "success":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    case "skipped":
      return "border border-ds-border bg-transparent";
    default:
      return "bg-ds-border";
  }
}

/** 运行整体状态 → badge class。 */
function runStatusBadge(status: WorkflowRun["status"]): { cls: string; label: string } {
  switch (status) {
    case "running":
      return { cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400", label: "运行中" };
    case "success":
      return { cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", label: "成功" };
    case "error":
      return { cls: "bg-red-500/15 text-red-600 dark:text-red-400", label: "失败" };
    default:
      return { cls: "bg-ds-border/60 text-ds-faint", label: "空闲" };
  }
}

// ── LogBlock ──────────────────────────────────────────────────────────────────

function LogBlock({
  label,
  content,
  isError,
}: {
  label: string;
  content: string;
  isError?: boolean;
}) {
  if (!content) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ds-faint">
        {label}
      </span>
      <pre
        className={`max-h-[120px] overflow-auto rounded-lg border p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all ${
          isError
            ? "border-red-200 bg-red-500/5 text-red-600 dark:border-red-900 dark:text-red-400"
            : "border-ds-border bg-ds-main text-ds-ink"
        }`}
      >
        {content}
      </pre>
    </div>
  );
}

// ── RunLogRow ─────────────────────────────────────────────────────────────────

function RunLogRow({
  result,
  nodeName,
}: {
  result: WorkflowNodeRunResult;
  /** 节点名称（从 allNodes 查）*/
  nodeName: string;
}) {
  // 运行中或出错时默认展开
  const defaultOpen = result.status === "running" || result.status === "error";
  const [open, setOpen] = useState(defaultOpen);

  const durationMs =
    result.startedAt && result.finishedAt
      ? new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()
      : undefined;

  return (
    <div className="rounded-xl border border-ds-border bg-ds-card/60">
      {/* 行头 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-2.5 text-left transition hover:bg-ds-hover rounded-xl"
      >
        {/* 状态点 */}
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(result.status)}`} />

        {/* 节点名称 */}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ds-ink">
          {nodeName}
        </span>

        {/* 重试 badge */}
        {(result.retries ?? 0) > 0 ? (
          <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-600">
            ×{result.retries} 重试
          </span>
        ) : null}

        {/* 时长 */}
        {durationMs !== undefined && !Number.isNaN(durationMs) && durationMs >= 0 ? (
          <span className="shrink-0 text-[10.5px] text-ds-faint">{fmtDuration(durationMs)}</span>
        ) : null}

        <Icon.ChevronRight
          size={12}
          sw={2}
          className={`shrink-0 text-ds-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {/* 展开详情 */}
      {open ? (
        <div className="flex flex-col gap-2 border-t border-ds-border p-2.5">
          {result.status === "running" ? (
            <p className="text-[12px] text-ds-faint animate-pulse">执行中…</p>
          ) : null}
          <LogBlock label="错误" content={result.error} isError />
          <LogBlock label="消息" content={result.message} />
          {/* threadId 仅 ai-agent 节点有意义 */}
          {result.threadId ? (
            <div className="text-[10.5px] text-ds-faint font-mono">
              会话 ID: {result.threadId}
            </div>
          ) : null}
          <LogBlock label="输入 (JSON)" content={result.inputJson ?? ""} />
          <LogBlock label="输出 (JSON)" content={result.outputJson} />
        </div>
      ) : null}
    </div>
  );
}

// ── RunEntry ──────────────────────────────────────────────────────────────────

function RunEntry({
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

  const durationMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : undefined;

  const startTime = run.startedAt
    ? new Date(run.startedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";

  // 按 startedAt 排序节点结果（早开始 → 晚开始）
  const sortedResults = [...run.nodeResults].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  function nodeName(nodeId: string): string {
    const n = allNodes.find((x) => x.id === nodeId);
    return n?.name || n?.type || nodeId;
  }

  return (
    <div className="rounded-xl border border-ds-border bg-ds-card">
      {/* 运行头部 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-ds-hover rounded-xl"
      >
        <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${badge.cls}`}>
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ds-muted">{startTime}</span>
        {durationMs !== undefined && !Number.isNaN(durationMs) && durationMs >= 0 ? (
          <span className="shrink-0 text-[10.5px] text-ds-faint">{fmtDuration(durationMs)}</span>
        ) : null}
        <Icon.ChevronRight
          size={12}
          sw={2}
          className={`shrink-0 text-ds-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {/* 节点结果列表 */}
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-ds-border p-2.5">
          {run.message ? (
            <p className="mb-1 text-[11.5px] text-ds-faint">{run.message}</p>
          ) : null}
          {sortedResults.length === 0 ? (
            <p className="py-2 text-center text-[11.5px] text-ds-faint">暂无节点执行记录</p>
          ) : (
            sortedResults.map((r) => (
              <RunLogRow key={r.nodeId} result={r} nodeName={nodeName(r.nodeId)} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  /** 当前工作流 id */
  workflowId: string | undefined;
  /** 工作流所有节点（用于显示节点名称）*/
  allNodes: WorkflowNode[];
};

// ── WorkflowRunLogPanel ───────────────────────────────────────────────────────

export function WorkflowRunLogPanel({ workflowId, allNodes }: Props) {
  const { data: runs = [] } = useWorkflowRuns(workflowId);

  // 最新在前（最多 20 条）
  const sortedRuns = [...runs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 20);

  if (sortedRuns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <Icon.Clock size={32} sw={1.4} className="text-ds-faint/40" />
        <p className="text-[12.5px] text-ds-faint">暂无运行记录</p>
        <p className="text-[11px] text-ds-faint">点击「运行一次」触发首次执行</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sortedRuns.map((run, idx) => (
        <RunEntry
          key={run.id}
          run={run}
          allNodes={allNodes}
          defaultOpen={idx === 0}
        />
      ))}
    </div>
  );
}
