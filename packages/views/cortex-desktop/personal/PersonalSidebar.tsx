// 个人工作区左栏：项目列表（本地文件夹），项目可折叠、下挂 session 列表。
// 项目行悬停浮现「⋯」菜单 + 「新建 Session」按钮;置顶项目名旁常驻 Pin 标识;
// 已归档项目收进底部可折叠分组。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  defaultAgent,
  partitionProjects,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { EditorInfo, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { UsagePanel } from "./UsagePanel";
import { SettingsMenu } from "./SettingsMenu";
import { ProjectMenu } from "./ProjectMenu";

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

function ProjectBlock({
  project,
  archived,
  editors,
  onToast,
}: {
  project: ProjectMeta;
  archived: boolean;
  editors: EditorInfo[];
  onToast: (text: string) => void;
}) {
  const sessions = usePersonalStore((s) => s.sessions);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const collapsed = usePersonalStore((s) => !!s.collapsedProjects[project.id]);
  const toggle = usePersonalStore((s) => s.toggleProjectCollapse);
  const createSession = usePersonalStore((s) => s.createSession);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const activateProject = usePersonalStore((s) => s.activateProject);
  const setRightView = usePersonalStore((s) => s.setRightView);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  // 项目引导态（已激活但未选会话）时高亮项目名。
  const projectActive = usePersonalStore(
    (s) => !s.homeOpen && !s.timelineProjectId && !s.activeSessionId && s.activeProjectId === project.id,
  );

  // ⋯ 菜单锚点（fixed,屏幕坐标）;null = 关闭。
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  const list = sessions.filter((x) => x.projectId === project.id).sort((a, b) => b.updatedAt - a.updatedAt);

  // 点击项目名:有会话选最近一条;没有则激活项目（中间区显示新建聊天引导）,
  // 右栏切到该项目的 Tasks 并展开。
  const openProject = () => {
    const latest = list[0];
    if (latest) {
      setActiveSession(latest.id);
      return;
    }
    activateProject(project.id);
    setRightView("todos");
    setRightOpen(true);
  };

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAnchor({ x: rect.right, y: rect.bottom + 4 });
  };

  return (
    <div className="pw-project">
      <div className="pw-project-h" data-collapsed={collapsed} data-active={projectActive}>
        <button className="pw-project-chev" onClick={() => toggle(project.id)} title={collapsed ? "展开" : "折叠"}>
          <span className="chev">
            <Icon.Chevron size={11} />
          </span>
        </button>
        <button className="pw-project-toggle" onClick={openProject} title={project.path}>
          <Icon.Folder size={14} />
          <span className="pw-project-name">{project.name}</span>
          {project.pinnedAt ? <Icon.Pin size={11} className="pw-project-pin" /> : null}
        </button>
        <div className={`pw-project-actions ${menuAnchor ? "is-menu-open" : ""}`}>
          <button className={`pw-icon-btn ${menuAnchor ? "is-active" : ""}`} title="更多" onClick={openMenu}>
            <Icon.More size={13} />
          </button>
          <button
            className="pw-icon-btn"
            title="新建 Session"
            onClick={() => {
              createSession(project.id, defaultAgent(agentsAvailable));
              onToast(`已在 ${project.name} 新建 Session`);
            }}
          >
            <Icon.Plus size={13} />
          </button>
        </div>
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
      {menuAnchor ? (
        <ProjectMenu
          project={project}
          archived={archived}
          editors={editors}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}

export function PersonalSidebar({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const addProject = usePersonalStore((s) => s.addProject);
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const openHome = usePersonalStore((s) => s.openHome);
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const openAutomation = usePersonalStore((s) => s.openAutomation);

  // 系统已装编辑器（挂载时探测一次,传给所有 ProjectMenu）。
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  // 「已归档」分组折叠态（本地,默认折叠）。
  const [archivedOpen, setArchivedOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = (await bridge?.listEditors?.()) ?? [];
        if (!cancelled) setEditors(list);
      } catch {
        if (!cancelled) setEditors([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const { visible, archived } = partitionProjects(projects);

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
      {bridge?.automationList ? (
        <button
          className={`pw-home-btn ${automationOpen ? "is-active" : ""}`}
          onClick={openAutomation}
          title="自动化（定时任务）"
        >
          <Icon.Workflow size={14} />
          <span>自动化</span>
        </button>
      ) : null}
      <div className="pw-section-h">
        <span>项目</span>
        <button className="pw-icon-btn" title="添加项目（选择本地文件夹）" onClick={pickProject} disabled={!bridge}>
          <Icon.FolderPlus size={14} />
        </button>
      </div>
      <div className="sb-list">
        {visible.map((p) => (
          <ProjectBlock key={p.id} project={p} archived={false} editors={editors} onToast={onToast} />
        ))}
        {visible.length === 0 && archived.length === 0 ? (
          <div className="sb-empty">
            <Icon.Folder size={22} />
            <div>还没有项目</div>
            <button className="btn primary" onClick={pickProject} disabled={!bridge}>
              <Icon.FolderPlus size={13} />
              选择文件夹
            </button>
          </div>
        ) : null}
        {archived.length > 0 ? (
          <div className="pw-archived-group">
            <button
              className="pw-archived-h"
              data-collapsed={!archivedOpen}
              onClick={() => setArchivedOpen((v) => !v)}
            >
              <span className="chev">
                <Icon.Chevron size={10} />
              </span>
              <span>已归档 ({archived.length})</span>
            </button>
            {archivedOpen
              ? archived.map((p) => (
                  <ProjectBlock key={p.id} project={p} archived={true} editors={editors} onToast={onToast} />
                ))
              : null}
          </div>
        ) : null}
      </div>
      <UsagePanel />
      <SettingsMenu />
    </aside>
  );
}
