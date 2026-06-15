import { Icon } from "@cortex-work/ui/icons";
import type { Contact } from "@cortex-work/core/types";
import { type Section } from "@cortex-work/core";
import { UpdateButton } from "./UpdateButton";

export interface TitleBarProps {
  contact: Contact | undefined;
  rightOpen: boolean;
  onToggleRight: () => void;
  onToast: (text: string) => void;
  activeSection: Section;
  onNavigate: (section: Section) => void;
  // When set, the titlebar shows a top-level section title instead of the
  // active contact, and chat-only tools (run / model / review toggle) hide.
  sectionTitle?: string;
  // 个人工作区:隐藏 Projects/Issues/Autopilot 导航（个人区不再渲染本组件,仅保留
  // 该开关以缩小改动面）。
  personal?: boolean;
}

export function TitleBar({
  contact,
  rightOpen,
  onToggleRight,
  onToast,
  activeSection,
  onNavigate,
  sectionTitle,
  personal = false,
}: TitleBarProps) {
  const isGroup = contact?.group === "groups";
  const isShared = contact?.group === "shared";
  const isMe = contact?.id === "me";

  const click = (label: string) => () => onToast(label);

  const dotColor =
    contact?.agentStatus === "working"
      ? "var(--amber)"
      : contact?.agentStatus === "review"
        ? "var(--blue)"
        : contact?.agentStatus === "online"
          ? "var(--green)"
          : contact?.agentStatus === "offline"
            ? "#c5c2b8"
            : "var(--text-4)";

  return (
    <div className="titlebar">
      <div className="tb-left">
        <button className="icon-btn" title="侧栏" onClick={click("已展开/收起侧栏")}>
          <Icon.Sidebar />
        </button>
        <button className="icon-btn" disabled title="后退">
          <Icon.Back />
        </button>
        <button className="icon-btn" disabled title="前进">
          <Icon.Fwd />
        </button>
      </div>

      <div className="tb-center">
        {personal ? null : <DesktopTabs activeSection={activeSection} onNavigate={onNavigate} onToast={onToast} />}
        <div className="tb-title sr-title">
          {sectionTitle ? (
            <span>{sectionTitle}</span>
          ) : (
            <>
              {isGroup ? (
                <span style={{ color: "var(--text-3)" }}>
                  <Icon.Hashtag size={14} />
                </span>
              ) : null}
              <span>{contact?.name || "对话"}</span>
              {!isGroup && !isMe ? <span className="sub">· Agent</span> : null}
              {isShared ? (
                <span className="sub" style={{ color: "var(--violet)" }}>
                  共享
                </span>
              ) : null}
              <span className="dot" style={{ background: dotColor }} />
              <span className="more">
                <Icon.More size={14} />
              </span>
            </>
          )}
        </div>
      </div>

      <div className="tb-right">
        <UpdateButton />
        {sectionTitle ? null : (
          <>
            <button className="icon-btn" title="运行" onClick={click("已发送至 Agent · 执行中")}>
              <Icon.Run size={15} />
            </button>
            <div className="tb-pill" onClick={click("模型选择 · 已是 Sonnet 4.5")} style={{ cursor: "pointer" }}>
              <span className="lightning">
                <Icon.Lightning size={12} />
              </span>
              <span>Sonnet 4.5</span>
              <Icon.Chevron size={11} />
            </div>
            <button className="icon-btn" title="终端" onClick={click("终端 · 暂未实现")}>
              <Icon.Terminal />
            </button>
            <button className="icon-btn" title="详情" onClick={click("会话详情 · 暂未实现")}>
              <Icon.Info />
            </button>
            <div className="tb-divider" />
            <button
              className={`icon-btn ${rightOpen ? "is-on" : ""}`}
              title={rightOpen ? "关闭审查面板" : "打开审查面板"}
              onClick={onToggleRight}
            >
              <Icon.Sidebar />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function DesktopTabs({
  activeSection,
  onNavigate,
  onToast,
}: {
  activeSection: Section;
  onNavigate: (section: Section) => void;
  onToast: (text: string) => void;
}) {
  return (
    <div className="desktop-tabs" role="tablist" aria-label="桌面导航标签">
      <button
        className={`desktop-tab ${activeSection === "chat" ? "is-active" : ""}`}
        role="tab"
        aria-selected={activeSection === "chat"}
        onClick={() => onNavigate("chat")}
      >
        <span>Projects</span>
      </button>
      <button
        className={`desktop-tab ${activeSection === "tasks" ? "is-active" : ""}`}
        role="tab"
        aria-selected={activeSection === "tasks"}
        onClick={() => onNavigate("tasks")}
      >
        <Icon.Task size={13} />
        <span>Issues</span>
      </button>
      <button
        className={`desktop-tab ${activeSection === "agents" ? "is-active" : ""}`}
        role="tab"
        aria-selected={activeSection === "agents"}
        onClick={() => onNavigate("agents")}
      >
        <Icon.Bot size={13} />
        <span>Autopilot</span>
      </button>
      <button className="desktop-tab-add" aria-label="新建标签" onClick={() => onToast("新建标签 · 暂未实现")}>
        <Icon.Plus size={14} />
      </button>
    </div>
  );
}
