// 单个团队(squad)卡片:成员列表(带名字/角色,agent 标「智能体」)、成员数、移除成员、
// 团队信息编辑(名称/描述)、生成/复制邀请码、退出团队。
// 每张卡片独立持有 useSquadMembers(每 squad 一个 hook,故按 squad 拆成本组件而非在列表里循环调 hook)。
// 数据/失效范式在 core/cortex/teams.ts;本组件只做表单编排与错误码→文案呈现。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  useSquadMembers,
  useCreateJoinCode,
  useLeaveSquad,
  useUpdateSquad,
  useRemoveSquadMember,
  mapSquadMemberRows,
  updateSquadErrorKey,
  removeMemberErrorKey,
  useCortexUIStore,
} from "@cortex-work/core";
import { ApiError } from "@cortex-work/core/api";
import type { ApiSquad, SquadJoinCodeResponse, WorkspaceMember } from "@cortex-work/core/api/types";

// 把 ISO 过期时间格式化为本地可读串;非法值兜底原样返回,避免抛错。
function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// squad 内成员角色 → i18n key(leader/owner/admin/member 之外原样兜底)。
function roleLabelKey(role: string): string | null {
  switch (role) {
    case "leader":
      return "team.roleLeader";
    case "owner":
      return "team.roleOwner";
    case "admin":
      return "team.roleAdmin";
    case "member":
      return "team.roleMember";
    default:
      return null;
  }
}

export function SquadCard({
  squad,
  canManage,
  wsMembers,
}: {
  squad: ApiSquad;
  canManage: boolean;
  wsMembers: WorkspaceMember[];
}) {
  const { t } = useTranslation();
  const pushToast = useCortexUIStore((s) => s.pushToast);

  const membersQuery = useSquadMembers(squad.id);
  const createJoinCode = useCreateJoinCode();
  const leaveSquad = useLeaveSquad();
  const updateSquad = useUpdateSquad();
  const removeMember = useRemoveSquadMember();

  const [code, setCode] = useState<SquadJoinCodeResponse | null>(null);
  // 编辑态:名称预填 squad.name;描述初始空(列表 DTO 无 description),仅当用户改过才纳入补丁,避免误清空。
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(squad.name);
  const [editDesc, setEditDesc] = useState("");
  const [descTouched, setDescTouched] = useState(false);

  const rows = mapSquadMemberRows(membersQuery.data ?? [], wsMembers);

  const handleGenCode = () => {
    if (createJoinCode.isPending) return;
    createJoinCode.mutate(squad.id, {
      onSuccess: (res) => setCode(res),
      onError: () => pushToast(t("team.genCodeFailed"), { kind: "error" }),
    });
  };

  const handleCopy = (value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => pushToast(t("team.copied"), { kind: "success" }),
      () => pushToast(t("team.copied"), { kind: "info" }),
    );
  };

  const handleLeave = () => {
    if (leaveSquad.isPending) return;
    if (!window.confirm(t("team.leaveConfirm"))) return;
    leaveSquad.mutate(squad.id, {
      onSuccess: () => pushToast(t("team.left"), { kind: "success" }),
      onError: (err) => {
        const key = err instanceof ApiError && err.status === 403 ? "team.errNeedAdmin" : "team.leaveFailed";
        pushToast(t(key), { kind: "error" });
      },
    });
  };

  const handleSaveInfo = () => {
    const name = editName.trim();
    if (updateSquad.isPending) return;
    // 只发生变更的字段:名称非空且异于原名才带;描述仅在用户编辑过时带(允许清空)。
    const patch: { name?: string; description?: string } = {};
    if (name && name !== squad.name) patch.name = name;
    if (descTouched) patch.description = editDesc.trim();
    if (!patch.name && patch.description === undefined) {
      setEditing(false);
      return;
    }
    updateSquad.mutate(
      { squadId: squad.id, patch },
      {
        onSuccess: () => {
          setEditing(false);
          setDescTouched(false);
          pushToast(t("team.saved"), { kind: "success" });
        },
        onError: (err) => pushToast(t(updateSquadErrorKey(err)), { kind: "error" }),
      },
    );
  };

  const handleRemove = (memberType: string, memberId: string) => {
    if (removeMember.isPending) return;
    if (!window.confirm(t("team.removeMemberConfirm"))) return;
    removeMember.mutate(
      { squadId: squad.id, memberType, memberId },
      {
        onSuccess: () => pushToast(t("team.removed"), { kind: "success" }),
        onError: (err) => pushToast(t(removeMemberErrorKey(err)), { kind: "error" }),
      },
    );
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* 头部:团队名 + 成员数 + 操作(编辑/生成码/退出) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{squad.name}</span>
        <span style={{ fontSize: 12, color: "var(--text-4)" }}>
          {t("team.memberCount", { count: membersQuery.data?.length ?? 0 })}
        </span>
        {canManage ? (
          <button className="pw-tl-gen" onClick={() => setEditing((v) => !v)}>
            {editing ? t("team.editInfoCancel") : t("team.editInfo")}
          </button>
        ) : null}
        <button className="pw-tl-gen" onClick={handleGenCode} disabled={createJoinCode.isPending}>
          {t("team.genCode")}
        </button>
        <button className="pw-tl-gen" onClick={handleLeave} disabled={leaveSquad.isPending}>
          {t("team.leaveBtn")}
        </button>
      </div>

      {/* 编辑团队信息(仅可管理者) */}
      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>{t("team.teamNameLabel")}</span>
            <input className="pw-input" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>{t("team.teamDescLabel")}</span>
            <input
              className="pw-input"
              placeholder={t("team.teamDescPlaceholder")}
              value={editDesc}
              onChange={(e) => {
                setEditDesc(e.target.value);
                setDescTouched(true);
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="pw-tl-gen pw-btn-primary" onClick={handleSaveInfo} disabled={updateSquad.isPending}>
              {t("team.saveInfo")}
            </button>
          </div>
        </div>
      ) : null}

      {/* 成员列表 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>{t("team.members")}</div>
        {membersQuery.isLoading ? (
          <div style={{ color: "var(--text-4)", fontSize: 12 }}>{t("team.membersLoading")}</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--text-4)", fontSize: 12 }}>{t("team.noMembers")}</div>
        ) : (
          rows.map((row) => {
            const rKey = roleLabelKey(row.role);
            return (
              <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.name}
                </span>
                {row.isAgent ? (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-3)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "1px 6px",
                    }}
                  >
                    {t("team.agentBadge")}
                  </span>
                ) : null}
                {rKey ? <span style={{ fontSize: 11, color: "var(--text-4)" }}>{t(rKey)}</span> : null}
                {/* 移除:仅可管理者可见,leader 不可移除(禁用) */}
                {canManage ? (
                  <button
                    className="pw-tl-gen"
                    onClick={() => handleRemove(row.memberType, row.memberId)}
                    disabled={row.isLeader || removeMember.isPending}
                    title={row.isLeader ? t("team.roleLeader") : t("team.removeMember")}
                  >
                    <Icon.Trash size={13} />
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* 邀请码(生成后展示 + 复制) */}
      {code ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>{t("team.codeLabel")}</span>
            <code style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 15, letterSpacing: 2, fontWeight: 600 }}>
              {code.code}
            </code>
            <button className="pw-tl-gen" onClick={() => handleCopy(code.code)}>
              {t("team.copyCode")}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-4)" }}>
            {t("team.expiresAt", { time: formatExpiry(code.expires_at) })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
