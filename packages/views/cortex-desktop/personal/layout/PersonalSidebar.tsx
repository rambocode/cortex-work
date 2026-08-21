// 个人工作区左栏：项目列表（本地文件夹），项目可折叠、下挂 session 列表。
// 项目行悬停浮现「⋯」菜单 + 「新建 Session」按钮;置顶项目名旁常驻 Pin 标识;
// 已归档项目收进底部可折叠分组。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  closePiSession,
  dayKey,
  discardSessionChat,
  resolveDefaultAgent,
  partitionProjects,
  reapSessionRun,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { EditorInfo, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { ProjectMenu } from "../projects/ProjectMenu";
import { SidebarLeftControls } from "./SidebarControls";
import { SidebarUserBar } from "./SidebarUserBar";
import { relTime } from "./relTime";
import { SESSION_DRAG_MIME } from "./conversation-drag";

// relTime 已抽到 ./relTime（侧栏底部的 NotificationBell 也要用，留在这里会与它循环依赖）。
// import + export 两句都要：本文件的会话行自己也调它，光 re-export 不会引入本模块作用域。
// 保留 export：闪记 / 任务 / 归档会话等六处既有 import 路径不必改动。
export { relTime };

// 会话行:悬停在右侧浮现「重命名」+「归档/取消归档」+「删除」图标按钮。
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
  const renameSession = usePersonalStore((s) => s.renameSession);
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const archived = session.archivedAt != null;

  // 会话运行状态徽标三态派生:等待确认 > 正在运行 > 已结束(仅非活跃行)。
  // 三个 selector 均返回布尔/store 内稳定引用——96+ 会话时避免整 map/数组订阅引发全列表重渲。
  // 「等确认」谓词与 PiToolConfirmDialog(confirm)/AskQuestionCard(askquestion)一致,
  // jsrepl/select/input 等不弹 UI 的 method 天然排除;delegate 子会话审批已映射到父会话 uiSessionId。
  const awaitingConfirm = usePersonalStore((s) =>
    s.piUiPending.some(
      (p) =>
        p.uiSessionId === session.id &&
        (p.request.method === "confirm" || p.request.method === "askquestion"),
    ),
  );
  const running = usePersonalStore((s) => Boolean(s.runningBySession[session.id]));
  const outcome = usePersonalStore((s) => s.runOutcomeBySession[session.id]);
  // 读侧 !active 与写侧 markRunOutcome 的 active 守卫、setActiveSession 清除构成三道保险。
  const status = awaitingConfirm
    ? ("confirm" as const)
    : running
      ? ("running" as const)
      : !active && outcome
        ? outcome.ok
          ? ("ok" as const)
          : ("fail" as const)
        : null;
  const statusLabel =
    status === "confirm"
      ? "等待确认"
      : status === "running"
        ? "正在运行"
        : status === "ok"
          ? `已完成 · ${relTime(outcome?.endedAt ?? Date.now())}`
          : status === "fail"
            ? `已失败 · ${relTime(outcome?.endedAt ?? Date.now())}`
            : undefined;

  const commitRename = () => {
    if (renameDraft === null) return;
    renameSession(session.id, renameDraft);
    setRenameDraft(null);
  };

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
    const removedIds = removeSession(session.id); // 即时移除 UI，并级联取回 side 子会话 id。
    for (const sessionId of removedIds) {
      reapSessionRun(qc, sessionId); // 回收 renderer run(停看门狗/清 running),防孤儿 interval
      discardSessionChat(qc, sessionId); // 取消 reap 排出的节流保存，防 chat:delete 后旧缓存复活磁盘文件。
      void bridge?.deleteChat?.(sessionId); // 物理删父/子会话磁盘消息文件
      void closePiSession(bridge, sessionId); // 终止对应 pi 长驻进程（非 pi 会话 no-op）
    }
    onToast(`已删除 ${session.title}`);
  };

  return (
    <div
      className="pw-session-row"
      data-archived={archived}
      onMouseLeave={() => setConfirming(false)}
    >
      {renameDraft !== null ? (
        <div className={`pw-session pw-session-rename ${active ? "is-active" : ""}`}>
          <input
            autoFocus
            className="pw-session-rename-input"
            aria-label="会话名称"
            value={renameDraft}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenameDraft(null);
              }
            }}
          />
        </div>
      ) : (
        <button
          className={`pw-session ${active ? "is-active" : ""}`}
          draggable
          title="拖到会话窗格的上、下、左、右以拆分"
          onClick={onSelect}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(SESSION_DRAG_MIME, session.id);
          }}
        >
          {status === "confirm" ? (
            // 等确认点绝对定位于标题左侧 26px 缩进空白区,不挤压标题、不受 hover 时间隐藏规则影响。
            <span
              className="pw-session-status is-confirm"
              data-status="confirm"
              title={statusLabel}
              aria-label={statusLabel}
            />
          ) : null}
          <span className="pw-session-title">{session.title}</span>
          {status === "running" ? (
            // 运行中 loading 环占用右侧时间位(运行中相对时间无意义,hover 让位规则与时间同款)。
            <span
              className="pw-session-status is-running"
              data-status="running"
              title={statusLabel}
              aria-label={statusLabel}
            />
          ) : status === "ok" || status === "fail" ? (
            // 已结束成功/失败 icon 同样占右侧时间位;endedAt 详情在 title tooltip 里。
            <span
              className={`pw-session-status is-${status}`}
              data-status={status}
              title={statusLabel}
              aria-label={statusLabel}
            >
              {status === "ok" ? <Icon.CheckCircle size={12} /> : <Icon.XCircle size={12} />}
            </span>
          ) : (
            <span className="pw-session-time">{relTime(session.updatedAt)}</span>
          )}
        </button>
      )}
      {renameDraft === null ? (
        <div className="pw-session-actions">
          <button
            className="pw-icon-btn pw-session-act"
            title="重命名"
            aria-label={`重命名 ${session.title}`}
            onClick={(event) => {
              event.stopPropagation();
              setRenameDraft(session.title);
            }}
          >
            <Icon.Edit size={13} />
          </button>
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
      ) : null}
    </div>
  );
}

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
  // 自动化 / Loop / 设置的**打开动作**已移到 SidebarUserBar 的头像菜单；
  // 这里只留「是否打开」的读取，它们参与下面 conversationModeOpen 的互斥判定。
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const workflowOpen = usePersonalStore((s) => s.workflowOpen);
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
  // 「项目」分组展开态(默认只露前 DEFAULT_VISIBLE_PROJECTS 行)。
  const [projectsExpanded, setProjectsExpanded] = useState(false);
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
  const contextSessions = sessions
    .filter((session) => {
      if (session.archivedAt != null) return false;
      if (session.relation === "side") return false;
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
  // 默认只露前 N 个项目,其余收进「全部项目」展开钮(与会话列表的「展开显示」同款交互)。
  const visibleProjectChoices = projectsExpanded
    ? projectChoices
    : projectChoices.slice(0, DEFAULT_VISIBLE_PROJECTS);
  const archivedChoices = archived.filter((project) => project.id !== contextProject?.id);
  const defaultAgent = resolveDefaultAgent({ generalSettings, agentsAvailable });
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

  const openProject = (project: ProjectMeta) => {
    const latest = sessions
      .filter((session) => session.relation !== "side" && session.projectId === project.id && session.archivedAt == null)
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
          红绿灯右侧放「折叠侧栏 / 搜索会话」控制;右端是「新建会话」(清爽化改版:
          原「当前项目」卡片里的大 primary 按钮降级为这颗顶部图标钮,语义不变——按当前上下文新建)。 */}
      <div className="pw-col-head pw-sidebar-head">
        <SidebarLeftControls />
        <div className="spacer" />
        <button className="icon-btn" title="新建会话" aria-label="新建会话" onClick={createContextSession}>
          <Icon.Plus />
        </button>
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
      </div>

      <div className="pw-sidebar-scroll">
        {/* 清爽化改版:原「当前项目」嵌套卡片(pw-context-card)拆除——上下文名直接做分组标题,
            归档切换/项目菜单收进标题行右侧,消灭「无项目会话」标签出现两次的重复。 */}
        <section className="pw-context-sessions">
          <div className="pw-section-h">
            {/* 标题避免用裸「会话」:与顶部模式 tab 文案撞车(a11y/测试 getByText 会歧义) */}
            <span>{contextProject?.name ?? (contextIsNoProject ? "无项目会话" : "最近")}</span>
            {contextProject && contextArchivedSessions.length > 0 ? (
              <button
                className={`pw-icon-btn ${showContextArchived ? "is-active" : ""}`}
                title={showContextArchived ? "隐藏已归档会话" : `显示已归档会话 (${contextArchivedSessions.length})`}
                onClick={() => setRevealedArchiveProjectId(showContextArchived ? undefined : contextProject.id)}
              >
                <Icon.File size={13} />
              </button>
            ) : null}
            {contextProject ? (
              <button
                className={`pw-icon-btn ${contextMenuAnchor ? "is-active" : ""}`}
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
          {visibleProjectChoices.map((project) => (
            <ProjectSwitchRow
              key={project.id}
              project={project}
              archived={false}
              editors={editors}
              onOpen={() => openProject(project)}
              onToast={onToast}
            />
          ))}
          {projectChoices.length > DEFAULT_VISIBLE_PROJECTS ? (
            <button
              className="pw-session-more"
              data-collapsed={!projectsExpanded}
              onClick={() => setProjectsExpanded((v) => !v)}
            >
              <span className="chev">
                <Icon.Chevron size={10} />
              </span>
              <span>
                {projectsExpanded ? "折叠项目" : `全部项目 (${projectChoices.length - DEFAULT_VISIBLE_PROJECTS})`}
              </span>
            </button>
          ) : null}
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

      {/* 底部用户行：闪记 / 自动化 / Loop / 设置 已收进头像菜单，右侧让位给消息铃铛。 */}
      <SidebarUserBar onOpenFlashNote={onOpenFlashNote} />
    </aside>
  );
}
