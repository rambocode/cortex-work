// 自动化详情顶部操作栏(纯展示):返回 · 标题 · 状态徽章 · 启用开关 · 立即运行(主按钮) ·
// 编辑 · 更多菜单。无 core hooks——启用/运行/副本/导出/删除全部经回调上抛,由编排器接 React Query。
// 更多菜单仿 AutomationList 的 RowMenu(点外/ESC 关闭、删除走菜单内二次确认),但内联在按钮下方。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";

function MoreMenu({
  onClose,
  onCopyPrompt,
  onExport,
  onDuplicate,
  onDelete,
}: {
  onClose: () => void;
  onCopyPrompt: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const wrap = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} className="pw-auto-menu" role="menu" aria-label="更多操作">
      <button className="pw-auto-mi" role="menuitem" onClick={wrap(onCopyPrompt)}>
        <Icon.Copy size={15} />
        <span>复制提示词</span>
      </button>
      <button className="pw-auto-mi" role="menuitem" onClick={wrap(onExport)}>
        <Icon.Download size={15} />
        <span>导出运行历史</span>
      </button>
      <button className="pw-auto-mi" role="menuitem" onClick={wrap(onDuplicate)}>
        <Icon.Copy size={15} />
        <span>创建副本</span>
      </button>
      <div className="pw-auto-mi-sep" />
      <button
        className="pw-auto-mi is-danger"
        role="menuitem"
        // 删除走菜单内二次确认:第一次点切文案,第二次才真正触发(仿 AutomationList RowMenu)。
        onClick={confirming ? wrap(onDelete) : () => setConfirming(true)}
      >
        <Icon.Trash size={15} />
        <span>{confirming ? "确认删除？" : "删除自动化"}</span>
      </button>
    </div>
  );
}

export function AutomationDetailHeader({
  name,
  enabled,
  running,
  onBack,
  onToggleEnabled,
  onRun,
  onEdit,
  onCopyPrompt,
  onExport,
  onDuplicate,
  onDelete,
}: {
  name: string;
  enabled: boolean;
  running?: boolean;
  onBack: () => void;
  onToggleEnabled: () => void;
  onRun: () => void;
  onEdit: () => void;
  onCopyPrompt: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="pw-auto-dt-head">
      <button className="pw-icon-btn" title="返回" onClick={onBack}>
        <Icon.Back size={15} />
      </button>
      <span className="pw-auto-dt-title">{name || "未命名自动化"}</span>
      <span className={`pw-auto-status-pill ${enabled ? "" : "off"}`}>
        <span className="pw-auto-status-dot" />
        {enabled ? "已启用" : "已停用"}
      </span>

      <span className="pw-auto-dt-spacer" />

      <button
        type="button"
        className="twk-toggle"
        data-on={enabled ? "1" : "0"}
        role="switch"
        aria-checked={enabled}
        title={enabled ? "点击停用" : "点击启用"}
        onClick={onToggleEnabled}
      >
        <i />
      </button>
      <button className="btn primary pw-auto-dt-run" onClick={onRun} disabled={running}>
        <Icon.Run size={14} />
        {running ? "运行中…" : "立即运行"}
      </button>
      <button className="btn pw-auto-dt-edit" onClick={onEdit}>
        <Icon.Edit size={14} />
        编辑
      </button>
      <div className="pw-auto-more-wrap">
        <button
          className="pw-icon-btn"
          title="更多"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon.More size={16} />
        </button>
        {menuOpen ? (
          <MoreMenu
            onClose={() => setMenuOpen(false)}
            onCopyPrompt={onCopyPrompt}
            onExport={onExport}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
          />
        ) : null}
      </div>
    </div>
  );
}
