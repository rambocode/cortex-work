import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { Contact } from "@cortex-work/core/types";
import { usePersonalStore, type Section } from "@cortex-work/core";
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
  // 个人工作区:隐藏 Projects/Issues/Autopilot 导航,右侧换成终端 + 折叠右栏。
  personal?: boolean;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
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
  terminalOpen = false,
  onToggleTerminal,
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
        {personal ? (
          <PersonalPanelControls
            rightOpen={rightOpen}
            onToggleRight={onToggleRight}
            terminalOpen={terminalOpen}
            onToggleTerminal={onToggleTerminal}
          />
        ) : sectionTitle ? null : (
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

// 个人工作区顶栏右侧:终端开关 + 右栏面板下拉（选择 文件/Skills 视图,或收起面板）。
function PersonalPanelControls({
  rightOpen,
  onToggleRight,
  terminalOpen,
  onToggleTerminal,
}: {
  rightOpen: boolean;
  onToggleRight: () => void;
  terminalOpen: boolean;
  onToggleTerminal?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rightView = usePersonalStore((s) => s.rightView);
  const setRightView = usePersonalStore((s) => s.setRightView);

  const pick = (view: "files" | "skills" | "todos") => {
    setRightView(view);
    if (!rightOpen) onToggleRight();
    setMenuOpen(false);
  };

  return (
    <>
      <button
        className={`icon-btn ${terminalOpen ? "is-on" : ""}`}
        title={terminalOpen ? "收起终端" : "打开终端"}
        onClick={onToggleTerminal}
      >
        <Icon.Terminal />
      </button>
      <div className="tb-divider" />
      <div className="pw-tb-menu-wrap">
        <button
          className={`icon-btn ${rightOpen ? "is-on" : ""}`}
          title="右侧面板"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon.Sidebar />
          <Icon.Chevron size={9} />
        </button>
        {menuOpen ? (
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
            <button
              className="pw-tb-menu-item"
              role="menuitem"
              onClick={() => {
                onToggleTerminal?.();
                setMenuOpen(false);
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
                onToggleRight();
                setMenuOpen(false);
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
