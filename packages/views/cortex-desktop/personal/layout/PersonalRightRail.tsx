// 个人工作区右侧竖向工具栏。原先藏在顶部下拉中的右栏视图与终端入口全部在这里常驻，
// 点击当前已打开项会收起面板；点击其他项会切换内容并确保面板展开。

import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore, type RightView } from "@cortex-work/core";

const ITEMS: Array<{
  view: RightView;
  label: string;
  icon: typeof Icon.Folder;
}> = [
  { view: "files", label: "文件", icon: Icon.Folder },
  { view: "skills", label: "Skills", icon: Icon.Sparkle },
  { view: "todos", label: "Tasks", icon: Icon.Task },
  { view: "notes", label: "闪记", icon: Icon.Pin },
  { view: "browser", label: "浏览器", icon: Icon.Globe },
  { view: "canvas", label: "画板", icon: Icon.Palette },
  { view: "subagents", label: "子代理", icon: Icon.Bot },
];

export function PersonalRightRail() {
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const rightView = usePersonalStore((s) => s.rightView);
  const setRightView = usePersonalStore((s) => s.setRightView);
  const terminalOpen = usePersonalStore((s) => s.terminalOpen);
  const toggleTerminal = usePersonalStore((s) => s.toggleTerminal);

  const open = (view: RightView) => {
    if (rightOpen && rightView === view) {
      setRightOpen(false);
      return;
    }
    setRightView(view);
    setRightOpen(true);
  };

  return (
    <nav className="pw-right-rail" aria-label="右侧工具栏">
      {ITEMS.map((item) => {
        const ItemIcon = item.icon;
        const active = rightOpen && rightView === item.view;
        return (
          <button
            type="button"
            key={item.view}
            className={active ? "is-active" : ""}
            aria-pressed={active}
            aria-label={item.label}
            title={item.label}
            onClick={() => open(item.view)}
          >
            <ItemIcon size={18} />
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
