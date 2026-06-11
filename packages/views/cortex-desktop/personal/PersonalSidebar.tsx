// 个人工作区左栏：项目列表（本地文件夹），项目可折叠、下挂 session 列表。

import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { ProjectMeta, SessionMeta } from "@cortex-work/core";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { UsagePanel } from "./UsagePanel";
import { SettingsMenu } from "./SettingsMenu";

export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天`;
}

function SessionRow({ session, active, onSelect }: { session: SessionMeta; active: boolean; onSelect: () => void }) {
  return (
    <button className={`pw-session ${active ? "is-active" : ""}`} onClick={onSelect}>
      <span className="pw-session-title">{session.title}</span>
      <span className="pw-session-time">{relTime(session.updatedAt)}</span>
    </button>
  );
}

function ProjectBlock({ project, onToast }: { project: ProjectMeta; onToast: (text: string) => void }) {
  const sessions = usePersonalStore((s) => s.sessions);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const collapsed = usePersonalStore((s) => !!s.collapsedProjects[project.id]);
  const toggle = usePersonalStore((s) => s.toggleProjectCollapse);
  const createSession = usePersonalStore((s) => s.createSession);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const openTimeline = usePersonalStore((s) => s.openTimeline);
  const timelineActive = usePersonalStore((s) => s.timelineProjectId === project.id);

  const list = sessions.filter((x) => x.projectId === project.id).sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="pw-project">
      <div className="pw-project-h" data-collapsed={collapsed}>
        <button className="pw-project-toggle" onClick={() => toggle(project.id)} title={project.path}>
          <span className="chev">
            <Icon.Chevron size={11} />
          </span>
          <Icon.Folder size={14} />
          <span className="pw-project-name">{project.name}</span>
        </button>
        <button
          className={`pw-icon-btn ${timelineActive ? "is-active" : ""}`}
          title="项目时间线"
          onClick={() => openTimeline(project.id)}
        >
          <Icon.Clock size={13} />
        </button>
        <button
          className="pw-icon-btn"
          title="新建 Session"
          onClick={() => {
            createSession(project.id, "claude");
            onToast(`已在 ${project.name} 新建 Session`);
          }}
        >
          <Icon.Plus size={13} />
        </button>
      </div>
      {!collapsed
        ? list.map((sess) => (
            <SessionRow
              key={sess.id}
              session={sess}
              active={sess.id === activeSessionId}
              onSelect={() => setActiveSession(sess.id)}
            />
          ))
        : null}
      {!collapsed && list.length === 0 ? <div className="pw-empty-hint">点 + 新建 Session</div> : null}
    </div>
  );
}

export function PersonalSidebar({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const addProject = usePersonalStore((s) => s.addProject);
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const openHome = usePersonalStore((s) => s.openHome);

  const pickProject = async () => {
    if (!bridge) return;
    const path = await bridge.pickDirectory();
    if (!path) return;
    const proj = addProject(path);
    onToast(`已添加项目 ${proj.name}`);
  };

  return (
    <aside className="sidebar">
      <WorkspaceTabs />
      <button className={`pw-home-btn ${homeOpen ? "is-active" : ""}`} onClick={openHome} title="首页（热力图 / 项目检索 / 全局日总结）">
        <Icon.Chart size={14} />
        <span>首页</span>
      </button>
      <div className="pw-section-h">
        <span>项目</span>
        <button className="pw-icon-btn" title="添加项目（选择本地文件夹）" onClick={pickProject} disabled={!bridge}>
          <Icon.FolderPlus size={14} />
        </button>
      </div>
      <div className="sb-list">
        {projects.map((p) => (
          <ProjectBlock key={p.id} project={p} onToast={onToast} />
        ))}
        {projects.length === 0 ? (
          <div className="sb-empty">
            <Icon.Folder size={22} />
            <div>还没有项目</div>
            <button className="btn primary" onClick={pickProject} disabled={!bridge}>
              <Icon.FolderPlus size={13} />
              选择文件夹
            </button>
          </div>
        ) : null}
      </div>
      <UsagePanel />
      <SettingsMenu />
    </aside>
  );
}
