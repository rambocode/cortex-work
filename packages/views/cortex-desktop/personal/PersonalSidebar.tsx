// 个人工作区左栏：项目列表（本地文件夹），项目可折叠、下挂 session 列表。
// 项目行悬停浮现「⋯」菜单 + 「新建 Session」按钮;置顶项目名旁常驻 Pin 标识;
// 已归档项目收进底部可折叠分组。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  closePiSession,
  resolveDefaultAgent,
  partitionProjects,
  reapSessionRun,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { EditorInfo, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { SettingsMenu } from "./SettingsMenu";
import { ProjectMenu } from "./ProjectMenu";
import { SidebarLeftControls } from "./SidebarControls";

export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天`;
  // 周/月粒度:超过 7 天的旧条目(归档会话等)不再笼统显示「N 天」。
  if (day < 30) return `${Math.floor(day / 7)} 周`;
  return `${Math.floor(day / 30)} 个月`;
}

// 会话行:悬停在右侧浮现「归档/取消归档」+「删除」两个图标按钮。
// 删除就地二次确认（首点变红+✓,再点真删;鼠标移开重置）,不弹菜单/对话框。
function SessionRow({
  session,
  active,
  onSelect,
  onToast,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: () => void;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const archiveSession = usePersonalStore((s) => s.archiveSession);
  const unarchiveSession = usePersonalStore((s) => s.unarchiveSession);
  const removeSession = usePersonalStore((s) => s.removeSession);
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const archived = session.archivedAt != null;

  const onArchive = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (archived) {
      unarchiveSession(session.id);
      onToast(`已取消归档 ${session.title}`);
    } else {
      archiveSession(session.id);
      onToast(`已归档 ${session.title}`);
    }
  };

  const onDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      return;
    }
    reapSessionRun(qc, session.id); // 先回收 renderer run(停看门狗/清 running),防孤儿 interval
    removeSession(session.id); // 即时移除 UI
    void bridge?.deleteChat?.(session.id); // 物理删磁盘消息文件
    void closePiSession(bridge, session.id); // 终止该会话的 pi 长驻进程（非 pi 会话 no-op）
    onToast(`已删除 ${session.title}`);
  };

  return (
    <div className="pw-session-row" data-archived={archived} onMouseLeave={() => setConfirming(false)}>
      <button className={`pw-session ${active ? "is-active" : ""}`} onClick={onSelect}>
        <span className="pw-session-title">{session.title}</span>
        <span className="pw-session-time">{relTime(session.updatedAt)}</span>
      </button>
      <div className="pw-session-actions">
        <button
          className="pw-icon-btn pw-session-act"
          title={archived ? "取消归档" : "归档"}
          onClick={onArchive}
        >
          {archived ? <Icon.Reply size={13} /> : <Icon.Archive size={13} />}
        </button>
        <button
          className={`pw-icon-btn pw-session-act ${confirming ? "is-danger" : ""}`}
          title={confirming ? "再点确认删除" : "删除"}
          onClick={onDelete}
        >
          {confirming ? <Icon.Check size={13} /> : <Icon.Trash size={13} />}
        </button>
      </div>
    </div>
  );
}

// 单个分组内默认显示的会话条数上限。超过则默认只显示前 N 条,底部挂「展开显示」按钮。
const DEFAULT_VISIBLE_SESSIONS = 5;

// 分组会话列表:超过 DEFAULT_VISIBLE_SESSIONS 条时默认只显示前 N 条,底部「展开显示 (剩余数)」
// 按钮展开全部,展开后按钮变「折叠显示」。避免会话多的项目把侧栏撑高、把其它项目/分组挤下去。
// 展开态是各列表实例本地态(项目折叠/无项目分组各自独立),分组整体折叠时组件卸载即自然重置。
export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onToast,
}: {
  sessions: SessionMeta[];
  activeSessionId: string | undefined;
  onSelect: (id: string) => void;
  onToast: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const overflow = sessions.length > DEFAULT_VISIBLE_SESSIONS;
  const visible = expanded || !overflow ? sessions : sessions.slice(0, DEFAULT_VISIBLE_SESSIONS);
  return (
    <>
      {visible.map((sess) => (
        <SessionRow
          key={sess.id}
          session={sess}
          active={sess.id === activeSessionId}
          onSelect={() => onSelect(sess.id)}
          onToast={onToast}
        />
      ))}
      {overflow ? (
        <button className="pw-session-more" data-collapsed={!expanded} onClick={() => setExpanded((v) => !v)}>
          <span className="chev">
            <Icon.Chevron size={10} />
          </span>
          <span>{expanded ? "折叠显示" : `展开显示 (${sessions.length - DEFAULT_VISIBLE_SESSIONS})`}</span>
        </button>
      ) : null}
    </>
  );
}

function ProjectSwitchRow({
  project,
  archived,
  editors,
  onOpen,
  onToast,
}: {
  project: ProjectMeta;
  archived: boolean;
  editors: EditorInfo[];
  onOpen: () => void;
  onToast: (text: string) => void;
}) {
  const createSession = usePersonalStore((s) => s.createSession);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAnchor({ x: rect.right, y: rect.bottom + 4 });
  };

  return (
    <div className="pw-project-switch-row" data-archived={archived}>
      <button className="pw-project-switch-main" onClick={onOpen} title={project.path}>
        <Icon.Folder size={14} />
        <span>{project.name}</span>
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
            createSession(project.id, resolveDefaultAgent({ generalSettings, agentsAvailable }));
            onToast(`已在 ${project.name} 新建 Session`);
          }}
        >
          <Icon.Plus size={13} />
        </button>
      </div>
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

export function PersonalSidebar({
  onToast,
  onOpenFlashNote,
  onOpenProjectsWindow,
}: {
  onToast: (text: string) => void;
  // 闪记浮层入口(壳注入 window.desktopAPI.notesOverlay.show;web/旧壳缺省 → 隐藏入口)。
  onOpenFlashNote?: () => void;
  // 「项目管理」独立窗口入口(壳注入 window.desktopAPI.projectsWindow.open;web/旧壳缺省 → 隐藏入口)。
  onOpenProjectsWindow?: () => void;
}) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const addProject = usePersonalStore((s) => s.addProject);
  const openHome = usePersonalStore((s) => s.openHome);
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const openAutomation = usePersonalStore((s) => s.openAutomation);
  // loop 工作流视图状态（bridge.workflowList 有值时才渲染入口，web 端 bridge 为 null 自动降级）。
  const workflowOpen = usePersonalStore((s) => s.workflowOpen);
  const openWorkflow = usePersonalStore((s) => s.openWorkflow);
  // 设计工作台(AI 设计画布);desktop-only,bridge 为 null(web 端)自动降级隐藏。
  const designOpen = usePersonalStore((s) => s.designOpen);
  const openDesign = usePersonalStore((s) => s.openDesign);
  // 写作工作区(整窗覆盖层);desktop-only,bridge 为 null(web 端)自动降级隐藏。
  const writingOpen = usePersonalStore((s) => s.writingOpen);
  const openWriting = usePersonalStore((s) => s.openWriting);
  const sessions = usePersonalStore((s) => s.sessions);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const createSession = usePersonalStore((s) => s.createSession);
  const activateProject = usePersonalStore((s) => s.activateProject);
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const setRightView = usePersonalStore((s) => s.setRightView);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);

  // 系统已装编辑器（挂载时探测一次,传给所有 ProjectMenu）。
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  // 「已归档」分组折叠态（本地,默认折叠）。
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [revealedArchiveProjectId, setRevealedArchiveProjectId] = useState<string>();

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

  // 「无项目」会话:无 projectId 且未归档,按 updatedAt 降序。
  const noProjectSessions = sessions
    .filter((s) => !s.projectId && s.archivedAt == null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const contextProjectId = activeSession ? activeSession.projectId : activeProjectId;
  const contextProject = projects.find((project) => project.id === contextProjectId);
  const contextIsNoProject = Boolean(activeSession && !activeSession.projectId);
  const contextSessions = sessions
    .filter((session) => {
      if (session.archivedAt != null) return false;
      if (contextProject) return session.projectId === contextProject.id;
      return contextIsNoProject && !session.projectId;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const contextArchivedSessions = contextProject
    ? sessions
        .filter((session) => session.projectId === contextProject.id && session.archivedAt != null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
    : [];
  const showContextArchived = contextProject?.id === revealedArchiveProjectId;
  const projectChoices = visible.filter((project) => project.id !== contextProject?.id);
  const archivedChoices = archived.filter((project) => project.id !== contextProject?.id);
  const defaultAgent = resolveDefaultAgent({ generalSettings, agentsAvailable });
  const conversationModeOpen = !writingOpen && !designOpen && !automationOpen && !workflowOpen && !settingsOpen;

  const createContextSession = () => {
    createSession(contextProject?.id, defaultAgent);
    onToast(contextProject ? `已在 ${contextProject.name} 新建 Session` : "已新建无项目 Session");
  };

  const openProject = (project: ProjectMeta) => {
    const latest = sessions
      .filter((session) => session.projectId === project.id && session.archivedAt == null)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) {
      setActiveSession(latest.id);
      return;
    }
    activateProject(project.id);
    setRightView("todos");
    setRightOpen(true);
  };

  const pickProject = async () => {
    if (!bridge) return;
    const path = await bridge.pickDirectory();
    if (!path) return;
    const proj = addProject(path);
    onToast(`已添加项目 ${proj.name}`);
  };

  return (
    <aside className="sidebar">
      {/* 左栏顶部头:三栏各自顶天后承担窗口拖拽区,并为 macOS 红绿灯预留左侧空间。
          红绿灯右侧放「折叠侧栏 / 搜索会话」控制。 */}
      <div className="pw-col-head pw-sidebar-head">
        <SidebarLeftControls />
      </div>
      <div className="pw-sidebar-modes" aria-label="工作模式">
        <button className={conversationModeOpen ? "is-active" : ""} onClick={openHome} aria-pressed={conversationModeOpen}>
          会话
        </button>
        {bridge ? (
          <button className={writingOpen ? "is-active" : ""} onClick={openWriting} aria-pressed={writingOpen}>
            写作
          </button>
        ) : null}
        {bridge ? (
          <button className={designOpen ? "is-active" : ""} onClick={() => openDesign()} aria-pressed={designOpen}>
            设计
          </button>
        ) : null}
      </div>

      <section className="pw-context-card" aria-label="当前项目">
        <div className="pw-context-card-title">
          {contextProject ? <Icon.Folder size={15} /> : <Icon.File size={15} />}
          <strong>{contextProject?.name ?? (contextIsNoProject ? "无项目会话" : "选择一个项目开始")}</strong>
          {contextProject ? <span>当前项目</span> : null}
          {contextProject && contextArchivedSessions.length > 0 ? (
            <button
              className={`pw-icon-btn pw-context-card-menu ${showContextArchived ? "is-active" : ""}`}
              title={showContextArchived ? "隐藏已归档会话" : `显示已归档会话 (${contextArchivedSessions.length})`}
              onClick={() => setRevealedArchiveProjectId(showContextArchived ? undefined : contextProject.id)}
            >
              <Icon.File size={13} />
            </button>
          ) : null}
          {contextProject ? (
            <button
              className={`pw-icon-btn pw-context-card-menu ${contextMenuAnchor ? "is-active" : ""}`}
              title="更多项目操作"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setContextMenuAnchor({ x: rect.right, y: rect.bottom + 4 });
              }}
            >
              <Icon.More size={13} />
            </button>
          ) : null}
        </div>
        <div className="pw-context-card-actions">
          <button className="is-primary" onClick={createContextSession}>
            <Icon.Plus size={13} />
            <span>新建会话</span>
          </button>
          {bridge?.tasksListProjects && onOpenProjectsWindow ? (
            <button
              className="pw-projects-entry"
              onClick={onOpenProjectsWindow}
              title="项目管理（独立窗口：项目树 / 任务清单 / 详情）"
            >
              <Icon.Folder size={13} />
              <span>项目管理</span>
            </button>
          ) : null}
        </div>
        {contextProject && contextMenuAnchor ? (
          <ProjectMenu
            project={contextProject}
            archived={contextProject.archivedAt != null}
            editors={editors}
            anchor={contextMenuAnchor}
            onClose={() => setContextMenuAnchor(null)}
            onToast={onToast}
          />
        ) : null}
      </section>

      <div className="pw-sidebar-scroll">
        <section className="pw-context-sessions">
          <div className="pw-section-h">
            <span>{contextIsNoProject ? "无项目会话" : "当前项目会话"}</span>
          </div>
          {contextSessions.length > 0 ? (
            <SessionList
              sessions={contextSessions}
              activeSessionId={activeSessionId}
              onSelect={setActiveSession}
              onToast={onToast}
            />
          ) : (
            <button className="pw-context-empty" onClick={createContextSession}>
              <Icon.Plus size={12} />
              <span>新建第一条会话</span>
            </button>
          )}
          {showContextArchived
            ? contextArchivedSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  onSelect={() => setActiveSession(session.id)}
                  onToast={onToast}
                />
              ))
            : null}
        </section>

        <section className="pw-project-switcher">
          <div className="pw-section-h">
            <span>切换项目</span>
            <button className="pw-icon-btn" title="添加项目（选择本地文件夹）" onClick={pickProject} disabled={!bridge}>
              <Icon.FolderPlus size={14} />
            </button>
          </div>
          {projectChoices.map((project) => (
            <ProjectSwitchRow
              key={project.id}
              project={project}
              archived={false}
              editors={editors}
              onOpen={() => openProject(project)}
              onToast={onToast}
            />
          ))}
          {noProjectSessions.length > 0 && !contextIsNoProject ? (
            <button
              className="pw-project-switch-main pw-no-project-switch"
              onClick={() => setActiveSession(noProjectSessions[0]!.id)}
            >
              <Icon.File size={14} />
              <span>无项目</span>
              <small>{noProjectSessions.length}</small>
            </button>
          ) : null}
          {projectChoices.length === 0 && noProjectSessions.length === 0 && archivedChoices.length === 0 ? (
            <div className="pw-project-switch-empty">暂无其他项目</div>
          ) : null}
          {archivedChoices.length > 0 ? (
            <div className="pw-archived-group">
              <button
                className="pw-archived-h"
                data-collapsed={!archivedOpen}
                onClick={() => setArchivedOpen((value) => !value)}
              >
                <span className="chev">
                  <Icon.Chevron size={10} />
                </span>
                <span>已归档 ({archivedChoices.length})</span>
              </button>
              {archivedOpen
                ? archivedChoices.map((project) => (
                    <ProjectSwitchRow
                      key={project.id}
                      project={project}
                      archived
                      editors={editors}
                      onOpen={() => openProject(project)}
                      onToast={onToast}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </section>
      </div>

      <div className="pw-sidebar-shortcuts" aria-label="快捷入口">
        {onOpenFlashNote ? (
          <button className="pw-sidebar-shortcut" onClick={onOpenFlashNote} aria-label="闪记">
            <Icon.Pin size={15} />
            <span>闪记</span>
          </button>
        ) : null}
        {bridge?.automationList ? (
          <button
            className={`pw-sidebar-shortcut ${automationOpen ? "is-active" : ""}`}
            onClick={openAutomation}
            aria-label="自动化"
          >
            <Icon.Workflow size={15} />
            <span>自动化</span>
          </button>
        ) : null}
        {bridge?.workflowList ? (
          <button
            className={`pw-sidebar-shortcut ${workflowOpen ? "is-active" : ""}`}
            onClick={openWorkflow}
            aria-label="Loop"
          >
            <Icon.GitBranch size={15} />
            <span>Loop</span>
          </button>
        ) : null}
        <SettingsMenu variant="shortcut" />
      </div>
    </aside>
  );
}
