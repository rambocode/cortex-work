// 全局角色管理设置区（设置页面 → 模型组 → 角色）。
// 展示已创建的角色列表，支持新增/编辑/删除。角色数据由主进程持久化到 roles.json，
// bridge.listRoles/createRole/updateRole/deleteRole 通道操作。
// UI 遵循 .pw-scard/.pw-srow 设计系统。

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useCoreContext } from "@cortex-work/core/provider";
import type { RoleConfig } from "@cortex-work/core/desktop/types";

// value 是 AgentKind 技术标识符（"pi" 不变）；label 是用户可见名（pi → Cortex）。
const AGENT_OPTIONS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "pi", label: "Cortex" },
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
    <form onSubmit={handleSubmit}>
      <div className="pw-scard">
        <div className="pw-scard-t">{role ? t("roles.editTitle") : t("roles.createTitle")}</div>

        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">{t("roles.labelField")}</span>
          </div>
          <div className="pw-srow-c">
            <input
              className="pw-set-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("roles.labelPlaceholder")}
              autoFocus
            />
          </div>
        </div>

        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">{t("roles.agentField")}</span>
          </div>
          <div className="pw-srow-c">
            <select className="pw-set-input" value={agent} onChange={(e) => setAgent(e.target.value)}>
              {AGENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="pw-srow" style={{ alignItems: "flex-start" }}>
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">{t("roles.promptField")}</span>
            <span className="pw-srow-desc">{t("roles.promptPlaceholder")}</span>
          </div>
          <div className="pw-srow-c">
            <textarea
              className="pw-ta"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("roles.promptPlaceholder")}
              rows={4}
            />
          </div>
        </div>

        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">{t("roles.colorField")}</span>
          </div>
          <div className="pw-srow-c">
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
        </div>

        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">{t("roles.avatarField")}</span>
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <input
              className="pw-set-input pw-role-avatar-input"
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              placeholder="🤖"
              maxLength={2}
            />
          </div>
        </div>
      </div>

      <div className="pw-role-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("roles.cancel")}
        </button>
        <button type="submit" className="btn is-primary" disabled={!label.trim()}>
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

  useEffect(() => {
    bridge?.listRoles?.().then(setRoles);
  }, [bridge, setRoles]);

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
        <div className="pw-dlg-title">{t("roles.title")}</div>
        <div className="pw-dlg-desc">{t("roles.desc")}</div>
        <RoleEditor onSave={handleCreate} onCancel={() => setCreating(false)} />
      </>
    );
  }

  if (editing) {
    return (
      <>
        <div className="pw-dlg-title">{t("roles.title")}</div>
        <div className="pw-dlg-desc">{t("roles.desc")}</div>
        <RoleEditor role={editing} onSave={handleUpdate} onCancel={() => setEditing(null)} />
      </>
    );
  }

  return (
    <>
      <div className="pw-dlg-title">{t("roles.title")}</div>
      <div className="pw-dlg-desc">{t("roles.desc")}</div>

      <div className="pw-scard">
        <div className="pw-scard-t">
          {t("roles.customTitle")}
          <button className="btn is-primary pw-role-add-btn" type="button" onClick={() => setCreating(true)}>
            <Icon.Plus size={13} />
            {t("roles.add")}
          </button>
        </div>

        {roles.length === 0 ? (
          <div className="pw-scard-empty">{t("roles.empty")}</div>
        ) : (
          roles.map((role) => (
            <div key={role.id} className="pw-srow pw-role-row">
              <div className="pw-srow-l">
                <div className="pw-role-row-head">
                  {role.avatar && <span className="pw-role-avatar">{role.avatar}</span>}
                  <span className="pw-srow-lbl" style={role.color ? { color: role.color } : undefined}>
                    {role.label}
                  </span>
                </div>
                <span className="pw-srow-desc">{role.agent}</span>
              </div>
              <div className="pw-srow-c pw-srow-c-end" style={{ gap: 6 }}>
                <button className="pw-icon-btn" type="button" title={t("roles.edit")} onClick={() => setEditing(role)}>
                  <Icon.Edit size={14} />
                </button>
                <button className="pw-icon-btn pw-role-del" type="button" title={t("roles.delete")} onClick={() => handleDelete(role.id)}>
                  <Icon.Trash size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="pw-scard">
        <div className="pw-scard-t">{t("roles.builtinTitle")}</div>
        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">@claude</span>
            <span className="pw-srow-desc">Claude Code</span>
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <span className="pw-role-builtin-badge">built-in</span>
          </div>
        </div>
        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">@codex</span>
            <span className="pw-srow-desc">Codex</span>
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <span className="pw-role-builtin-badge">built-in</span>
          </div>
        </div>
        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">@cortex</span>
            <span className="pw-srow-desc">Cortex</span>
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <span className="pw-role-builtin-badge">built-in</span>
          </div>
        </div>
      </div>
    </>
  );
}
