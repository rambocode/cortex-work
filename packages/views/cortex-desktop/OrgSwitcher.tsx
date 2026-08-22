import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  organizationListOptions,
  useCoreContext,
  useCortexUIStore,
  useMyInvitations,
  useWorkspaceId,
  workspaceKeys,
} from "@cortex-work/core";
import { TeamManageModal } from "./team/TeamManageModal";

// Organization switcher pinned at the top of the sidebar. Org list is server
// state (React Query mock); the current org is client state (Zustand). The
// dropdown switches org or signs out. 团队管理(建团/邀请码/退团,U9)从此菜单进入。
// onLogout 由桌面壳经 Sidebar 透传(W1 应用内登录);未接线场景(web/旧壳)缺省 →
// 退出菜单项兜底走原有 toast 占位。
export function OrgSwitcher({
  onLogout,
  onWorkspaceSwitch,
}: {
  onLogout?: () => void;
  // 真实 workspace 切换（apiClient 可用时）:上抛给壳改 wsId + 持久化;缺省回落 toast 占位。
  onWorkspaceSwitch?: (ws: { id: string; name: string; slug?: string }) => void;
}) {
  const { t } = useTranslation();
  const { apiClient } = useCoreContext();
  const wsId = useWorkspaceId();
  const { data: mockOrgs = [] } = useQuery(organizationListOptions());
  // 真实团队列表(登录态):替代 mock orgs。key 不带 wsId(「我所属的全部 workspace」跨租户)。
  const { data: realWorkspaces = [] } = useQuery({
    queryKey: workspaceKeys.list(),
    queryFn: () => apiClient!.listWorkspaces(),
    enabled: !!apiClient,
    staleTime: 60_000,
  });
  const live = !!apiClient;
  // 统一形状:{id, name, initials}。live 用真实 workspace(initials 取名称前两字符)。
  const orgs = live
    ? realWorkspaces.map((w) => ({ id: w.id, name: w.name, initials: w.name.trim().slice(0, 2) || "·", slug: w.slug }))
    : mockOrgs;
  // 我的 pending 邀请数(仅 apiClient 可用时启用;mock/web 无后端 → 空闲);用于团队管理入口徽标。
  const { data: invitations = [] } = useMyInvitations();
  const pendingInvites = invitations.length;
  const currentOrgId = useCortexUIStore((s) => s.currentOrgId);
  const setCurrentOrg = useCortexUIStore((s) => s.setCurrentOrg);
  const pushToast = useCortexUIStore((s) => s.pushToast);

  const [open, setOpen] = useState(false);
  // 团队管理弹层开关(最小侵入:仅本组件持有,不外溢到 Sidebar props)。
  const [teamOpen, setTeamOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // 退出二次确认(与 auth/LoginGate.tsx 原 AccountBar 同一模式):首次点击只置
  // confirming=true 并起 2s 定时器自动回退,第二次点击(confirming 已为 true)才真正
  // 调用 onLogout。注意:点击外部会关闭整个下拉菜单(见下方 mousedown 监听),届时
  // confirming 态随菜单卸载一并清空——这是可接受的行为差异,不做额外持久化。
  const [confirming, setConfirming] = useState(false);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(logoutTimerRef.current), []);

  // live 按真实 wsId 定位当前团队;mock 沿用 Zustand currentOrgId。
  const current = live ? (orgs.find((o) => o.id === wsId) ?? orgs[0]) : (orgs.find((o) => o.id === currentOrgId) ?? orgs[0]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selectOrg = (id: string, name: string) => {
    setOpen(false);
    if (live) {
      if (id === wsId) return;
      const ws = orgs.find((o) => o.id === id);
      if (onWorkspaceSwitch && ws) {
        // 真实切换:壳改 wsId(全部 query key 换命名空间)并持久化。
        onWorkspaceSwitch({ id: ws.id, name: ws.name, slug: (ws as { slug?: string }).slug });
        pushToast(t("orgSwitcher.switchedTo", { name }));
      } else {
        pushToast(t("orgSwitcher.switchedTo", { name }) + " · 未接线");
      }
      return;
    }
    setCurrentOrg(id);
    pushToast(t("orgSwitcher.switchedTo", { name }));
  };

  return (
    <div className="org-switcher-wrap" ref={ref}>
      <button
        className="org-switcher"
        data-open={open}
        onClick={() => setOpen((v) => !v)}
        style={{ position: "relative" }}
      >
        <span className="org-avatar">{current?.initials ?? "·"}</span>
        <span className="org-name">{current?.name ?? t("orgSwitcher.org")}</span>
        <span className="org-chev">
          <Icon.Chevron size={14} />
        </span>
        {/* 有待处理邀请时,收起状态下也提示一个小红点 */}
        {pendingInvites > 0 ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--danger, #e5484d)",
            }}
          />
        ) : null}
      </button>

      {open ? (
        <div className="org-menu" role="menu">
          <div className="org-menu-label">{t("orgSwitcher.switchOrg")}</div>
          {orgs.map((o) => (
            <button key={o.id} className="org-menu-item" role="menuitem" onClick={() => selectOrg(o.id, o.name)}>
              <span className="org-avatar sm">{o.initials}</span>
              <span className="org-menu-name">{o.name}</span>
              {o.id === current?.id ? (
                <span className="org-check">
                  <Icon.Check size={13} />
                </span>
              ) : null}
            </button>
          ))}
          <div className="org-menu-sep" />
          <button
            className="org-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setTeamOpen(true);
            }}
          >
            <span className="org-menu-ic">
              <Icon.Users size={14} />
            </span>
            <span className="org-menu-name">{t("team.manageEntry")}</span>
            {/* pending 邀请计数徽标(有待处理邀请时显示) */}
            {pendingInvites > 0 ? (
              <span
                style={{
                  marginLeft: "auto",
                  minWidth: 18,
                  height: 18,
                  padding: "0 5px",
                  borderRadius: 9,
                  background: "var(--danger, #e5484d)",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {pendingInvites}
              </span>
            ) : null}
          </button>
          <button
            className="org-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              pushToast(t("orgSwitcher.orgSettingsToast"));
            }}
          >
            <span className="org-menu-ic">
              <Icon.Settings size={14} />
            </span>
            <span className="org-menu-name">{t("orgSwitcher.orgSettings")}</span>
          </button>
          <button
            className="org-menu-item danger"
            role="menuitem"
            onClick={() => {
              if (!onLogout) {
                // 未接线真实登录(web/旧壳):保留原有 toast 占位行为。
                setOpen(false);
                pushToast(t("orgSwitcher.logoutToast"));
                return;
              }
              if (confirming) {
                clearTimeout(logoutTimerRef.current);
                onLogout();
                setOpen(false);
                return;
              }
              setConfirming(true);
              logoutTimerRef.current = setTimeout(() => setConfirming(false), 2000);
            }}
          >
            <span className="org-menu-ic">
              <Icon.X size={14} />
            </span>
            <span className="org-menu-name">
              {onLogout && confirming ? t("orgSwitcher.logoutConfirm") : t("orgSwitcher.logout")}
            </span>
          </button>
        </div>
      ) : null}

      {teamOpen ? <TeamManageModal onClose={() => setTeamOpen(false)} /> : null}
    </div>
  );
}
