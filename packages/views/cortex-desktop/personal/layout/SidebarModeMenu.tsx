// 左栏顶部「工作模式」下拉(对齐 ChatGPT 侧栏「ChatGPT ▾」):标题显示当前模式,点开切换 对话 / 写作。
// 只有一个可用模式时(web / 旧壳无桥,写作不可用)退化为纯标题,不渲染点了没意义的下拉箭头。

import { Icon } from "@cortex-work/ui/icons";
import { useDismissableMenu } from "../shared/useDismissableMenu";

export interface SidebarMode {
  key: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export function SidebarModeMenu({ modes }: { modes: SidebarMode[] }) {
  const menu = useDismissableMenu();
  // 自动化 / Loop / 设置 打开时没有哪个模式处于激活态,标题回落显示第一个(对话)。
  const current = modes.find((m) => m.active) ?? modes[0];
  if (!current) return null;

  if (modes.length < 2) {
    return <div className="pw-sidebar-mode-title">{current.label}</div>;
  }

  return (
    <div className="pw-tb-menu-wrap pw-sidebar-mode" ref={menu.wrapRef}>
      <button
        type="button"
        className={`pw-sidebar-mode-trigger ${menu.open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={`工作模式：${current.label}`}
        onClick={() => menu.setOpen((v) => !v)}
      >
        <span>{current.label}</span>
        <Icon.Chevron size={14} />
      </button>
      {menu.open ? (
        <div className="pw-tb-menu pw-tb-menu--left pw-sidebar-mode-menu" role="menu" aria-label="工作模式">
          {modes.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`pw-tb-menu-item ${m.active ? "is-on" : ""}`}
              role="menuitemradio"
              aria-checked={m.active}
              onClick={() => {
                menu.setOpen(false);
                m.onSelect();
              }}
            >
              <span>{m.label}</span>
              {m.active ? <Icon.Check size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
