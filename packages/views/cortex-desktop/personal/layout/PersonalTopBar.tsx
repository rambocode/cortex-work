// 个人工作区「中栏」顶部头：取代旧的全宽 TitleBar 在个人区的职责。
// 三栏各自顶天后,中栏顶部承担窗口拖拽区 + 标题 + 更新按钮。
// 会话(chat)视图下顶栏改为承载会话标题块 + Agent 选择器（标题从旧 chat-head 上移,见设计稿）；
// 其它视图(落地/自动化/设置)维持「个人工作区」标题。
// 拖拽区由 CSS .pw-col-head 的 -webkit-app-region: drag 提供,交互子元素 no-drag。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { UpdateButton } from "../../UpdateButton";
import {
  agentDisplayAvatar,
  agentDisplayLabel,
  buildAgentSwitchPatch,
  useChatViewActive,
} from "../chat/agentMeta";
import { AgentSelect } from "../chat/AgentSelect";
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
    </div>
  );
}

// 顶栏会话头（chat 视图）：会话标题块（agent 头像 + 标题 + agent 标签 + 路径展开）+ Agent 选择器
// + 更新按钮。右栏与终端入口已统一迁到右侧竖向工具栏；数据全部从 usePersonalStore 直接取，
// 无需层层传 props。
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
          {session.agent !== "pi" && session.effort ? <span className="pw-pi-chip">思考 {session.effort}</span> : null}
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
    </div>
  );
}
