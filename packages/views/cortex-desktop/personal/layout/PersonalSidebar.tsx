// 个人工作区左栏：项目树（本地文件夹）——点项目展开/收起其下对话，当前对话所在分组自动展开。
// 项目行悬停浮现「⋯」菜单 + 「新建 Session」按钮;置顶项目名旁常驻 Pin 标识;
// 已归档项目收进底部可折叠分组。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  dayKey,
  resolveDefaultAgent,
  partitionProjects,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { EditorInfo, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { ProjectMenu } from "../projects/ProjectMenu";
import { SidebarLeftControls } from "./SidebarControls";
import { SidebarModeMenu } from "./SidebarModeMenu";
import { NotificationBell, useNotificationCenter } from "./NotificationBell";
import { SidebarActivityView, usePrioritySessionIds } from "./SidebarActivityView";
import { detectIsMac } from "../shared/platform";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { SidebarUserBar } from "./SidebarUserBar";
import { relTime } from "./relTime";
import { SessionRow } from "./SessionRow";

// relTime 已抽到 ./relTime（侧栏底部的 NotificationBell 也要用，留在这里会与它循环依赖）。
// import + export 两句都要：本文件的会话行自己也调它，光 re-export 不会引入本模块作用域。
// 保留 export：闪记 / 任务 / 归档会话等六处既有 import 路径不必改动。
export { relTime };

// 单个分组内默认显示的会话条数上限。超过则默认只显示前 N 条,底部挂「展开显示」按钮。
const DEFAULT_VISIBLE_SESSIONS = 5;
// 「项目」分组默认露出的项目行数(清爽化改版:项目列表不再长期全量展开,超出收进「全部项目」)。
const DEFAULT_VISIBLE_PROJECTS = 5;

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

// 项目行(树节点):点击展开/收起其下对话;悬停浮现「⋯」菜单与「新建对话」。
function ProjectSwitchRow({
  project,
  archived,
  editors,
  expanded,
  onToggle,
  onToast,
}: {
  project: ProjectMeta;
  archived: boolean;
  editors: EditorInfo[];
  expanded: boolean;
  onToggle: () => void;
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
      <button className="pw-project-switch-main" onClick={onToggle} title={project.path} aria-expanded={expanded}>
        {expanded ? <Icon.FolderOpen size={16} /> : <Icon.Folder size={16} />}
        <span>{project.name}</span>
        {project.pinnedAt ? <Icon.Pushpin size={12} className="pw-project-pin" /> : null}
      </button>
      <div className={`pw-project-actions ${menuAnchor ? "is-menu-open" : ""}`}>
        <button className={`pw-icon-btn ${menuAnchor ? "is-active" : ""}`} title="更多" onClick={openMenu}>
          <Icon.More size={13} />
        </button>
        <button
          className="pw-icon-btn"
          title="新建对话"
          onClick={() => {
            createSession(project.id, resolveDefaultAgent({ generalSettings, agentsAvailable }));
            onToast(`已在 ${project.name} 新建对话`);
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

// 项目树展开后的子节点:该项目(或无项目)的未归档对话;没有对话时给一条「新建第一条对话」。
// 侧栏刻意不显示已归档对话(用户要求),已归档对话在 设置 → 已归档 里查看 / 恢复。
function ProjectTreeChildren({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onToast,
}: {
  sessions: SessionMeta[];
  activeSessionId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onToast: (text: string) => void;
}) {
  return (
    <div className="pw-project-tree-children">
      {sessions.length > 0 ? (
        <SessionList sessions={sessions} activeSessionId={activeSessionId} onSelect={onSelect} onToast={onToast} />
      ) : (
        <button className="pw-context-empty" onClick={onCreate}>
          <Icon.Plus size={12} />
          <span>新建第一条对话</span>
        </button>
      )}
    </div>
  );
}

// 无项目分组在展开态集合里的 key(项目 id 不会与之冲突)。
const NO_PROJECT_KEY = "__no-project__";

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
  // 自动化 / Loop 入口放在滚动区顶部(对齐 ChatGPT「图像 / 定时任务」行);「是否打开」同时
  // 参与下面 conversationModeOpen 的互斥判定。设置仍在 SidebarUserBar 的头像菜单。
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const openAutomation = usePersonalStore((s) => s.openAutomation);
  const workflowOpen = usePersonalStore((s) => s.workflowOpen);
  const openWorkflow = usePersonalStore((s) => s.openWorkflow);
  // 写作工作区(整窗覆盖层);desktop-only,bridge 为 null(web 端)自动降级隐藏。
  const writingOpen = usePersonalStore((s) => s.writingOpen);
  const openWriting = usePersonalStore((s) => s.openWriting);
  const setSessionSearchOpen = useCortexUIStore((s) => s.setSessionSearchOpen);
  const sessions = usePersonalStore((s) => s.sessions);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const createSession = usePersonalStore((s) => s.createSession);
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const generalSettings = usePersonalStore((s) => s.generalSettings);

  // 系统已装编辑器（挂载时探测一次,传给所有 ProjectMenu）。
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  // 「已归档」分组折叠态（本地,默认折叠）。
  const [archivedOpen, setArchivedOpen] = useState(false);
  // 「项目」分组展开态(默认只露前 DEFAULT_VISIBLE_PROJECTS 行)。
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  // 活动视图(铃铛切换):打开时侧栏正文换成按活动排序的扁平列表,见 SidebarActivityView。
  const [activityOpen, setActivityOpen] = useState(false);
  const notifications = useNotificationCenter();
  const priorityIds = usePrioritySessionIds(sessions);
  // 打开活动视图即视为看到了消息:把未读消息标已读(与原 popover「展开即已读」一致)。
  const { unread: unreadNotifications, markRead: markNotificationsRead } = notifications;
  useEffect(() => {
    if (activityOpen && unreadNotifications > 0) markNotificationsRead();
  }, [activityOpen, unreadNotifications, markNotificationsRead]);
  // ⌥⌘U(Win/Linux ⌥Ctrl+U)切换活动视图,对齐 Codex。按 e.code 判断:mac 上按住 ⌥ 时 e.key 会变成特殊字符。
  useEffect(() => {
    const isMac = detectIsMac();
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || !e.altKey || e.shiftKey || e.code !== "KeyU" || e.repeat) return;
      e.preventDefault();
      setActivityOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 项目树展开态(项目 id / NO_PROJECT_KEY)。当前上下文所在分组会被自动展开(见下方 effect)。
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

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
    .filter((s) => s.relation !== "side" && !s.projectId && s.archivedAt == null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const contextProjectId = activeSession ? activeSession.projectId : activeProjectId;
  const contextProject = projects.find((project) => project.id === contextProjectId);
  // 删除当前无项目会话后 activeSession 会清空；只要仍有无项目会话且没有选中项目，
  // 就继续展示无项目列表，而不是退回「选择一个项目开始」。
  const contextIsNoProject = activeSession
    ? !activeSession.projectId
    : !activeProjectId && noProjectSessions.length > 0;
  // 「置顶」分区只放置顶**对话**(用户明确:不把项目搬进来),并从下方项目树里移除,不重复出现。
  // 置顶项目仍留在「项目」列表,由 partitionProjects 排在最前,名字旁带图钉标记。
  const pinnedSessions = sessions
    .filter((s) => s.relation !== "side" && s.archivedAt == null && s.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const treeProjects = visible;
  // 某项目下的未归档、未置顶对话,按时间倒序。side 关系的子会话、已归档对话都不进侧栏。
  const projectSessions = (projectId: string) =>
    sessions
      .filter(
        (s) => s.relation !== "side" && s.projectId === projectId && s.archivedAt == null && s.pinnedAt == null,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  const noProjectTreeSessions = noProjectSessions.filter((s) => s.pinnedAt == null);
  // 默认只露前 N 个项目,其余收进「全部项目」展开钮;当前上下文项目若排在 N 之后也补进来,
  // 否则用户正在用的项目会被折叠藏起来。
  const visibleProjectChoices = projectsExpanded
    ? treeProjects
    : [
        ...treeProjects.slice(0, DEFAULT_VISIBLE_PROJECTS),
        ...treeProjects.slice(DEFAULT_VISIBLE_PROJECTS).filter((p) => p.id === contextProject?.id),
      ];
  const hiddenProjectCount = treeProjects.length - visibleProjectChoices.length;
  const defaultAgent = resolveDefaultAgent({ generalSettings, agentsAvailable });

  // 当前上下文(活动对话所属项目 / 无项目)切换时自动展开对应分组,让用户一眼看到正在用的对话。
  // 只「加」不「删」:用户手动收起别的分组不受影响;手动收起当前分组后,只有上下文再次变化才会重新展开。
  const contextGroupKey = contextProject ? contextProject.id : contextIsNoProject ? NO_PROJECT_KEY : undefined;
  useEffect(() => {
    if (!contextGroupKey) return;
    setExpandedGroups((prev) => (prev.has(contextGroupKey) ? prev : new Set(prev).add(contextGroupKey)));
  }, [contextGroupKey]);
  // 深度研究**不再是左栏模式**：它已改为会话内的 `/skill:research`，进度与报告在会话右栏。
  // 门控与入口都收敛到 useSlashCommands 的 useResearchSkillAvailable + 落地页 skill chip，
  // 这里不该再留任何研究相关的读取。
  const conversationModeOpen =
    !writingOpen && !automationOpen && !workflowOpen && !settingsOpen;

  // 新建会话。**无项目会话必须带上 noProjectDir**——它就是 agent 进程的 cwd:
  // 漏了的话渲染端算出的 cwd 是空串,spawn 便继承 Electron 自己的工作目录,dev 下 agent 产物
  // 直接写进 apps/desktop/(用户实测:合同审查报告落到了程序目录)。口径与落地页那条创建路径
  //(NewSessionLanding 的「不使用项目」分支)保持一致:当天一个目录。
  const createContextSession = () => {
    if (contextProject) {
      createSession(contextProject.id, defaultAgent);
      onToast(`已在 ${contextProject.name} 新建 Session`);
      return;
    }
    void (async () => {
      // 桥缺 ensureNoProjectDir(Web / 旧壳)时仍建会话,只是没有固定工作目录——
      // 与落地页不同,侧栏这颗按钮是用户唯一的新建入口,不能因为缺个能力就整个不给建。
      const dir = bridge?.ensureNoProjectDir ? await bridge.ensureNoProjectDir(dayKey(Date.now())) : undefined;
      createSession(undefined, defaultAgent, undefined, dir ? { noProjectDir: dir } : undefined);
      onToast("已新建无项目 Session");
    })();
  };

  // 切换某分组的展开 / 收起(纯本地 UI 态,不改变当前对话)。
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // 在指定项目下新建对话(展开后空项目的「新建第一条对话」用)。
  const createInProject = (project: ProjectMeta) => {
    createSession(project.id, defaultAgent);
    onToast(`已在 ${project.name} 新建对话`);
  };
  // 渲染一个项目树节点:项目行 + 展开后的对话。已归档项目组复用同一渲染。
  const renderProjectNode = (project: ProjectMeta, isArchived: boolean) => {
    const open = expandedGroups.has(project.id);
    return (
      <div key={project.id} className="pw-project-tree-node">
        <ProjectSwitchRow
          project={project}
          archived={isArchived}
          editors={editors}
          expanded={open}
          onToggle={() => toggleGroup(project.id)}
          onToast={onToast}
        />
        {open ? (
          <ProjectTreeChildren
            sessions={projectSessions(project.id)}
            activeSessionId={activeSessionId}
            onSelect={setActiveSession}
            onCreate={() => createInProject(project)}
            onToast={onToast}
          />
        ) : null}
      </div>
    );
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
          红绿灯右侧只留「折叠侧栏」;搜索挪到下方模式行右侧(对齐 ChatGPT 侧栏)。 */}
      <div className="pw-col-head pw-sidebar-head">
        <SidebarLeftControls showSearch={false} />
        <div className="spacer" />
      </div>
      {/* 「团队工作区 / 个人工作区」切换（feat/team-server-workspace）:此前只在无桥 web
          回落分支渲染,桌面端没有可见入口——挂在模式行上方,两侧工作区互达。 */}
      <WorkspaceTabs />
      {/* 模式行(对齐 ChatGPT「ChatGPT ▾ …… 搜索 / 铃铛」):左侧 对话/写作 下拉,右侧搜索会话 + 消息铃铛。
          铃铛原在底部用户行,挪到这里后弹层改为向下展开(见 .pw-sb-msgs)。 */}
      <div className="pw-sidebar-modes" aria-label="工作模式">
        <SidebarModeMenu
          modes={[
            { key: "chat", label: "对话", active: conversationModeOpen, onSelect: openHome },
            ...(bridge ? [{ key: "writing", label: "写作", active: writingOpen, onSelect: openWriting }] : []),
          ]}
        />
        <div className="spacer" />
        <button
          className="icon-btn"
          title="搜索对话"
          aria-label="搜索对话"
          onClick={() => setSessionSearchOpen(true)}
        >
          <Icon.Search />
        </button>
        <NotificationBell
          active={activityOpen}
          badge={notifications.unread + priorityIds.size}
          onToggle={() => setActivityOpen((v) => !v)}
        />
      </div>
      {/* 新对话入口(对齐 ChatGPT「新对话」整行):按当前上下文新建——在当前项目下,或无项目会话。 */}
      <button type="button" className="pw-sidebar-new" onClick={createContextSession}>
        <Icon.Edit size={16} />
        <span>新对话</span>
      </button>

      <div className="pw-sidebar-scroll">
        {/* 功能入口(闪记 / 自动化 / Loop):放在滚动区内,随会话列表一起滚走,不占固定高度。
            降级规则:壳没注入 onOpenFlashNote / bridge 缺 automationList、workflowList(web 或旧壳)时
            对应行直接不渲染,而不是渲染一个点了没反应的入口。 */}
        <nav className="pw-sidebar-nav" aria-label="功能入口">
          {onOpenFlashNote ? (
            <button type="button" className="pw-sidebar-new" onClick={onOpenFlashNote}>
              <Icon.Pin size={16} />
              <span>闪记</span>
            </button>
          ) : null}
          {bridge?.workflowList ? (
            <button
              type="button"
              className={`pw-sidebar-new ${workflowOpen ? "is-active" : ""}`}
              aria-current={workflowOpen ? "page" : undefined}
              onClick={openWorkflow}
            >
              <Icon.GitBranch size={16} />
              <span>Loop</span>
            </button>
          ) : null}
          {bridge?.automationList ? (
            <button
              type="button"
              className={`pw-sidebar-new ${automationOpen ? "is-active" : ""}`}
              aria-current={automationOpen ? "page" : undefined}
              onClick={openAutomation}
            >
              <Icon.Workflow size={16} />
              <span>自动化</span>
            </button>
          ) : null}
        </nav>
        {activityOpen ? (
          <SidebarActivityView
            sessions={sessions}
            projects={projects}
            priorityIds={priorityIds}
            activeSessionId={activeSessionId}
            onSelect={setActiveSession}
            onToast={onToast}
            notifications={notifications.items}
            onClearNotifications={notifications.clear}
          />
        ) : (
          <>
            {pinnedSessions.length > 0 ? (
              <section className="pw-pinned-section" aria-label="置顶">
                <div className="pw-section-h">
                  <span>置顶</span>
                </div>
                {pinnedSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    onSelect={() => setActiveSession(session.id)}
                    onToast={onToast}
                    variant="pinned"
                  />
                ))}
              </section>
            ) : null}
            {/* 项目树(对齐 Codex 侧栏):点项目展开 / 收起其下对话;当前对话所在分组自动展开。
                原「当前项目」顶部分组已并入这棵树,项目不再被单拎出来、也不会在列表里消失。 */}
            <section className="pw-project-switcher">
              <div className="pw-section-h">
                <span>项目</span>
                {/* 清爽化改版:原卡片里的「项目管理」文字按钮收进分组标题右侧的图标入口 */}
                {bridge?.tasksListProjects && onOpenProjectsWindow ? (
                  <button
                    className="pw-icon-btn"
                    title="项目管理（独立窗口：项目树 / 任务清单 / 详情）"
                    onClick={onOpenProjectsWindow}
                  >
                    <Icon.Folder size={14} />
                  </button>
                ) : null}
                <button className="pw-icon-btn" title="添加项目（选择本地文件夹）" onClick={pickProject} disabled={!bridge}>
                  <Icon.FolderPlus size={14} />
                </button>
              </div>
              {visibleProjectChoices.map((project) => renderProjectNode(project, false))}
              {treeProjects.length > DEFAULT_VISIBLE_PROJECTS ? (
                <button
                  className="pw-session-more"
                  data-collapsed={!projectsExpanded}
                  onClick={() => setProjectsExpanded((v) => !v)}
                >
                  <span className="chev">
                    <Icon.Chevron size={10} />
                  </span>
                  <span>{projectsExpanded ? "折叠项目" : `全部项目 (${hiddenProjectCount})`}</span>
                </button>
              ) : null}
              {noProjectTreeSessions.length > 0 || contextIsNoProject ? (
                <div className="pw-project-tree-node">
                  <button
                    className="pw-project-switch-main pw-no-project-switch"
                    aria-expanded={expandedGroups.has(NO_PROJECT_KEY)}
                    onClick={() => toggleGroup(NO_PROJECT_KEY)}
                  >
                    <Icon.File size={16} />
                    <span>无项目</span>
                    <small>{noProjectTreeSessions.length}</small>
                  </button>
                  {expandedGroups.has(NO_PROJECT_KEY) ? (
                    <ProjectTreeChildren
                      sessions={noProjectTreeSessions}
                      activeSessionId={activeSessionId}
                      onSelect={setActiveSession}
                      onCreate={createContextSession}
                      onToast={onToast}
                    />
                  ) : null}
                </div>
              ) : null}
              {treeProjects.length === 0 && noProjectTreeSessions.length === 0 && archived.length === 0 ? (
                <div className="pw-project-switch-empty">暂无项目</div>
              ) : null}
              {archived.length > 0 ? (
                <div className="pw-archived-group">
                  <button
                    className="pw-archived-h"
                    data-collapsed={!archivedOpen}
                    onClick={() => setArchivedOpen((value) => !value)}
                  >
                    <span className="chev">
                      <Icon.Chevron size={10} />
                    </span>
                    <span>已归档 ({archived.length})</span>
                  </button>
                  {archivedOpen ? archived.map((project) => renderProjectNode(project, true)) : null}
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>

      {/* 底部用户行：显示宠物 / 设置 收在头像菜单;闪记 / 自动化 / Loop 已移到滚动区顶部。 */}
      <SidebarUserBar />
    </aside>
  );
}
