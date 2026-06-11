// 左侧菜单顶部的「团队工作区 / 个人工作区」切换 tab，团队/个人两个 sidebar 都渲染。

import { useCortexUIStore } from "@cortex-work/core";

export function WorkspaceTabs() {
  const workspace = useCortexUIStore((s) => s.workspace);
  const setWorkspace = useCortexUIStore((s) => s.setWorkspace);
  return (
    <div className="ws-tabs">
      <button className={`ws-tab ${workspace === "team" ? "is-active" : ""}`} onClick={() => setWorkspace("team")}>
        团队工作区
      </button>
      <button
        className={`ws-tab ${workspace === "personal" ? "is-active" : ""}`}
        onClick={() => setWorkspace("personal")}
      >
        个人工作区
      </button>
    </div>
  );
}
