// 全局角色管理设置区（设置页面 → 模型组 → 角色）。
// 展示已创建的角色列表，支持新增/编辑/删除。角色数据由主进程持久化到 roles.json，
// bridge.listRoles/createRole/updateRole/deleteRole 通道操作。

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useCoreContext } from "@cortex-work/core/provider";
import type { RoleConfig } from "@cortex-work/core/desktop/types";

const AGENT_OPTIONS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "pi", label: "Pi" },
] as const;

const ROLE_COLORS = [
  "#7c5cff", "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316",
];

interface RoleEditorProps {
  role?: RoleConfig;
  onSave: (data: { label: string; agent: string; systemPrompt: string; color?: string; avatar?: string }) => void;
  onCancel: () => void;
}

function RoleEditor({ role, onSave, onCancel }: RoleEditorProps) {
  const { t } = useTranslation("settings");
  const [label, setLabel] = useState(role?.label ?? "");
  const [agent, setAgent] = useState(role?.agent ?? "claude");
  const [systemPrompt, setSystemPrompt] = useState(role?.systemPrompt ?? "");
  const [color, setColor] = useState(role?.color ?? ROLE_COLORS[0]);
  const [avatar, setAvatar] = useState(role?.avatar ?? "");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!label.trim()) return;
      onSave({ label: label.trim(), agent, systemPrompt, color, avatar: avatar || undefined });
    },
    [label, agent, systemPrompt, color, avatar, onSave],
  );

  return (
    <form className="pw-role-editor" onSubmit={handleSubmit}>
      <div className="pw-dlg-field">
        <label className="pw-dlg-label">{t("roles.labelField")}</label>
        <input
          className="pw-dlg-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("roles.labelPlaceholder")}
          autoFocus
        />
      </div>

      <div className="pw-dlg-field">
        <label className="pw-dlg-label">{t("roles.agentField")}</label>
        <select className="pw-dlg-select" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {AGENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="pw-dlg-field">
        <label className="pw-dlg-label">{t("roles.promptField")}</label>
        <textarea
          className="pw-dlg-textarea"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t("roles.promptPlaceholder")}
          rows={4}
        />
      </div>

      <div className="pw-dlg-field">
        <label className="pw-dlg-label">{t("roles.colorField")}</label>
        <div className="pw-role-colors">
          {ROLE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`pw-role-color-swatch ${color === c ? "is-active" : ""}`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
              aria-label={c}
            />
          ))}
        </div>
      </div>

      <div className="pw-dlg-field">
        <label className="pw-dlg-label">{t("roles.avatarField")}</label>
        <input
          className="pw-dlg-input pw-role-avatar-input"
          value={avatar}
          onChange={(e) => setAvatar(e.target.value)}
          placeholder="🤖"
          maxLength={2}
        />
      </div>

      <div className="pw-dlg-actions">
        <button type="button" className="pw-dlg-btn is-secondary" onClick={onCancel}>
          {t("roles.cancel")}
        </button>
        <button type="submit" className="pw-dlg-btn is-primary" disabled={!label.trim()}>
          {role ? t("roles.save") : t("roles.create")}
        </button>
      </div>
    </form>
  );
}

export function RolesSection() {
  const { t } = useTranslation("settings");
  const { desktopBridge: bridge } = useCoreContext();
  const roles = usePersonalStore((s) => s.roles);
  const setRoles = usePersonalStore((s) => s.setRoles);
  const [editing, setEditing] = useState<RoleConfig | null>(null);
  const [creating, setCreating] = useState(false);

  // 初始加载角色列表
  useEffect(() => {
    bridge?.listRoles?.().then(setRoles);
  }, [bridge, setRoles]);

  // 监听角色变更广播
  useEffect(() => {
    const off = bridge?.onRolesChanged?.(setRoles);
    return () => off?.();
  }, [bridge, setRoles]);

  const handleCreate = useCallback(
    async (data: { label: string; agent: string; systemPrompt: string; color?: string; avatar?: string }) => {
      await bridge?.createRole?.(data);
      setCreating(false);
    },
    [bridge],
  );

  const handleUpdate = useCallback(
    async (data: { label: string; agent: string; systemPrompt: string; color?: string; avatar?: string }) => {
      if (!editing) return;
      await bridge?.updateRole?.(editing.id, data);
      setEditing(null);
    },
    [bridge, editing],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await bridge?.deleteRole?.(id);
    },
    [bridge],
  );

  if (creating) {
    return (
      <>
        <div className="pw-dlg-title">{t("roles.createTitle")}</div>
        <RoleEditor onSave={handleCreate} onCancel={() => setCreating(false)} />
      </>
    );
  }

  if (editing) {
    return (
      <>
        <div className="pw-dlg-title">{t("roles.editTitle")}</div>
        <RoleEditor role={editing} onSave={handleUpdate} onCancel={() => setEditing(null)} />
      </>
    );
  }

  return (
    <>
      <div className="pw-dlg-title">{t("roles.title")}</div>
      <div className="pw-dlg-desc">{t("roles.desc")}</div>

      <button className="pw-dlg-btn is-primary pw-roles-add" onClick={() => setCreating(true)}>
        + {t("roles.add")}
      </button>

      {roles.length === 0 ? (
        <div className="pw-dlg-empty">{t("roles.empty")}</div>
      ) : (
        <div className="pw-roles-list">
          {roles.map((role) => (
            <div key={role.id} className="pw-role-card">
              <div className="pw-role-card-header">
                {role.avatar && <span className="pw-role-avatar">{role.avatar}</span>}
                <span className="pw-role-label" style={role.color ? { color: role.color } : undefined}>
                  {role.label}
                </span>
                <span className="pw-role-agent">{role.agent}</span>
              </div>
              {role.systemPrompt && (
                <div className="pw-role-prompt">{role.systemPrompt.slice(0, 120)}{role.systemPrompt.length > 120 ? "…" : ""}</div>
              )}
              <div className="pw-role-card-actions">
                <button className="pw-role-action" onClick={() => setEditing(role)}>{t("roles.edit")}</button>
                <button className="pw-role-action is-danger" onClick={() => handleDelete(role.id)}>{t("roles.delete")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
