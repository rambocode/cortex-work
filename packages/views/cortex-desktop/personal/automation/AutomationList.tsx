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
import { AutomationTemplateGallery } from "./AutomationTemplateGallery";
import type { AutomationTemplate } from "./automationTemplates";

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
  onPickTemplate,
}: {
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (meta: AutomationMeta) => void;
  onToast: (text: string) => void;
  // 点击模板卡片时回调：把被选 template 原样上抛,由 AutomationView 计算 once at 并预填弹窗。
  onPickTemplate: (template: AutomationTemplate) => void;
}) {
  const { data: automations = [] } = useAutomations();
  const runNow = useRunAutomationNow();
  const [menu, setMenu] = useState<{ meta: AutomationMeta; anchor: { x: number; y: number } } | null>(null);
  // 有任务时模板画廊的展开态：默认展开常驻在列表顶部,用户可经顶部按钮收起以腾出空间。
  const [tplOpen, setTplOpen] = useState(true);

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
        {sorted.length > 0 ? (
          <div className="pw-panel-h-actions">
            {/* 有任务时:模板画廊默认展开常驻顶部,此按钮可收起/再展开(KTD-3) */}
            <button
              className={`pw-icon-btn ${tplOpen ? "is-active" : ""}`}
              title="从模板新建"
              aria-expanded={tplOpen}
              onClick={() => setTplOpen((v) => !v)}
            >
              <Icon.Sparkle size={15} />
            </button>
            <button className="pw-icon-btn" title="新建自动化" onClick={onCreate}>
              <Icon.Plus size={15} />
            </button>
          </div>
        ) : (
          <button className="pw-icon-btn" title="新建自动化" onClick={onCreate}>
            <Icon.Plus size={15} />
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="pw-panel-empty pw-auto-tpl-empty">
          <Icon.Workflow size={22} />
          <div className="pw-auto-tpl-empty-title">还没有自动化任务</div>
          <div className="pw-auto-tpl-empty-hint">从下面的模板一键开始,或新建空白任务</div>
          {/* 空状态:整块展示模板画廊作为新手强引导 */}
          <AutomationTemplateGallery onPick={onPickTemplate} />
          <button className="btn ghost pw-auto-tpl-blank" onClick={onCreate}>
            <Icon.Plus size={13} />
            空白新建
          </button>
        </div>
      ) : (
        <div className="pw-auto-list">
          {tplOpen ? (
            // 默认展开常驻列表顶部;可经顶部「从模板」按钮收起。
            <div className="pw-auto-tpl-panel">
              <div className="pw-auto-tpl-panel-h">从模板新建</div>
              <AutomationTemplateGallery onPick={onPickTemplate} />
            </div>
          ) : null}
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
                  {/* AI 代建标记：这条任务是用户在会话里让 Cortex 建的（经 MCP 工具）。
                      纯审计用途,不参与任何准入判断——用户需要能一眼分辨「哪些是我自己建的」。 */}
                  {a.createdBy === "agent" ? (
                    <span className="pw-auto-badge" title="由 Cortex 在会话中创建">
                      AI 创建
                    </span>
                  ) : null}
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
