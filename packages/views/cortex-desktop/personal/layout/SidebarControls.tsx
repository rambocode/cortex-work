// 左栏顶部控制：折叠/展开侧栏 + 搜索会话。展开态由侧栏头渲染；折叠态侧栏隐藏后改由中栏顶栏渲染
// （见 PersonalTopBar），两处共用同一组件。

import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore } from "@cortex-work/core";

export function SidebarLeftControls() {
  const leftCollapsed = useCortexUIStore((s) => s.leftCollapsed);
  const toggleLeft = useCortexUIStore((s) => s.toggleLeftCollapsed);
  const setSearchOpen = useCortexUIStore((s) => s.setSessionSearchOpen);
  return (
    <div className="pw-sb-ctrls">
      <button
        className="icon-btn"
        title={leftCollapsed ? "展开侧栏" : "折叠侧栏"}
        aria-label={leftCollapsed ? "展开侧栏" : "折叠侧栏"}
        onClick={() => toggleLeft()}
      >
        <Icon.Sidebar />
      </button>
      <button
        className="icon-btn"
        title="搜索会话"
        aria-label="搜索会话"
        onClick={() => setSearchOpen(true)}
      >
        <Icon.Search />
      </button>
    </div>
  );
}
