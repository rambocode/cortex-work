// 左侧菜单顶部的「团队工作区 / 个人工作区」切换 tab，团队/个人两个 sidebar 都渲染。

import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";

/// 「团队工作区」入口的可见性由 设置 → 常规 的开关决定，**缺省不显示**。
///
/// 从前这里是一个写死的 `TEAM_WORKSPACE_ENABLED = true`：团队能力刚真实化时用它一键放开，
/// 但那意味着每个个人用户都被迫在侧栏第一行看到一个自己用不上的入口。改为用户自选。
///
/// 关掉开关时若用户正停在团队工作区，回落由 CortexDesktopView 的 effect 负责——
/// 不放在这里，是因为本组件在「已经切到团队」的某些布局下未必挂载，靠它兜底会漏。
export function WorkspaceTabs() {
  const workspace = useCortexUIStore((s) => s.workspace);
  const setWorkspace = useCortexUIStore((s) => s.setWorkspace);
  const showTeam = usePersonalStore((s) => s.generalSettings.showTeamWorkspace);
  if (showTeam !== true) return null;
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
