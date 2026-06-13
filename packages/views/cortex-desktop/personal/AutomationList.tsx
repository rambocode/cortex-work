// 自动化列表：每行显示标题 / 定时摘要 / 下次运行 / 上次状态,hover 浮现操作:
// 快速执行(Run) · 编辑(Edit) · 更多(暂停-恢复 / 删除)。更多菜单仿 ProjectMenu:
// fixed 定位、点外/ESC 关闭、删除走菜单内二次确认。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAutomations,
  useDeleteAutomation,
  useRunAutomationNow,
  useSetAutomationEnabled,
} from "@cortex-work/core";
import type { AutomationMeta } from "@cortex-work/core";
import { STATUS_CLASS, STATUS_LABEL, fmtDateTime, scheduleSummary } from "./automationFormat";

function RowMenu({
  meta,
  anchor,
  onClose,
  onToast,
}: {
  meta: AutomationMeta;
  anchor: { x: number; y: number };
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const setEnabled = useSetAutomationEnabled();
  const del = useDeleteAutomation();
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

  const toggleEnabled = () => {
    setEnabled.mutate(
      { id: meta.id, enabled: !meta.enabled },
      { onError: (e) => onToast(`操作失败：${e instanceof Error ? e.message : String(e)}`) },
    );
    onClose();
  };

  const doDelete = () => {
    del.mutate(meta.id, {
      onSuccess: () => onToast(`已删除「${meta.name}」`),
      onError: (e) => onToast(`删除失败：${e instanceof Error ? e.message : String(e)}`),
    });
    onClose();
  };

  return (
    <div ref={ref} className="pw-ctx-menu" style={pos} role="menu" aria-label={`${meta.name} 操作`}>
      <button className="pw-tb-menu-item" role="menuitem" onClick={toggleEnabled}>
        {meta.enabled ? <Icon.Stop size={13} /> : <Icon.Run size={13} />}
        <span>{meta.enabled ? "暂停" : "恢复"}</span>
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

export function AutomationList({
  onSelect,
  onCreate,
  onEdit,
  onToast,
}: {
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (meta: AutomationMeta) => void;
  onToast: (text: string) => void;
}) {
  const { data: automations = [] } = useAutomations();
  const runNow = useRunAutomationNow();
  const [menu, setMenu] = useState<{ meta: AutomationMeta; anchor: { x: number; y: number } } | null>(null);

  const sorted = [...automations].sort((a, b) => b.createdAt - a.createdAt);

  const execute = (e: React.MouseEvent, meta: AutomationMeta) => {
    e.stopPropagation();
    runNow.mutate(meta.id, {
      onSuccess: (run) =>
        onToast(run?.status === "skipped" ? `「${meta.name}」上次还在运行,已跳过` : `已触发「${meta.name}」`),
      onError: (err) => onToast(`执行失败：${err instanceof Error ? err.message : String(err)}`),
    });
  };

  return (
    <div className="pw-auto">
      <div className="pw-panel-h">
        <span className="pw-panel-title">自动化</span>
        <button className="pw-icon-btn" title="新建自动化" onClick={onCreate}>
          <Icon.Plus size={15} />
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="pw-panel-empty">
          <Icon.Workflow size={22} />
          <div>还没有自动化任务</div>
          <button className="btn primary" onClick={onCreate}>
            <Icon.Plus size={13} />
            新建自动化
          </button>
        </div>
      ) : (
        <div className="pw-auto-list">
          {sorted.map((a) => (
            <div
              key={a.id}
              className={`pw-auto-item ${a.enabled ? "" : "is-paused"}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(a.id)}
              onKeyDown={(e) => e.key === "Enter" && onSelect(a.id)}
            >
              <div className="pw-auto-item-main">
                <div className="pw-auto-item-title">
                  {a.name || "未命名自动化"}
                  {!a.enabled ? <span className="pw-auto-badge is-warn">已暂停</span> : null}
                  {a.lastStatus ? (
                    <span className={`pw-auto-badge ${STATUS_CLASS[a.lastStatus]}`}>{STATUS_LABEL[a.lastStatus]}</span>
                  ) : null}
                </div>
                <div className="pw-auto-item-sub">
                  <Icon.Clock size={11} />
                  <span>{scheduleSummary(a.schedule)}</span>
                  <span className="pw-auto-dot">·</span>
                  <span>下次 {a.enabled ? fmtDateTime(a.nextRunAt) : "—"}</span>
                </div>
              </div>
              <div className="pw-auto-item-actions">
                <button className="pw-icon-btn" title="立即执行" onClick={(e) => execute(e, a)}>
                  <Icon.Run size={14} />
                </button>
                <button
                  className="pw-icon-btn"
                  title="编辑"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(a);
                  }}
                >
                  <Icon.Edit size={14} />
                </button>
                <button
                  className="pw-icon-btn"
                  title="更多"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({ meta: a, anchor: { x: r.left, y: r.bottom + 4 } });
                  }}
                >
                  <Icon.More size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {menu ? (
        <RowMenu meta={menu.meta} anchor={menu.anchor} onClose={() => setMenu(null)} onToast={onToast} />
      ) : null}
    </div>
  );
}
