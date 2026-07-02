// 通用字段勾选浮层：「设置显示字段」「设置编辑字段」两个工具栏按钮共用的泛型受控组件。
// 结构与交互对齐同目录 ViewOptionsPopover：复用 pw-wb-menu-wrap / pw-wb-btn / pw-view-options /
// pw-view-option(.is-on) / pw-view-option-check 既有 CSS 类，零新增样式。关闭范式复用 useDismissableMenu
//（外点 / Esc / 失焦关闭）；点击菜单项只切换单键、回调完整 next 对象，不关闭菜单便于连续勾选。
import type React from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDismissableMenu } from "./useDismissableMenu";
import { useMenuViewportClamp } from "./useMenuViewportClamp";

export function FieldsPopover<K extends string>({
  icon,
  title,
  options,
  value,
  onChange,
}: {
  icon: React.ReactNode; // 触发按钮图标（如 <Icon.Settings size={16} />）
  title: string; // 触发按钮 title / aria-label
  options: readonly { key: K; label: string }[];
  value: Record<K, boolean>;
  onChange: (next: Record<K, boolean>) => void;
}) {
  // 工具栏为 drag 区：wrap 挂 ds-no-drag 恢复浮层内点击；开关闭由 useDismissableMenu 统一管。
  const { open, setOpen, wrapRef, onMouseEnter, onMouseLeave } = useDismissableMenu();
  // 触发按钮在工具栏最右,浮层 left:0 向右展开会溢出窗口右缘 → 打开后按 rect 收敛回视口。
  const { menuRef, clampStyle } = useMenuViewportClamp(open);

  return (
    <div
      className="pw-wb-menu-wrap ds-no-drag"
      ref={wrapRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <button
        className={`pw-wb-btn${open ? " is-on" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </button>
      {open ? (
        <div className="pw-view-options" role="menu" aria-label={title} ref={menuRef} style={clampStyle}>
          <div className="pw-view-options-group">
            {options.map(({ key, label }) => {
              const on = value[key];
              return (
                <button
                  key={key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={`pw-view-option${on ? " is-on" : ""}`}
                  // 只翻转当前键，回调完整 next 对象；不关闭菜单，支持连续勾选。
                  onClick={() => onChange({ ...value, [key]: !on })}
                >
                  <span className="pw-view-option-check">{on ? <Icon.Check size={13} /> : null}</span>
                  <span className="pw-view-option-label">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
