import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { GROUPS, type Section } from "@cortex-work/core";
import type { Contact, Group, SidebarMode } from "@cortex-work/core/types";
import { OrgSwitcher } from "./OrgSwitcher";
import { WorkspaceTabs } from "./personal/WorkspaceTabs";

function SidebarTop({
  search,
  onSearch,
  onToast,
  activeSection,
  onNavigate,
  sectionCounts,
}: {
  search: string;
  onSearch: (q: string) => void;
  onToast: (text: string) => void;
  activeSection: Section;
  onNavigate: (section: Section) => void;
  sectionCounts?: Partial<Record<"tasks" | "agents" | "usage", number | string>>;
}) {
  const click = (label: string) => () => onToast(label);
  const nav = (section: Section) => () => onNavigate(section);
  return (
    <div className="sb-top">
      <button className="sb-row" onClick={click("新消息 · 选择一个联系人开始")}>
        <Icon.Edit size={15} />
        <span className="label">新消息</span>
        <span className="kbd">⌘N</span>
      </button>
      <div className="sb-row sb-search">
        <Icon.Search size={15} />
        <input
          className="sb-search-input"
          placeholder="搜索联系人 / 对话"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {search ? (
          <button className="sb-clear" onClick={() => onSearch("")} title="清除">
            <Icon.X size={12} />
          </button>
        ) : (
          <span className="kbd">⌘K</span>
        )}
      </div>
      <button className="sb-row" onClick={click("已查看提及与提醒")}>
        <Icon.At size={15} />
        <span className="label">提及与提醒</span>
        <span className="kbd" style={{ color: "var(--accent)", fontWeight: 500 }}>
          3
        </span>
      </button>
      <button className="sb-row" onClick={click("自动化 · 2 条已启用")}>
        <Icon.Workflow size={15} />
        <span className="label">自动化</span>
        <span className="kbd">2</span>
      </button>
      <button className={`sb-row ${activeSection === "tasks" ? "is-active" : ""}`} onClick={nav("tasks")}>
        <Icon.Task size={15} />
        <span className="label">任务</span>
        <span className="kbd">{sectionCounts?.tasks ?? 5}</span>
      </button>
      <button className={`sb-row ${activeSection === "agents" ? "is-active" : ""}`} onClick={nav("agents")}>
        <Icon.Bot size={15} />
        <span className="label">智能体</span>
        <span className="kbd">{sectionCounts?.agents ?? 8}</span>
      </button>
      <button className={`sb-row ${activeSection === "usage" ? "is-active" : ""}`} onClick={nav("usage")}>
        <Icon.Chart size={15} />
        <span className="label">用量</span>
        {sectionCounts?.usage !== undefined ? <span className="kbd">{sectionCounts.usage}</span> : null}
      </button>
    </div>
  );
}

function LastMessage({ item, mode }: { item: Contact; mode: SidebarMode }) {
  if (mode === "minimal") return null;

  if (mode === "activity") {
    const status = item.agentStatus;
    const map: Record<string, { c: string; text: string }> = {
      working: { c: "var(--amber)", text: item.statusText || "Agent 正在工作" },
      review: { c: "var(--blue)", text: item.statusText || "有产出待审" },
      online: { c: "var(--green)", text: item.statusText || "在线" },
      idle: { c: "var(--text-3)", text: item.statusText || "空闲" },
      offline: { c: "var(--text-4)", text: item.statusText || "离线" },
    };
    const s = map[status] || map.idle!;
    return (
      <div className="last" style={{ color: s.c, fontWeight: 500 }}>
        {s.text}
      </div>
    );
  }

  const last = item.last;
  const unread = (item.unread || 0) > 0;

  if (typeof last === "string") {
    return (
      <div className="last" style={unread ? { color: "var(--text-1)", fontWeight: 500 } : undefined}>
        {last}
      </div>
    );
  }
  if (last.kind === "working") {
    return (
      <div className="last">
        <span className="working">
          <span style={{ display: "inline-block", width: 8, height: 8 }}>
            <svg viewBox="0 0 8 8">
              <circle cx="4" cy="4" r="2" fill="currentColor" />
            </svg>
          </span>
          {last.text}
        </span>
      </div>
    );
  }
  if (last.kind === "review") {
    return (
      <div className="last">
        <span className="review-chip">
          <Icon.Diff size={10} />
          {last.text}
        </span>
      </div>
    );
  }
  if (last.kind === "mention") {
    return (
      <div className="last" style={{ color: "var(--text-1)", fontWeight: 500 }}>
        <span className="mention">@你</span>
        {last.text.replace("@你", "")}
      </div>
    );
  }
  return <div className="last">{String(last)}</div>;
}

export function ContactRow({
  item,
  active,
  onClick,
  mode,
}: {
  item: Contact;
  active: boolean;
  onClick: (id: string) => void;
  mode: SidebarMode;
}) {
  return (
    <div className={`contact ${active ? "is-active" : ""}`} onClick={() => onClick(item.id)}>
      <div className="avatar" style={{ background: item.avatar.bg }}>
        {item.avatar.initials}
        <span className={`agent-dot s-${item.agentStatus}`} />
      </div>
      <div className="name">{item.name}</div>
      {mode !== "minimal" ? <div className="time">{item.time}</div> : null}
      <LastMessage item={item} mode={mode} />
      {item.unread > 0 ? (
        <span className={`badge ${item.mention ? "mention" : "muted"}`}>
          {item.mention ? "@" : ""}
          {item.unread}
        </span>
      ) : null}
      {item.pinned ? (
        <span className="pin">
          <Icon.Pin size={11} />
        </span>
      ) : null}
    </div>
  );
}

function matches(c: Contact, search: string): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  return c.name.toLowerCase().includes(q) || (c.role || "").toLowerCase().includes(q);
}

function SidebarSection({
  group,
  contacts,
  activeId,
  onSelect,
  mode,
  search,
}: {
  group: Group;
  contacts: Contact[];
  activeId: string;
  onSelect: (id: string) => void;
  mode: SidebarMode;
  search: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const list = contacts.filter((c) => c.group === group.id && matches(c, search));
  if (list.length === 0) return null;
  return (
    <div className="sb-section">
      <div
        className="sb-section-h"
        data-collapsed={collapsed}
        onClick={() => setCollapsed((v) => !v)}
        style={{ cursor: "pointer" }}
      >
        <span className="chev">
          <Icon.Chevron size={11} />
        </span>
        <span>{group.label}</span>
        <span className="count">· {list.length}</span>
      </div>
      {!collapsed &&
        list.map((c) => (
          <ContactRow key={c.id} item={c} active={c.id === activeId} onClick={onSelect} mode={mode} />
        ))}
    </div>
  );
}

export interface SidebarProps {
  contacts: Contact[];
  activeId: string;
  onSelect: (id: string) => void;
  mode: SidebarMode;
  search: string;
  onSearch: (q: string) => void;
  onToast: (text: string) => void;
  activeSection: Section;
  onNavigate: (section: Section) => void;
  sectionCounts?: Partial<Record<"tasks" | "agents" | "usage", number | string>>;
}

export function Sidebar({
  contacts,
  activeId,
  onSelect,
  mode,
  search,
  onSearch,
  onToast,
  activeSection,
  onNavigate,
  sectionCounts,
}: SidebarProps) {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const totalMatches = search ? contacts.filter((c) => matches(c, search)).length : null;
  // In a non-chat section no contact is "active".
  const highlightId = activeSection === "chat" ? activeId : "";
  const openSettings = () => {
    setSettingsMenuOpen(false);
    onNavigate("settings");
  };

  return (
    <aside className="sidebar">
      <WorkspaceTabs />
      <OrgSwitcher />
      <SidebarTop
        search={search}
        onSearch={onSearch}
        onToast={onToast}
        activeSection={activeSection}
        onNavigate={onNavigate}
        sectionCounts={sectionCounts}
      />
      <div className="sb-list">
        {GROUPS.map((g) => (
          <SidebarSection
            key={g.id}
            group={g}
            contacts={contacts}
            activeId={highlightId}
            onSelect={onSelect}
            mode={mode}
            search={search}
          />
        ))}
        {search && totalMatches === 0 ? (
          <div className="sb-empty">
            <Icon.Search size={22} />
            <div>未找到匹配 “{search}” 的联系人</div>
          </div>
        ) : null}
      </div>
      <div className="sb-foot">
        <div className="settings-menu-wrap">
          {settingsMenuOpen ? (
            <div className="settings-popover" role="menu">
              <button className="settings-popover-item" role="menuitem" onClick={openSettings}>
                <span className="settings-popover-icon">我</span>
                <span>个人资料</span>
              </button>
              <button className="settings-popover-item" role="menuitem" onClick={openSettings}>
                <Icon.Settings size={14} />
                <span>设置</span>
              </button>
              <button
                className="settings-popover-item danger"
                role="menuitem"
                onClick={() => {
                  setSettingsMenuOpen(false);
                  onToast("退出登录 · Demo");
                }}
              >
                <Icon.X size={14} />
                <span>退出</span>
              </button>
            </div>
          ) : null}
          <button
            className={`sb-row is-mute ${activeSection === "settings" ? "is-active" : ""}`}
            onClick={() => setSettingsMenuOpen((open) => !open)}
          >
            <Icon.Settings size={15} />
            <span className="label">设置</span>
            <span className="kbd">⌘,</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
