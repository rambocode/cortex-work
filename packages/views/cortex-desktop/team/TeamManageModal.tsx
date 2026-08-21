// 团队管理弹层(W2):三页签模态 —— 团队(列表+详情+建团) / 邀请(邀请成员+我的邀请) / 凭码加入。
// 复用 .pw-dlg-overlay/.pw-dlg 模态外壳与 .pw-input/.pw-tl-gen 控件,布局用内联样式(不新增 CSS)。
// 数据/失效范式在 core/cortex/teams.ts;本组件只做页签编排、建团/加入表单与错误码→文案呈现。
// 团队详情(成员/编辑/码/退出)委托 SquadCard;邀请页委托 TeamInvitesTab。
// 关闭语义:关闭按钮 / Esc / 遮罩点击 → onClose。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  useSquadsQuery,
  useCreateSquad,
  useJoinByCode,
  useWorkspaceMembers,
  createSquadErrorKey,
  joinSquadErrorKey,
  resolveWorkspaceRole,
  canManageWorkspace,
  useCoreContext,
  useCortexUIStore,
} from "@cortex-work/core";
import { SquadCard } from "./SquadCard";
import { TeamInvitesTab } from "./TeamInvitesTab";

type Tab = "teams" | "invites" | "join";

export function TeamManageModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const pushToast = useCortexUIStore((s) => s.pushToast);
  const { identity } = useCoreContext();

  const squadsQuery = useSquadsQuery();
  const wsMembersQuery = useWorkspaceMembers();
  const createSquad = useCreateSquad();
  const joinByCode = useJoinByCode();

  const [tab, setTab] = useState<Tab>("teams");
  const [newName, setNewName] = useState("");
  const [joinCode, setJoinCode] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const squads = squadsQuery.data ?? [];
  const wsMembers = wsMembersQuery.data ?? [];
  // 团队管理(建/邀请/移除/改信息)需 workspace owner/admin;非管理者仍可看列表与退出/加入。
  const canManage = canManageWorkspace(resolveWorkspaceRole(wsMembers, identity.userId));

  const handleCreate = () => {
    const name = newName.trim();
    if (!name || createSquad.isPending) return;
    createSquad.mutate(name, {
      onSuccess: (squad) => {
        setNewName("");
        pushToast(t("team.created", { name: squad.name }), { kind: "success" });
      },
      onError: (err) => pushToast(t(createSquadErrorKey(err)), { kind: "error" }),
    });
  };

  const handleJoin = () => {
    const code = joinCode.trim();
    if (!code || joinByCode.isPending) return;
    joinByCode.mutate(code, {
      onSuccess: (res) => {
        setJoinCode("");
        // 幂等:already_member=true 表示已在团(非错误),走 info 呈现。
        if (res.already_member) pushToast(t("team.alreadyMember"), { kind: "info" });
        else pushToast(t("team.joined"), { kind: "success" });
      },
      onError: (err) => pushToast(t(joinSquadErrorKey(err)), { kind: "error" }),
    });
  };

  const tabBtn = (id: Tab, label: string) => (
    <button
      className="pw-tl-gen"
      onClick={() => setTab(id)}
      data-active={tab === id}
      style={{
        fontWeight: tab === id ? 600 : 400,
        borderBottom: tab === id ? "2px solid var(--accent, var(--text-1))" : "2px solid transparent",
        borderRadius: 0,
        background: "transparent",
        padding: "6px 4px",
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
      <div
        className="pw-dlg pw-upd-dlg"
        role="dialog"
        aria-label={t("team.title")}
        onClick={(e) => e.stopPropagation()}
        style={{ display: "flex", flexDirection: "column", gap: 0 }}
      >
        <button className="pw-dlg-x" title={t("team.close")} onClick={onClose}>
          <Icon.X size={15} />
        </button>
        <div className="pw-upd-dlg-h">{t("team.title")}</div>

        {/* 页签切换 */}
        <div style={{ display: "flex", gap: 14, padding: "0 20px", borderBottom: "1px solid var(--border)" }}>
          {tabBtn("teams", t("team.tabTeams"))}
          {tabBtn("invites", t("team.tabInvites"))}
          {tabBtn("join", t("team.tabJoin"))}
        </div>

        <div style={{ overflowY: "auto", padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 22 }}>
          {tab === "teams" ? (
            <>
              {/* 建团(仅管理者) */}
              {canManage ? (
                <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("team.createTitle")}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="pw-input"
                      placeholder={t("team.teamNamePlaceholder")}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                    />
                    <button
                      className="pw-tl-gen pw-btn-primary"
                      onClick={handleCreate}
                      disabled={!newName.trim() || createSquad.isPending}
                    >
                      {t("team.createBtn")}
                    </button>
                  </div>
                </section>
              ) : null}

              {/* 我的团队 */}
              <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("team.myTeams")}</div>
                {squadsQuery.isLoading ? (
                  <div style={{ color: "var(--text-4)", fontSize: 13 }}>{t("team.loading")}</div>
                ) : squads.length === 0 ? (
                  <div style={{ color: "var(--text-4)", fontSize: 13 }}>{t("team.noTeams")}</div>
                ) : (
                  squads.map((s) => <SquadCard key={s.id} squad={s} canManage={canManage} wsMembers={wsMembers} />)
                )}
              </section>
            </>
          ) : null}

          {tab === "invites" ? <TeamInvitesTab /> : null}

          {tab === "join" ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("team.joinTitle")}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="pw-input"
                  placeholder={t("team.codePlaceholder")}
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                />
                <button
                  className="pw-tl-gen pw-btn-primary"
                  onClick={handleJoin}
                  disabled={!joinCode.trim() || joinByCode.isPending}
                >
                  {t("team.joinBtn")}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
