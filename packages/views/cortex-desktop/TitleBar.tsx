import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
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
  const { t } = useTranslation();
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
        <button className="icon-btn" title={t("titleBar.sidebar")} onClick={click(t("titleBar.sidebarToggled"))}>
          <Icon.Sidebar />
        </button>
        <button className="icon-btn" disabled title={t("titleBar.back")}>
          <Icon.Back />
        </button>
        <button className="icon-btn" disabled title={t("titleBar.forward")}>
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
              <span>{contact?.name || t("titleBar.conversation")}</span>
              {!isGroup && !isMe ? <span className="sub">{t("titleBar.agent")}</span> : null}
              {isShared ? (
                <span className="sub" style={{ color: "var(--violet)" }}>
                  {t("titleBar.shared")}
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
            <button className="icon-btn" title={t("titleBar.run")} onClick={click(t("titleBar.runToast"))}>
              <Icon.Run size={15} />
            </button>
            <div className="tb-pill" onClick={click(t("titleBar.modelToast"))} style={{ cursor: "pointer" }}>
              <span className="lightning">
                <Icon.Lightning size={12} />
              </span>
              <span>Sonnet 4.5</span>
              <Icon.Chevron size={11} />
            </div>
            <button className="icon-btn" title={t("titleBar.terminal")} onClick={click(t("titleBar.terminalToast"))}>
              <Icon.Terminal />
            </button>
            <button className="icon-btn" title={t("titleBar.detail")} onClick={click(t("titleBar.detailToast"))}>
              <Icon.Info />
            </button>
            <div className="tb-divider" />
            <button
              className={`icon-btn ${rightOpen ? "is-on" : ""}`}
              title={rightOpen ? t("titleBar.closeReviewPanel") : t("titleBar.openReviewPanel")}
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
  const { t } = useTranslation();
  return (
    <div className="desktop-tabs" role="tablist" aria-label={t("titleBar.tabsAriaLabel")}>
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
      <button className="desktop-tab-add" aria-label={t("titleBar.addTab")} onClick={() => onToast(t("titleBar.addTabToast"))}>
        <Icon.Plus size={14} />
      </button>
    </div>
  );
}
