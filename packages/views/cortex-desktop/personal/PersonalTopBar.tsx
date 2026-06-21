// 个人工作区「中栏」顶部头：取代旧的全宽 TitleBar 在个人区的职责。
// 三栏各自顶天后,中栏顶部承担窗口拖拽区 + 标题 + 更新按钮 + 右栏面板下拉。
// 会话(chat)视图下顶栏改为承载会话标题块 + Agent 选择器（标题从旧 chat-head 上移,见设计稿）；
// 其它视图(落地/自动化/timeline/设置)维持「个人工作区」标题。
// 拖拽区由 CSS .pw-col-head 的 -webkit-app-region: drag 提供,交互子元素 no-drag。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { AGENT_MODELS, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { AgentKind, DerivedAgentMeta, SessionMeta } from "@cortex-work/core";
import { UpdateButton } from "../UpdateButton";
import {
  agentDisplayAvatar,
  agentDisplayLabel,
  AGENT_LABEL,
  buildAgentSwitchPatch,
  useChatViewActive,
} from "./agentMeta";
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

      <PersonalAgentSelect
        session={session}
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

// Agent 选择器：自定义下拉（按钮内含 agent 小头像 + 名称 + chevron），复用顶栏菜单交互范式
// （点击展开 / 点外部·Esc·失焦关闭 / 移出延时收起）。未探测到安装的(非 pi) agent 禁用并标注。
function PersonalAgentSelect({
  session,
  agentsAvailable,
  derivedAgents,
  onSwitch,
}: {
  session: SessionMeta;
  agentsAvailable: Partial<Record<AgentKind, boolean>> | undefined;
  derivedAgents: DerivedAgentMeta[] | undefined;
  onSwitch: (agent: AgentKind, derived?: DerivedAgentMeta) => void;
}) {
  const menu = useDismissableMenu();
  // 当前选中键:派生优先(显示派生名/头像),否则内置 base。
  const displayKey = session.derivedAgentId ?? session.agent;
  const avatar = agentDisplayAvatar(displayKey, derivedAgents);
  // 派生候选:仅「新 id」(覆盖内置同名 id 的派生不新增条目,仍走内置项,R1)。
  const builtIn: readonly string[] = ["claude", "codex", "pi"];
  const derivedNew = (derivedAgents ?? []).filter((d) => !builtIn.includes(d.id));

  return (
    <div className="pw-sh-agent">
      <span className="pw-sh-agent-label">Agent</span>
      <div
        className="pw-tb-menu-wrap"
        ref={menu.wrapRef}
        onMouseLeave={menu.onMouseLeave}
        onMouseEnter={menu.onMouseEnter}
      >
        <button
          type="button"
          className="pw-sh-agent-btn"
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={() => menu.setOpen((v) => !v)}
        >
          <span className="pw-sh-agent-avatar" style={{ background: avatar.bg }}>
            {avatar.initials}
          </span>
          <span className="pw-sh-agent-name">{agentDisplayLabel(displayKey, derivedAgents)}</span>
          <span className={`pw-sh-chev ${menu.open ? "is-open" : ""}`}>
            <Icon.Chevron size={11} />
          </span>
        </button>
        {menu.open ? (
          <div className="pw-tb-menu" role="menu">
            {(Object.keys(AGENT_MODELS) as AgentKind[]).map((a) => {
              // pi 是内置兜底,永不禁用;其余 agent 未探测到安装时禁用并标注。
              const unavailable = a !== "pi" && agentsAvailable?.[a] === false;
              return (
                <button
                  key={a}
                  className="pw-tb-menu-item"
                  role="menuitem"
                  disabled={unavailable}
                  onClick={() => {
                    if (unavailable) return;
                    onSwitch(a);
                    menu.setOpen(false);
                  }}
                >
                  <span>
                    {AGENT_LABEL[a]}
                    {unavailable ? "（未安装）" : ""}
                  </span>
                  {/* 选中态:内置项当且仅当无派生标记且 base 匹配(避免派生时把内置也打勾)。 */}
                  {a === session.agent && !session.derivedAgentId ? <Icon.Check size={13} /> : null}
                </button>
              );
            })}
            {/* 用户 JSON 派生的新 agent(U7)。派生跳过 PATH 门控(后端放行),不置灰。 */}
            {derivedNew.map((d) => (
              <button
                key={d.id}
                className="pw-tb-menu-item"
                role="menuitem"
                onClick={() => {
                  onSwitch(d.base, d);
                  menu.setOpen(false);
                }}
              >
                <span>{d.label ?? d.id}</span>
                {d.id === session.derivedAgentId ? <Icon.Check size={13} /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}


// 下拉菜单关闭范式（与项目内其它菜单约定一致,见 ProjectMenu / TodosView 的 ArchiveMenu）：
// 点击外部 / Esc / 窗口失焦关闭;鼠标移出菜单区域短延迟自动收起,重新移入取消。
function useDismissableMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => cancelCloseTimer, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onBlur = () => setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const onMouseLeave = () => {
    cancelCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 220);
  };
  const onMouseEnter = () => cancelCloseTimer();

  return { open, setOpen, wrapRef, onMouseLeave, onMouseEnter };
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
