// 个人工作区「中栏」顶部头：取代旧的全宽 TitleBar 在个人区的职责。
// 三栏各自顶天后,中栏顶部承担窗口拖拽区 + 标题 + 更新按钮 + 右栏面板下拉。
// 会话(chat)视图下顶栏改为承载会话标题块 + Agent 选择器（标题从旧 chat-head 上移,见设计稿）；
// 其它视图(落地/自动化/timeline/设置)维持「个人工作区」标题。
// 拖拽区由 CSS .pw-col-head 的 -webkit-app-region: drag 提供,交互子元素 no-drag。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { UpdateButton } from "../UpdateButton";
import {
  agentDisplayAvatar,
  agentDisplayLabel,
  buildAgentSwitchPatch,
  useChatViewActive,
} from "./agentMeta";
import { AgentSelect } from "./AgentSelect";
import { useDismissableMenu } from "./useDismissableMenu";
import { SidebarLeftControls } from "./SidebarControls";

export function PersonalCenterHeader() {
  const chatViewActive = useChatViewActive();
  const leftCollapsed = useCortexUIStore((s) => s.leftCollapsed);
  const hasSession = usePersonalStore(
    (s) => !!s.activeSessionId && s.sessions.some((x) => x.id === s.activeSessionId),
  );
  // 会话视图且有活动会话 → 顶栏承载会话标题 + Agent 选择器；否则维持默认标题。
  if (chatViewActive && hasSession) return <PersonalSessionHeader />;
  return (
    <div className="pw-col-head pw-center-head">
      {/* 左栏折叠后,折叠/搜索控制移到中栏顶栏左侧（侧栏已隐藏）。 */}
      {leftCollapsed ? <SidebarLeftControls /> : null}
      <span className="pw-col-head-title">个人工作区</span>
      <div className="spacer" />
      <UpdateButton />
      <PersonalPanelControls />
    </div>
  );
}

// 顶栏会话头（chat 视图）：会话标题块（agent 头像 + 标题 + agent 标签 + 路径展开）+ Agent 选择器
// + 更新按钮 + 右栏/终端控制。数据全部从 usePersonalStore 直接取,无需层层传 props。
function PersonalSessionHeader() {
  const leftCollapsed = useCortexUIStore((s) => s.leftCollapsed);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const sessions = usePersonalStore((s) => s.sessions);
  const projects = usePersonalStore((s) => s.projects);
  const runningBySession = usePersonalStore((s) => s.runningBySession);
  const piRuntimeBySession = usePersonalStore((s) => s.piRuntimeBySession);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const derivedAgents = usePersonalStore((s) => s.derivedAgents);
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const updateSession = usePersonalStore((s) => s.updateSession);

  // 项目路径行默认收起（设计稿 pathOpen:false）。
  const [pathOpen, setPathOpen] = useState(false);

  const session = sessions.find((x) => x.id === activeSessionId);
  // 父级已门控 hasSession,这里仅作防御（切换瞬态）。
  if (!session) {
    return (
      <div className="pw-col-head pw-center-head">
        {leftCollapsed ? <SidebarLeftControls /> : null}
        <span className="pw-col-head-title">个人工作区</span>
        <div className="spacer" />
        <UpdateButton />
        <PersonalPanelControls />
      </div>
    );
  }

  const agent = session.agent;
  // 显示用「派生优先」键:有 derivedAgentId 时显示派生名/头像,否则内置(U7)。
  const displayKey = session.derivedAgentId ?? agent;
  const avatar = agentDisplayAvatar(displayKey, derivedAgents);
  const realProject = session.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
  const projectName = realProject?.name ?? "无项目";
  const projectPath = realProject?.path ?? session.noProjectDir ?? "";
  const running = !!runningBySession[session.id];
  // pi RPC 会话运行时状态（压缩/重试/待注入队列/思考强度）;非 pi 会话恒 undefined。
  const piRuntime = agent === "pi" ? piRuntimeBySession[session.id] : undefined;

  return (
    <div className="pw-col-head pw-center-head pw-sh">
      {leftCollapsed ? <SidebarLeftControls /> : null}
      <div className="pw-sh-titleblock">
        <div className="pw-sh-titlerow">
          <span className="pw-sh-avatar" style={{ background: avatar.bg }}>
            {avatar.initials}
          </span>
          <span className="pw-sh-title" title={session.title}>
            {session.title}
          </span>
          <span className="pw-sh-tag">{agentDisplayLabel(displayKey, derivedAgents)}</span>
          <button
            type="button"
            className="pw-sh-pathbtn"
            title="项目路径"
            aria-label="项目路径"
            aria-expanded={pathOpen}
            onClick={() => setPathOpen((v) => !v)}
          >
            <span className={`pw-sh-chev ${pathOpen ? "is-open" : ""}`}>
              <Icon.Chevron size={13} />
            </span>
          </button>
          {piRuntime?.compacting ? <span className="pw-pi-chip">压缩上下文…</span> : null}
          {piRuntime?.retry ? (
            <span className="pw-pi-chip pw-pi-warn">
              重试中 {piRuntime.retry.attempt}
              {piRuntime.retry.max ? `/${piRuntime.retry.max}` : ""}
            </span>
          ) : null}
          {piRuntime?.steering ? <span className="pw-pi-chip">{piRuntime.steering} 条待注入</span> : null}
          {/* follow-up 排队条数（区别于 steer 的「插入当前轮」,follow-up 是「排到下一轮」）。
              计数早已随 queue 事件写入 store,此前只缺回显。 */}
          {piRuntime?.followUp ? <span className="pw-pi-chip">{piRuntime.followUp} 条排队</span> : null}
          {piRuntime?.thinkingLevel ? <span className="pw-pi-chip">思考 {piRuntime.thinkingLevel}</span> : null}
        </div>
        {pathOpen ? (
          <div className="pw-sh-path">
            <span className="pw-sh-dot" style={{ background: running ? "var(--amber)" : "var(--green)" }} />
            <span className="pw-sh-pname">{projectName}</span>
            <span className="pw-sh-sep">·</span>
            <span className="pw-sh-ppath" title={projectPath}>
              {projectPath}
            </span>
          </div>
        ) : null}
      </div>

      <AgentSelect
        agent={session.agent}
        derivedAgentId={session.derivedAgentId}
        agentsAvailable={agentsAvailable}
        derivedAgents={derivedAgents}
        onSwitch={(a, derived) =>
          updateSession(session.id, buildAgentSwitchPatch(session, a, providerSettings, derived))
        }
      />
      <UpdateButton />
      <PersonalPanelControls />
    </div>
  );
}

// 终端开关 + 右栏面板下拉（选择 文件 / Skills / Tasks 视图,或收起面板）。
function PersonalPanelControls() {
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const toggleRight = useCortexUIStore((s) => s.toggleRight);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const terminalOpen = usePersonalStore((s) => s.terminalOpen);
  const toggleTerminal = usePersonalStore((s) => s.toggleTerminal);
  const rightView = usePersonalStore((s) => s.rightView);
  const setRightView = usePersonalStore((s) => s.setRightView);

  const menu = useDismissableMenu();

  const pick = (view: "files" | "skills" | "todos" | "notes" | "browser") => {
    setRightView(view);
    if (!rightOpen) setRightOpen(true);
    menu.setOpen(false);
  };

  return (
    <>
      <button
        className={`icon-btn ${terminalOpen ? "is-on" : ""}`}
        title={terminalOpen ? "收起终端" : "打开终端"}
        onClick={toggleTerminal}
      >
        <Icon.Terminal />
      </button>
      <div className="tb-divider" />
      <div
        className="pw-tb-menu-wrap"
        ref={menu.wrapRef}
        onMouseLeave={menu.onMouseLeave}
        onMouseEnter={menu.onMouseEnter}
      >
        <button
          className={`icon-btn ${rightOpen ? "is-on" : ""}`}
          title="右侧面板"
          onClick={() => menu.setOpen((v) => !v)}
        >
          <Icon.Sidebar />
          <Icon.Chevron size={9} />
        </button>
        {menu.open ? (
          <div className="pw-tb-menu" role="menu">
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("files")}>
              <Icon.Folder size={14} />
              <span>文件</span>
              {rightOpen && rightView === "files" ? <Icon.Check size={13} /> : null}
            </button>
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("skills")}>
              <Icon.Sparkle size={14} />
              <span>Skills</span>
              {rightOpen && rightView === "skills" ? <Icon.Check size={13} /> : null}
            </button>
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("todos")}>
              <Icon.Task size={14} />
              <span>Tasks</span>
              {rightOpen && rightView === "todos" ? <Icon.Check size={13} /> : null}
            </button>
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("notes")}>
              <Icon.Pin size={14} />
              <span>闪记</span>
              {rightOpen && rightView === "notes" ? <Icon.Check size={13} /> : null}
            </button>
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => pick("browser")}>
              <Icon.Globe size={14} />
              <span>浏览器</span>
              {rightOpen && rightView === "browser" ? <Icon.Check size={13} /> : null}
            </button>
            <button
              className="pw-tb-menu-item"
              role="menuitem"
              onClick={() => {
                toggleTerminal?.();
                menu.setOpen(false);
              }}
            >
              <Icon.Terminal size={14} />
              <span>终端</span>
              {terminalOpen ? <Icon.Check size={13} /> : null}
            </button>
            <div className="pw-tb-menu-sep" />
            <button
              className="pw-tb-menu-item"
              role="menuitem"
              onClick={() => {
                toggleRight();
                menu.setOpen(false);
              }}
            >
              <Icon.Sidebar size={14} />
              <span>{rightOpen ? "收起右侧面板" : "展开右侧面板"}</span>
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
