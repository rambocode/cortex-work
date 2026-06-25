// 工作流（loop）列表页（按设计稿 Workflow List 重构）：
// - 顶部列表头：标题 + 计数 pill + 运行全部 / 导入 / 新建工作流。
// - 工具栏：搜索框 + 状态过滤 tab（全部/运行中/已启用/已暂停/失败，带计数）+ 排序切换。
// - 列表行：名称 + 状态徽章、节点数·上次运行、触发器 chip + 最近结果摘要，
//   右侧操作簇（运行一次 / AI 可调用 toggle / 更多菜单）+ AI 调用状态标签。
// 启用·暂停收进「更多」菜单（设计稿行内只保留运行与 AI 两个常驻按钮）。
// Web 端（bridge.workflowList 不存在）：此组件不会被渲染（PersonalSidebar 已门控）。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useWorkflows,
  useDeleteWorkflow,
  useRunWorkflowNow,
  useSetWorkflowEnabled,
  useSetWorkflowCallableByAgent,
} from "@cortex-work/core";
import type { WorkflowDef } from "@cortex-work/core";
import {
  formatNodeCount,
  formatRelativeTime,
  formatRunResultSummary,
  formatTriggerChip,
} from "./workflowFormat";

// ── 行内更多操作菜单（编辑/启用·暂停/导出/删除）──────────────────────────────

function RowMenu({
  workflow,
  anchor,
  onClose,
  onEdit,
  onExport,
  onToggleEnabled,
  onToast,
}: {
  workflow: WorkflowDef;
  anchor: { x: number; y: number };
  onClose: () => void;
  onEdit: (wf: WorkflowDef) => void;
  onExport: (wf: WorkflowDef) => void;
  onToggleEnabled: (wf: WorkflowDef) => void;
  onToast: (text: string) => void;
}) {
  const del = useDeleteWorkflow();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  const [confirming, setConfirming] = useState(false);

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8)),
    });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const doDelete = () => {
    del.mutate(workflow.id, {
      onSuccess: () => onToast(`已删除「${workflow.name || "未命名 loop"}」`),
      onError: (e) => onToast(`删除失败：${e instanceof Error ? e.message : String(e)}`),
    });
    onClose();
  };

  return (
    <div ref={ref} className="pw-ctx-menu" style={pos} role="menu" aria-label={`${workflow.name} 操作`}>
      <button
        className="pw-tb-menu-item"
        role="menuitem"
        onClick={() => {
          onEdit(workflow);
          onClose();
        }}
      >
        <Icon.Edit size={13} />
        <span>编辑</span>
      </button>
      <button
        className="pw-tb-menu-item"
        role="menuitem"
        onClick={() => {
          onToggleEnabled(workflow);
          onClose();
        }}
      >
        {workflow.enabled ? <Icon.Stop size={13} /> : <Icon.Run size={13} />}
        <span>{workflow.enabled ? "暂停" : "启用"}</span>
      </button>
      <button
        className="pw-tb-menu-item"
        role="menuitem"
        onClick={() => {
          onExport(workflow);
          onClose();
        }}
      >
        <Icon.Download size={13} />
        <span>导出</span>
      </button>
      <div className="pw-tb-menu-sep" />
      <button
        className="pw-tb-menu-item is-danger"
        role="menuitem"
        onClick={confirming ? doDelete : () => setConfirming(true)}
      >
        <Icon.X size={13} />
        <span>{confirming ? "确认删除？" : "删除"}</span>
      </button>
    </div>
  );
}

// ── 状态过滤 tab 定义 ─────────────────────────────────────────────────────────

type FilterKey = "all" | "run" | "on" | "paused" | "fail";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "run", label: "运行中" },
  { key: "on", label: "已启用" },
  { key: "paused", label: "已暂停" },
  { key: "fail", label: "失败" },
];

// 单条工作流在各过滤类目下的归属（类目可重叠，如「已暂停 + 失败」）。
function matchFilter(wf: WorkflowDef, key: FilterKey): boolean {
  switch (key) {
    case "all":
      return true;
    case "run":
      return wf.lastStatus === "running";
    case "on":
      return wf.enabled && wf.lastStatus !== "running";
    case "paused":
      return !wf.enabled;
    case "fail":
      return wf.lastStatus === "error";
  }
}

type SortKey = "recent" | "name";

// ── 单行 ─────────────────────────────────────────────────────────────────────

function WorkflowRow({
  wf,
  onEdit,
  onRun,
  onToggleCallable,
  onOpenMenu,
}: {
  wf: WorkflowDef;
  onEdit: (wf: WorkflowDef) => void;
  onRun: (wf: WorkflowDef) => void;
  onToggleCallable: (wf: WorkflowDef) => void;
  onOpenMenu: (wf: WorkflowDef, anchor: { x: number; y: number }) => void;
}) {
  const running = wf.lastStatus === "running";
  const isError = wf.lastStatus === "error";
  const lastRunText = formatRelativeTime(wf.lastRunAt || null);
  const resultText = formatRunResultSummary(wf.lastMessage);
  const nodeCount = formatNodeCount(wf.nodes?.length ?? 0);
  const chip = formatTriggerChip(wf.nodes);
  const callOn = wf.callableByAgent && wf.enabled;

  return (
    <div
      className="pw-wfl-row"
      role="button"
      tabIndex={0}
      onClick={() => onEdit(wf)}
      onKeyDown={(e) => e.key === "Enter" && onEdit(wf)}
    >
      {/* 主信息区 */}
      <div className="pw-wfl-main">
        <div className="pw-wfl-line1">
          <span className="pw-wfl-name">{wf.name || "未命名 loop"}</span>
          {/* 状态徽章：运行中 / 已暂停 / 已启用 / 失败（可叠加） */}
          {running ? (
            <span className="pw-wfl-badge run">
              <span className="dot" />
              运行中
            </span>
          ) : (
            <>
              {!wf.enabled ? <span className="pw-wfl-badge paused">已暂停</span> : null}
              {wf.enabled && !isError ? (
                <span className="pw-wfl-badge on">
                  <span className="dot" />
                  已启用
                </span>
              ) : null}
              {isError ? <span className="pw-wfl-badge fail">失败</span> : null}
            </>
          )}
        </div>
        <div className="pw-wfl-meta">
          <span className="m">
            <Icon.Workflow size={13} />
            {nodeCount}
          </span>
          <span className="sep">·</span>
          <span className="m">
            <Icon.Clock size={13} />
            上次运行 {lastRunText}
          </span>
        </div>
        {resultText ? (
          <div className={`pw-wfl-preview ${isError ? "err" : ""}`}>
            {chip ? <span className="pw-wfl-chip">{chip}</span> : null}
            <span className="pw-wfl-preview-text">{resultText}</span>
          </div>
        ) : null}
      </div>

      {/* 右侧操作簇（点击不进编辑器）*/}
      <div className="pw-wfl-right" onClick={(e) => e.stopPropagation()}>
        <div className="pw-wfl-acts">
          <button
            className="pw-wfl-act run"
            title="运行一次"
            onClick={(e) => {
              e.stopPropagation();
              onRun(wf);
            }}
          >
            <Icon.Run size={14} />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={wf.callableByAgent}
            aria-label="AI 可调用"
            // 未启用时 AI 可调用无意义，禁用
            disabled={!wf.enabled}
            title={wf.enabled ? "允许 AI Agent 经 MCP 调用此 loop" : "需先启用才可开放 AI 调用"}
            className={`pw-wfl-act ai ${callOn ? "is-on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCallable(wf);
            }}
          >
            <Icon.Bot size={15} />
          </button>
          <button
            className="pw-wfl-act"
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenMenu(wf, { x: r.left, y: r.bottom + 4 });
            }}
          >
            <Icon.More size={14} />
          </button>
        </div>
        <span className={`pw-wfl-ai-lbl ${callOn ? "is-on" : ""}`}>
          {callOn ? <span className="dot" /> : null}
          {callOn ? "已开放 AI 调用" : "未开放调用"}
        </span>
      </div>
    </div>
  );
}

// ── 主列表组件 ───────────────────────────────────────────────────────────────

export function WorkflowList({
  onEdit,
  onCreate,
  onExport,
  onImport,
  onToast,
}: {
  /** 点编辑 → 传 WorkflowDef，由 WorkflowView 切换到编辑器。 */
  onEdit: (wf: WorkflowDef) => void;
  onCreate: () => void;
  onExport: (wf: WorkflowDef) => void;
  /** 导入回调（U15 接线后由 WorkflowView 触发文件选择）。 */
  onImport?: () => void;
  onToast: (text: string) => void;
}) {
  const { data: workflows = [] } = useWorkflows();
  const setEnabled = useSetWorkflowEnabled();
  const setCallable = useSetWorkflowCallableByAgent();
  const runNow = useRunWorkflowNow();
  const [menu, setMenu] = useState<{ workflow: WorkflowDef; anchor: { x: number; y: number } } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("recent");

  // 各 tab 计数（基于全量，不受搜索/当前 tab 影响）。
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, run: 0, on: 0, paused: 0, fail: 0 };
    for (const wf of workflows) {
      for (const f of FILTERS) if (matchFilter(wf, f.key)) c[f.key] += 1;
    }
    return c;
  }, [workflows]);

  // 过滤（tab + 搜索）→ 排序。
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = workflows.filter((wf) => {
      if (!matchFilter(wf, filter)) return false;
      if (!q) return true;
      return (
        (wf.name || "").toLowerCase().includes(q) ||
        (wf.lastMessage || "").toLowerCase().includes(q)
      );
    });
    return filtered.sort((a, b) => {
      if (sort === "name") return (a.name || "").localeCompare(b.name || "", "zh-Hans");
      // recent：按上次运行时间降序，回退到创建时间。
      const at = new Date(a.lastRunAt || a.createdAt || 0).getTime() || 0;
      const bt = new Date(b.lastRunAt || b.createdAt || 0).getTime() || 0;
      return bt - at;
    });
  }, [workflows, filter, query, sort]);

  const toggleEnabled = (wf: WorkflowDef) => {
    setEnabled.mutate(
      { id: wf.id, enabled: !wf.enabled },
      { onError: (e) => onToast(`操作失败：${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const toggleCallable = (wf: WorkflowDef) => {
    setCallable.mutate(
      { id: wf.id, callableByAgent: !wf.callableByAgent },
      { onError: (e) => onToast(`操作失败：${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const runOne = (wf: WorkflowDef) => {
    runNow.mutate(wf.id, {
      onSuccess: () => onToast(`已触发「${wf.name || "未命名 loop"}」`),
      onError: (e) => onToast(`执行失败：${e instanceof Error ? e.message : String(e)}`),
    });
  };

  // 运行全部已启用（跳过正在运行的）。
  const runAll = () => {
    const targets = workflows.filter((w) => w.enabled && w.lastStatus !== "running");
    if (targets.length === 0) {
      onToast("没有可运行的已启用 loop");
      return;
    }
    targets.forEach((w) => runNow.mutate(w.id));
    onToast(`已触发 ${targets.length} 个已启用 loop`);
  };

  const isEmpty = workflows.length === 0;

  return (
    <div className="pw-wfl">
      {/* 列表头部 */}
      <div className="pw-wfl-h">
        <span className="pw-wfl-title">
          Loop 工作流
          {!isEmpty ? <span className="pw-wfl-count">{workflows.length} 个</span> : null}
        </span>
        <span className="pw-wfl-spacer" />
        <button className="pw-wfl-icon" title="运行全部已启用" onClick={runAll} disabled={isEmpty}>
          <Icon.Lightning size={17} />
        </button>
        <button className="pw-wfl-icon" title="导入 loop（从 JSON 文件）" onClick={onImport} disabled={!onImport}>
          <Icon.Upload size={17} />
        </button>
        <button className="pw-wfl-new" onClick={onCreate}>
          <Icon.Plus size={15} />
          新建工作流
        </button>
      </div>

      {/* 工具栏：仅在有工作流时展示 */}
      {!isEmpty ? (
        <div className="pw-wfl-toolbar">
          <span className="pw-wfl-search">
            <Icon.Search size={15} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索工作流…"
              aria-label="搜索工作流"
            />
          </span>
          <div className="pw-wfl-tabs" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                className={`pw-wfl-tab ${filter === f.key ? "is-on" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="n">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <span className="pw-wfl-spacer" />
          <button
            className="pw-wfl-sort"
            title="切换排序方式"
            onClick={() => setSort((s) => (s === "recent" ? "name" : "recent"))}
          >
            <Icon.Sort size={15} />
            {sort === "recent" ? "最近运行" : "按名称"}
          </button>
        </div>
      ) : null}

      {isEmpty ? (
        // 空态引导（无任何工作流）
        <div className="pw-panel-empty">
          <Icon.Workflow size={22} />
          <div className="pw-auto-tpl-empty-title">还没有 loop 工作流</div>
          <div className="pw-auto-tpl-empty-hint">点击右上角「+」新建第一个 loop，把触发器与 AI 节点连成自动化流程</div>
          <button className="btn ghost pw-auto-tpl-blank" onClick={onCreate}>
            <Icon.Plus size={13} />
            新建 loop
          </button>
        </div>
      ) : visible.length === 0 ? (
        // 过滤/搜索无结果
        <div className="pw-wfl-empty">没有匹配的工作流</div>
      ) : (
        <div className="pw-wfl-list">
          {visible.map((wf) => (
            <WorkflowRow
              key={wf.id}
              wf={wf}
              onEdit={onEdit}
              onRun={runOne}
              onToggleCallable={toggleCallable}
              onOpenMenu={(w, anchor) => setMenu({ workflow: w, anchor })}
            />
          ))}
        </div>
      )}

      {menu ? (
        <RowMenu
          workflow={menu.workflow}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onEdit={onEdit}
          onExport={onExport}
          onToggleEnabled={toggleEnabled}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
