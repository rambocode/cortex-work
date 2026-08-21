// 左侧菜单顶部的「团队工作区 / 个人工作区」切换 tab，团队/个人两个 sidebar 都渲染。

import { useCortexUIStore } from "@cortex-work/core";

// 团队工作区已随「服务器工作区」(feat/team-server-workspace)真实化,恢复切换
// tab;默认仍进个人工作区（store 默认 workspace="personal"）。
const TEAM_WORKSPACE_ENABLED = true;

export function WorkspaceTabs() {
  const workspace = useCortexUIStore((s) => s.workspace);
  const setWorkspace = useCortexUIStore((s) => s.setWorkspace);
  if (!TEAM_WORKSPACE_ENABLED) return null;
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
