// 工作流（loop）列表页：每行展示名称/节点数/上次运行时间/最近结果摘要/失败 pill。
// 悬停浮现操作：运行一次/编辑/导出/删除（删除走行内二次确认）。
// 每行底部两个 toggle：「启用」与「AI 可调用」。
// 顶部操作：触发器（暂位，U9 后接入）/ 导入（U15 后接入）/ 新建 loop。
// Web 端（bridge.workflowList 不存在）：此组件不会被渲染（PersonalSidebar 已门控）。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  formatWorkflowStatus,
  formatRelativeTime,
  formatRunResultSummary,
  WORKFLOW_STATUS_CLASS,
} from "./workflowFormat";

// ── 行内更多操作菜单（运行/编辑/导出/删除）────────────────────────────────

function RowMenu({
  workflow,
  anchor,
  onClose,
  onEdit,
  onExport,
  onToast,
}: {
  workflow: WorkflowDef;
  anchor: { x: number; y: number };
  onClose: () => void;
  onEdit: (wf: WorkflowDef) => void;
  onExport: (wf: WorkflowDef) => void;
  onToast: (text: string) => void;
}) {
  const del = useDeleteWorkflow();
  const runNow = useRunWorkflowNow();
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

  const doRun = () => {
    runNow.mutate(workflow.id, {
      onSuccess: () => onToast(`已触发「${workflow.name || "未命名 loop"}」`),
      onError: (e) => onToast(`执行失败：${e instanceof Error ? e.message : String(e)}`),
    });
    onClose();
  };

  const doDelete = () => {
    del.mutate(workflow.id, {
      onSuccess: () => onToast(`已删除「${workflow.name || "未命名 loop"}」`),
      onError: (e) => onToast(`删除失败：${e instanceof Error ? e.message : String(e)}`),
    });
    onClose();
  };

  return (
    <div ref={ref} className="pw-ctx-menu" style={pos} role="menu" aria-label={`${workflow.name} 操作`}>
      <button className="pw-tb-menu-item" role="menuitem" onClick={doRun}>
        <Icon.Run size={13} />
        <span>运行一次</span>
      </button>
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

// ── 单条 toggle 按钮（启用 / AI 可调用）─────────────────────────────────────

function WorkflowToggle({
  on,
  disabled = false,
  label,
  title,
  icon,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  const active = on && !disabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={`pw-wf-toggle ${active ? "is-on" : ""} ${disabled ? "is-disabled" : ""}`}
    >
      {/* pill 轨道 */}
      <span className={`pw-wf-toggle-track ${active ? "is-active" : ""}`}>
        <span className={`pw-wf-toggle-thumb ${on ? "is-on" : ""}`} />
      </span>
      <span className={`pw-wf-toggle-label ${active ? "is-active" : ""}`}>
        {icon}
        {label}
      </span>
    </button>
  );
}

// ── 主列表组件 ───────────────────────────────────────────────────────────────

export function WorkflowList({
  onEdit,
  onCreate,
  onExport,
  onToast,
}: {
  /** 点编辑 → 传 WorkflowDef，由 WorkflowView 切换到编辑器。 */
  onEdit: (wf: WorkflowDef) => void;
  onCreate: () => void;
  onExport: (wf: WorkflowDef) => void;
  onToast: (text: string) => void;
}) {
  const { data: workflows = [] } = useWorkflows();
  const setEnabled = useSetWorkflowEnabled();
  const setCallable = useSetWorkflowCallableByAgent();
  const [menu, setMenu] = useState<{ workflow: WorkflowDef; anchor: { x: number; y: number } } | null>(null);

  // 按 createdAt 降序（最新在前）
  const sorted = [...workflows].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });

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

  return (
    <div className="pw-auto">
      {/* 顶部面板标题 + 操作按钮 */}
      <div className="pw-panel-h">
        <span className="pw-panel-title">Loop 工作流</span>
        <div className="pw-panel-h-actions">
          {/* 触发器入口：U9 Webhook server 落地后接入真实功能，此处预留入口 */}
          <button className="pw-icon-btn" title="Webhook 触发器（即将上线）" disabled>
            <Icon.Lightning size={15} />
          </button>
          {/* 导入：U15 导入导出 DSL 落地后接入，此处预留入口 */}
          <button className="pw-icon-btn" title="导入 loop（即将上线）" disabled>
            <Icon.Download size={15} />
          </button>
          <button className="pw-icon-btn" title="新建 loop" onClick={onCreate}>
            <Icon.Plus size={15} />
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        // 空态引导
        <div className="pw-panel-empty">
          <Icon.Workflow size={22} />
          <div className="pw-auto-tpl-empty-title">还没有 loop 工作流</div>
          <div className="pw-auto-tpl-empty-hint">点击右上角「+」新建第一个 loop，把触发器与 AI 节点连成自动化流程</div>
          <button className="btn ghost pw-auto-tpl-blank" onClick={onCreate}>
            <Icon.Plus size={13} />
            新建 loop
          </button>
        </div>
      ) : (
        <div className="pw-auto-list">
          {sorted.map((wf) => {
            const { label: statusLabel, variant } = formatWorkflowStatus(wf.lastStatus ?? "idle");
            const statusClass = WORKFLOW_STATUS_CLASS[variant];
            const lastRunText = formatRelativeTime(wf.lastRunAt || null);
            const resultText = formatRunResultSummary(wf.lastMessage);
            const nodeCount = formatNodeCount(wf.nodes?.length ?? 0);
            const isFailed = variant === "error";

            return (
              <div
                key={wf.id}
                className={`pw-auto-item ${wf.enabled ? "" : "is-paused"}`}
                role="button"
                tabIndex={0}
                // 点击行体进入编辑器
                onClick={() => onEdit(wf)}
                onKeyDown={(e) => e.key === "Enter" && onEdit(wf)}
              >
                {/* 主信息区 */}
                <div className="pw-auto-item-main">
                  <div className="pw-auto-item-title">
                    {wf.name || "未命名 loop"}
                    {/* 启用状态 */}
                    {!wf.enabled ? <span className="pw-auto-badge is-warn">已暂停</span> : null}
                    {/* 失败 pill（上次运行失败时显示红色 pill）*/}
                    {isFailed ? (
                      <span className={`pw-auto-badge ${statusClass}`}>{statusLabel}</span>
                    ) : wf.lastStatus && wf.lastStatus !== "idle" ? (
                      <span className={`pw-auto-badge ${statusClass}`}>{statusLabel}</span>
                    ) : null}
                  </div>
                  <div className="pw-auto-item-sub">
                    <Icon.Workflow size={11} />
                    <span>{nodeCount}</span>
                    <span className="pw-auto-dot">·</span>
                    <Icon.Clock size={11} />
                    <span>上次运行 {lastRunText}</span>
                  </div>
                  {/* 最近结果摘要（有内容才显示）*/}
                  {resultText ? (
                    <div className="pw-auto-item-result">{resultText}</div>
                  ) : null}
                </div>

                {/* 悬停操作区 */}
                <div className="pw-auto-item-actions">
                  <button
                    className="pw-icon-btn"
                    title="更多操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setMenu({ workflow: wf, anchor: { x: r.left, y: r.bottom + 4 } });
                    }}
                  >
                    <Icon.More size={14} />
                  </button>
                </div>

                {/* 两个 toggle 开关（点击不跳编辑器，内部 stopPropagation）*/}
                <div className="pw-wf-toggles" onClick={(e) => e.stopPropagation()}>
                  <WorkflowToggle
                    on={wf.enabled}
                    label="启用"
                    title={wf.enabled ? "点击暂停工作流" : "点击启用工作流"}
                    icon={<Icon.Run size={12} />}
                    onClick={() => toggleEnabled(wf)}
                  />
                  <WorkflowToggle
                    on={wf.callableByAgent}
                    // 未启用时 AI 可调用无意义，灰掉
                    disabled={!wf.enabled}
                    label="AI 可调用"
                    title={wf.enabled ? "允许 AI Agent 经 MCP 调用此 loop" : "需先启用才可开放 AI 调用"}
                    icon={<Icon.Bot size={12} />}
                    onClick={() => toggleCallable(wf)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {menu ? (
        <RowMenu
          workflow={menu.workflow}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onEdit={onEdit}
          onExport={onExport}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
