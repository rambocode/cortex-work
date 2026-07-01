// 全屏三栏「项目」工作台（U4 骨架）。fixed 全窗覆盖层（仿 .pw-settings-page，见 U5 CSS），
// 由 PersonalWorkspace 在 settings 覆盖层**之前**渲染，使工作台内叠开设置时设置盖在其上
// （openSettings 不清 projectsOpen，栈式关系，见 store openProjects 注释）。
// U5 补三列布局 + 根挂 useTasksChangeSubscription；U6/U7/U8 填左树 / 中列表 / 右详情。
import { useEffect } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";

export function ProjectsWorkbench() {
  const closeProjects = usePersonalStore((s) => s.closeProjects);

  // ESC 关闭工作台（回到打开前的底层视图）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeProjects();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeProjects]);

  return (
    <div className="pw-projects-page">
      <div className="pw-projects-head">
        <span className="pw-projects-title">项目</span>
        <div className="spacer" />
        <button className="pw-icon-btn" title="关闭（Esc）" onClick={closeProjects}>
          <Icon.X size={16} />
        </button>
      </div>
      <div className="pw-projects-body">
        <div className="pw-empty-hint">项目工作台（三栏布局建设中）。</div>
      </div>
    </div>
  );
}
