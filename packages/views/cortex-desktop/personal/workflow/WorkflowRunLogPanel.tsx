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
import type {
  WorkflowRun,
  WorkflowNodeRunResult,
  WorkflowNode,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 格式化毫秒为可读时长（对照 Kun fmtDuration）。 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

/** 节点运行状态 → 颜色 class（对照 Kun statusDotClass）。 */
export function statusDotClass(
  status: WorkflowNodeRunResult["status"],
): string {
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

type RunBadgeIcon = "check" | "x" | "spin" | "idle";

/** 运行整体状态 → badge 样式（背景 + ring 描边 + 图标 + 卡片描边）。 */
export function runStatusBadge(status: WorkflowRun["status"]): {
  cls: string;
  label: string;
  icon: RunBadgeIcon;
  /** 顶层卡片描边色，强化整体状态识别 */
  cardCls: string;
} {
  switch (status) {
    case "running":
      return {
        cls: "bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400",
        label: "运行中",
        icon: "spin",
        cardCls: "border-amber-500/30",
      };
    case "success":
      return {
        cls: "bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-400",
        label: "成功",
        icon: "check",
        cardCls: "border-emerald-500/25",
      };
    case "error":
      return {
        cls: "bg-red-500/10 text-red-600 ring-1 ring-inset ring-red-500/25 dark:text-red-400",
        label: "失败",
        icon: "x",
        cardCls: "border-red-500/30",
      };
    default:
      return {
        cls: "bg-ds-border/60 text-ds-faint ring-1 ring-inset ring-ds-border",
        label: "空闲",
        icon: "idle",
        cardCls: "border-ds-border",
      };
  }
}

/** badge 内的状态图标（与 runStatusBadge.icon 对应）。 */
export function RunBadgeGlyph({ icon }: { icon: RunBadgeIcon }) {
  switch (icon) {
    case "check":
      return <Icon.CheckCircle size={11} sw={2} className="shrink-0" />;
    case "x":
      return <Icon.XCircle size={11} sw={2} className="shrink-0" />;
    case "spin":
      return <Icon.Retry size={11} sw={2} className="shrink-0 animate-spin" />;
    default:
      return <Icon.Clock size={11} sw={2} className="shrink-0" />;
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
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${
          isError ? "text-red-500 dark:text-red-400" : "text-ds-faint"
        }`}
      >
        {isError ? (
          <Icon.XCircle size={11} sw={2} className="shrink-0" />
        ) : null}
        {label}
      </span>
      <pre
        className={`max-h-[120px] overflow-auto rounded-lg border p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all ${
          isError
            ? "border-red-500/20 bg-red-500/5 text-red-600 dark:border-red-500/25 dark:text-red-400"
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
      ? new Date(result.finishedAt).getTime() -
        new Date(result.startedAt).getTime()
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
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(result.status)}`}
        />

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
        {durationMs !== undefined &&
        !Number.isNaN(durationMs) &&
        durationMs >= 0 ? (
          <span className="shrink-0 text-[10.5px] text-ds-faint">
            {fmtDuration(durationMs)}
          </span>
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

  const isError = run.status === "error";

  return (
    <div className={`rounded-xl border bg-ds-card ${badge.cardCls}`}>
      {/* 运行头部 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-ds-hover rounded-xl"
      >
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${badge.cls}`}
        >
          <RunBadgeGlyph icon={badge.icon} />
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ds-muted">
          {startTime}
        </span>
        {durationMs !== undefined &&
        !Number.isNaN(durationMs) &&
        durationMs >= 0 ? (
          <span className="shrink-0 rounded bg-ds-main px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ds-faint">
            {fmtDuration(durationMs)}
          </span>
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
          {/* 运行级摘要：失败时高亮为错误条，否则普通说明 */}
          {run.message ? (
            <div
              className={`mb-0.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] leading-relaxed ${
                isError
                  ? "bg-red-500/5 text-red-600 dark:text-red-400"
                  : "bg-ds-main text-ds-faint"
              }`}
            >
              {isError ? (
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
              <RunLogRow
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
  /** 当前工作流 id */
  workflowId: string | undefined;
  /** 工作流所有节点（用于显示节点名称）*/
  allNodes: WorkflowNode[];
};

// ── WorkflowRunLogPanel ───────────────────────────────────────────────────────

export function WorkflowRunLogPanel({ workflowId, allNodes }: Props) {
  const { data: runs = [] } = useWorkflowRuns(workflowId);

  // 面板只展示最近一次运行；完整历史见顶栏「运行历史」弹窗（已持久化 workflow-runs/<id>.json）。
  const sortedRuns = [...runs]
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )
    .slice(0, 1);

  if (sortedRuns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ds-main">
          <Icon.Clock size={24} sw={1.5} className="text-ds-faint/50" />
        </div>
        <p className="text-[12.5px] font-medium text-ds-muted">暂无运行记录</p>
        <p className="text-[11px] text-ds-faint">
          点击「运行一次」触发首次执行
        </p>
      </div>
    );
  }

  // 最新一次运行仍在执行 → 头部显示旋转 icon 表示「运行中」。
  const latestRunning = sortedRuns[0]?.status === "running";

  return (
    <div className="flex flex-col gap-2">
      {/* 头部：运行中旋转 icon + 标题（仅最近一次运行，不保留历史）*/}
      <div className="flex items-center gap-1.5 px-0.5 pb-0.5">
        {latestRunning ? (
          <Icon.Retry
            size={13}
            sw={2}
            className="animate-spin text-amber-500"
          />
        ) : (
          <Icon.Clock size={13} sw={2} className="text-ds-faint" />
        )}
        <span className="text-[12.5px] font-semibold text-ds-ink">
          最近一次运行
        </span>
      </div>
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
