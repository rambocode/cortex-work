// 项目详情头部（参照 IFocus 项目页头）：项目名 + 状态徽标 + 描述摘要 + PROGRESS 大字/进度条 + 齿轮。
// 进度 = projectProgress（done / 非 dropped 总数，前端实时算，入参为项目子树全部任务）。
// 齿轮弹出 ProjectSettingsPanel（useDismissableMenu 外点/Esc 关闭 + viewport clamp）。
import { Icon } from "@cortex-work/ui/icons";
import { projectProgress } from "@cortex-work/core/personal/projectStages";
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { useDismissableMenu } from "./useDismissableMenu";
import { useMenuViewportClamp } from "./useMenuViewportClamp";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";

// 非 active 项目状态的头部徽标文案（active 是常态不显）。
const STATUS_BADGE: Record<string, string> = {
  "on-hold": "已暂停",
  done: "已完成",
  dropped: "已丢弃",
};

export function ProjectWorkspaceHeader({
  project,
  tasks,
  onToast,
}: {
  project: TaskProject;
  // 项目子树全部任务（进度分母；由容器按 descendantProjectIds 聚合传入）。
  tasks: TaskMeta[];
  onToast: (text: string) => void;
}) {
  const { done, total, percent } = projectProgress(tasks);
  const { open, setOpen, wrapRef, onMouseEnter, onMouseLeave } = useDismissableMenu();
  const { menuRef, clampStyle } = useMenuViewportClamp(open);
  const statusBadge = project.status ? STATUS_BADGE[project.status] : undefined;
  // 描述摘要：单行截断（完整内容在设置面板编辑）。
  const noteSummary = project.note?.trim().split("\n")[0];

  return (
    <div className="pw-proj-header">
      <div className="pw-proj-header-main">
        <div className="pw-proj-header-name">
          {project.name}
          {statusBadge ? <span className="pw-proj-header-status">{statusBadge}</span> : null}
        </div>
        {noteSummary ? <div className="pw-proj-header-note">{noteSummary}</div> : null}
      </div>
      <div className="pw-proj-header-progress" title={`已完成 ${done} / ${total} 个任务`}>
        <div className="pw-proj-header-progress-num">
          {percent}%<span className="pw-proj-header-progress-label">PROGRESS</span>
        </div>
        <div className="pw-proj-header-progress-bar">
          <div className="pw-proj-header-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="pw-wb-menu-wrap" ref={wrapRef} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        <button
          className={`pw-ps-icon-btn${open ? " is-on" : ""}`}
          title="项目设置"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon.Settings size={16} />
        </button>
        {open ? (
          <div className="pw-view-options pw-proj-settings-pop" ref={menuRef} style={clampStyle}>
            <ProjectSettingsPanel project={project} onClose={() => setOpen(false)} onToast={onToast} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
