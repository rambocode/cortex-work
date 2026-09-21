// 左栏顶部控制：折叠/展开侧栏 + 搜索会话。展开态由侧栏头渲染；折叠态侧栏隐藏后改由中栏顶栏渲染
// （见 PersonalTopBar），两处共用同一组件。
// 展开态侧栏把搜索挪到了模式行右侧(showSearch=false 避免重复);折叠态侧栏整体隐藏,
// 顶栏这颗搜索就是唯一入口,故默认仍显示。

import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore } from "@cortex-work/core";

export function SidebarLeftControls({ showSearch = true }: { showSearch?: boolean }) {
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
      {showSearch ? (
        <button
          className="icon-btn"
          title="搜索会话"
          aria-label="搜索会话"
          onClick={() => setSearchOpen(true)}
        >
          <Icon.Search />
        </button>
      ) : null}
    </div>
  );
}
