// 个人工作区右侧竖向工具栏。原先藏在顶部下拉中的右栏视图与终端入口全部在这里常驻，
// 点击当前已打开项会收起面板；点击其他项会切换内容并确保面板展开。
// 入口清单不再手写:从右栏注册表按 descriptor.rail.order 派生（registry 是唯一真相）。

import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { railItems } from "../right-panel/registry";

// registry 是静态清单,模块级求值一次即可（引用稳定,不破坏 memo）。
const RAIL_ITEMS = railItems();

export function PersonalRightRail() {
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const rightView = usePersonalStore((s) => s.rightView);
  const setRightView = usePersonalStore((s) => s.setRightView);
  const terminalOpen = usePersonalStore((s) => s.terminalOpen);
  const toggleTerminal = usePersonalStore((s) => s.toggleTerminal);

  const open = (view: string, load: () => Promise<unknown>) => {
    if (rightOpen && rightView === view) {
      setRightOpen(false);
      return;
    }
    setRightView(view);
    setRightOpen(true);
    // 同步预取面板 chunk,缩短懒加载首开的 Suspense 空窗。
    void load();
  };

  return (
    <nav className="pw-right-rail" aria-label="右侧工具栏">
      {RAIL_ITEMS.map((item) => {
        const ItemIcon = item.icon;
        const active = rightOpen && rightView === item.id;
        return (
          <button
            type="button"
            key={item.id}
            className={active ? "is-active" : ""}
            aria-pressed={active}
            aria-label={item.title}
            title={item.title}
            onClick={() => open(item.id, item.load)}
          >
            {ItemIcon ? <ItemIcon size={18} /> : null}
          </button>
        );
      })}
      <span className="pw-right-rail-spacer" />
      <span className="pw-right-rail-sep" />
      <button
        type="button"
        className={terminalOpen ? "is-active" : ""}
        aria-pressed={terminalOpen}
        aria-label="终端"
        title="终端"
        onClick={toggleTerminal}
      >
        <Icon.Terminal size={18} />
      </button>
    </nav>
  );
}
