import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@cortex-work/ui/icons";
import { organizationListOptions, useCortexUIStore } from "@cortex-work/core";

// Organization switcher pinned at the top of the sidebar. Org list is server
// state (React Query mock); the current org is client state (Zustand). The
// dropdown switches org or signs out.
export function OrgSwitcher() {
  const { data: orgs = [] } = useQuery(organizationListOptions());
  const currentOrgId = useCortexUIStore((s) => s.currentOrgId);
  const setCurrentOrg = useCortexUIStore((s) => s.setCurrentOrg);
  const pushToast = useCortexUIStore((s) => s.pushToast);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = orgs.find((o) => o.id === currentOrgId) ?? orgs[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selectOrg = (id: string, name: string) => {
    setCurrentOrg(id);
    setOpen(false);
    pushToast(`已切换到 ${name}`);
  };

  return (
    <div className="org-switcher-wrap" ref={ref}>
      <button className="org-switcher" data-open={open} onClick={() => setOpen((v) => !v)}>
        <span className="org-avatar">{current?.initials ?? "·"}</span>
        <span className="org-name">{current?.name ?? "组织"}</span>
        <span className="org-chev">
          <Icon.Chevron size={14} />
        </span>
      </button>

      {open ? (
        <div className="org-menu" role="menu">
          <div className="org-menu-label">切换组织</div>
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
              pushToast("组织设置 · 暂未实现");
            }}
          >
            <span className="org-menu-ic">
              <Icon.Settings size={14} />
            </span>
            <span className="org-menu-name">组织设置</span>
          </button>
          <button
            className="org-menu-item danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              pushToast("退出登录 · 暂未实现");
            }}
          >
            <span className="org-menu-ic">
              <Icon.X size={14} />
            </span>
            <span className="org-menu-name">退出登录</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
