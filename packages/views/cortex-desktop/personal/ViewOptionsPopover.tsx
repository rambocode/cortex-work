// 「显示」弹层（U5，OmniFocus 式）：工具栏「显示」按钮的锚点 + 浮层内容。
// 弹层含两段：① 四档过滤单选（首先可用 / 可用 / 剩余 / 全部，R10）；② 结构开关
//（显示收件箱 / 在大纲中显示文件夹）。选档与开关的持久化由容器（ProjectsWorkbench）经
// KTD9 窗口专属窄通道落库，本组件只受控渲染 + 回调，自身不持有持久态。
// 交互契约：工具栏为 drag 区，触发按钮与浮层挂 `.ds-no-drag` 恢复点击；outside mousedown 关闭
//（与 WorkbenchToolbar 的 NewMenu / ProjectTree 的 AddMenu 一致）。
import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { TASK_VIEW_FILTERS, type TaskViewFilter } from "@cortex-work/core/personal/tasks";
import { useMenuViewportClamp } from "./useMenuViewportClamp";

// 弹层受控值：四档过滤 + 两个结构开关。容器持久化，故这里不含默认逻辑。
export interface ViewOptions {
  filter: TaskViewFilter;
  showInbox: boolean; // 左树收件箱入口显隐（R10；关闭且 inbox 选中 → 容器重定向今日）
  // 中栏是否按 folder 层级出组头。渲染侧尚未消费（无实装），故 UI 上以 disabled + 「即将推出」
  // 占位（对齐 WorkbenchToolbar R12 灰态），避免用户切到无效开关。字段先留占位，待实装再放开。
  showFolders: boolean;
}

export function ViewOptionsPopover({
  value,
  onChange,
}: {
  value: ViewOptions;
  onChange: (next: ViewOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 浮层 left:0 向右展开,窄窗口下可能溢出右缘 → 打开后按 rect 收敛回视口。
  const { menuRef, clampStyle } = useMenuViewportClamp(open);
  // outside mousedown 关闭（浮层内的点击不关闭，便于连续切换多个开关）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="pw-wb-menu-wrap ds-no-drag" ref={wrapRef}>
      <button
        className={`pw-wb-btn${open ? " is-active" : ""}`}
        title="显示"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon.Filter size={16} />
        <span className="pw-wb-btn-label">显示</span>
      </button>
      {open ? (
        <div className="pw-view-options" role="menu" aria-label="显示选项" ref={menuRef} style={clampStyle}>
          {/* ① 四档过滤单选：当前档打勾。 */}
          <div className="pw-view-options-group" role="radiogroup" aria-label="过滤">
            {TASK_VIEW_FILTERS.map(({ value: v, label }) => (
              <button
                key={v}
                type="button"
                role="radioitem"
                aria-checked={value.filter === v}
                className={`pw-view-option${value.filter === v ? " is-on" : ""}`}
                onClick={() => onChange({ ...value, filter: v })}
              >
                <span className="pw-view-option-check">{value.filter === v ? <Icon.Check size={13} /> : null}</span>
                <span className="pw-view-option-label">{label}</span>
              </button>
            ))}
          </div>
          <div className="pw-view-options-sep" />
          {/* ② 结构开关：勾选式切换（复用单选行样式 + check 位表状态）。 */}
          <div className="pw-view-options-group" aria-label="结构">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={value.showInbox}
              className={`pw-view-option${value.showInbox ? " is-on" : ""}`}
              onClick={() => onChange({ ...value, showInbox: !value.showInbox })}
            >
              <span className="pw-view-option-check">{value.showInbox ? <Icon.Check size={13} /> : null}</span>
              <span className="pw-view-option-label">显示收件箱</span>
            </button>
            {/* 未实装占位（R12 灰态）：渲染侧尚无 folder 组头逻辑消费 showFolders，故 disabled +
                「即将推出」tooltip，避免用户切到无效开关。实装后去掉 disabled 并接回 onChange。 */}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={false}
              aria-disabled
              disabled
              className="pw-view-option is-soon"
              title="在大纲中显示文件夹（即将推出）"
            >
              <span className="pw-view-option-check" />
              <span className="pw-view-option-label">在大纲中显示文件夹</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
