// 邀请页签:workspace 级邮箱邀请表单(email+role) + 「我的邀请」pending 列表(接受/拒绝)。
// 数据/失效范式在 core/cortex/teams.ts;本组件只做表单编排与错误码→文案呈现。
// 接受成功后 core 侧全量 invalidate(workspaces+contacts+squads+invitations),UI 只弹 toast。

import { useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  useInviteMember,
  useMyInvitations,
  useAcceptInvitation,
  useDeclineInvitation,
  inviteMemberErrorKey,
  acceptInvitationErrorKey,
  useCortexUIStore,
} from "@cortex-work/core";
import type { InvitationResponse } from "@cortex-work/core/api/types";

// 把 ISO 过期时间格式化为本地可读串;非法值兜底原样返回,避免抛错。
function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function TeamInvitesTab() {
  const { t } = useTranslation();
  const pushToast = useCortexUIStore((s) => s.pushToast);

  const inviteMember = useInviteMember();
  const invitationsQuery = useMyInvitations();
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  const invitations = invitationsQuery.data ?? [];

  const handleInvite = () => {
    const value = email.trim();
    if (!value || inviteMember.isPending) return;
    inviteMember.mutate(
      { email: value, role },
      {
        onSuccess: () => {
          setEmail("");
          pushToast(t("team.invited", { email: value }), { kind: "success" });
        },
        // 403 → 需要管理员权限;其余 → 通用邀请失败(inviteMemberErrorKey 纯映射)。
        onError: (err) => pushToast(t(inviteMemberErrorKey(err)), { kind: "error" }),
      },
    );
  };

  const handleAccept = (inv: InvitationResponse) => {
    if (acceptInvitation.isPending) return;
    acceptInvitation.mutate(inv.id, {
      onSuccess: () => pushToast(t("team.accepted", { workspace: inv.workspace_name }), { kind: "success" }),
      // 410 已过期 / 409 已是成员 / 其它通用失败(acceptInvitationErrorKey 纯映射)。
      onError: (err) => pushToast(t(acceptInvitationErrorKey(err)), { kind: "error" }),
    });
  };

  const handleDecline = (inv: InvitationResponse) => {
    if (declineInvitation.isPending) return;
    declineInvitation.mutate(inv.id, {
      onSuccess: () => pushToast(t("team.declined"), { kind: "info" }),
      onError: () => pushToast(t("team.errAcceptFailed"), { kind: "error" }),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {/* 邀请成员(workspace 级) */}
      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("team.inviteTitle")}</div>
        <div style={{ fontSize: 12, color: "var(--text-4)" }}>{t("team.inviteHint")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="pw-input"
            type="email"
            placeholder={t("team.inviteEmailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInvite()}
            style={{ flex: 1 }}
          />
          <select
            className="pw-input"
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
            style={{ width: 110 }}
          >
            <option value="member">{t("team.inviteRoleMember")}</option>
            <option value="admin">{t("team.inviteRoleAdmin")}</option>
          </select>
          <button
            className="pw-tl-gen pw-btn-primary"
            onClick={handleInvite}
            disabled={!email.trim() || inviteMember.isPending}
          >
            {t("team.inviteBtn")}
          </button>
        </div>
      </section>

      {/* 我的邀请(pending 列表) */}
      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("team.myInvitations")}</div>
        {invitationsQuery.isLoading ? (
          <div style={{ color: "var(--text-4)", fontSize: 13 }}>{t("team.invitationsLoading")}</div>
        ) : invitations.length === 0 ? (
          <div style={{ color: "var(--text-4)", fontSize: 13 }}>{t("team.noInvitations")}</div>
        ) : (
          invitations.map((inv) => (
            <div
              key={inv.id}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 13 }}>
                  {t("team.invitedToJoin", { inviter: inv.inviter_name, workspace: inv.workspace_name })}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-4)" }}>
                  {t("team.invitationExpiresAt", { time: formatExpiry(inv.expires_at) })}
                </span>
              </div>
              <button
                className="pw-tl-gen pw-btn-primary"
                onClick={() => handleAccept(inv)}
                disabled={acceptInvitation.isPending}
              >
                {t("team.acceptBtn")}
              </button>
              <button className="pw-tl-gen" onClick={() => handleDecline(inv)} disabled={declineInvitation.isPending}>
                {t("team.declineBtn")}
              </button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
