// 「移动到项目」下拉:把一条闪记的归属切到另一个项目,或移到「无项目」。
// 三处复用(列表行 / 宽写作面顶栏 / 右栏速览详情),共享同一套菜单关闭范式
// (hover 离开延时收起 + outside mousedown 关闭,与 PersonalTopBar ProjectMenu /
// TodosView ArchiveMenu 一致),避免三处各写一份导致行为漂移。
//
// currentProjectId 决定两件事:① 从目标列表里排除「当前项目」(移到自己无意义);
// ② 仅当闪记已归某项目时才提供「移到无项目」项——本就无项目的不显示该项。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";
import type { ProjectMeta } from "@cortex-work/core";

export function MoveToProjectMenu({
  projects,
  currentProjectId,
  onPick,
}: {
  projects: ProjectMeta[];
  // 当前闪记所属项目;undefined = 无项目。用于排除自身 + 决定是否显示「移到无项目」。
  currentProjectId?: string;
  // 选「无项目」回传 undefined;选某项目回传其 id。
  onPick: (projectId: string | undefined) => void;
}) {
  const { t } = useTranslation("notes");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => cancelCloseTimer, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onMenuLeave = () => {
    cancelCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 220);
  };
  const onMenuEnter = () => cancelCloseTimer();

  // 目标项目排除当前项目;已归某项目时才提供「移到无项目」。
  const targets = projects.filter((p) => p.id !== currentProjectId);
  const showUnassigned = currentProjectId != null;
  const hasOptions = targets.length > 0 || showUnassigned;

  return (
    <div className="pw-tb-menu-wrap" ref={wrapRef} onMouseLeave={onMenuLeave} onMouseEnter={onMenuEnter}>
      <button
        className={`pw-icon-btn ${open ? "is-on" : ""}`}
        title={t("group.moveToProject")}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon.Folder size={13} />
        <Icon.Chevron size={9} />
      </button>
      {open ? (
        <div className="pw-tb-menu" role="menu">
          {!hasOptions ? (
            <div className="pw-archive-empty">{t("group.noArchivableProject")}</div>
          ) : (
            <>
              {showUnassigned ? (
                <button
                  className="pw-tb-menu-item"
                  role="menuitem"
                  onClick={() => {
                    onPick(undefined);
                    setOpen(false);
                  }}
                >
                  <Icon.Pin size={14} />
                  <span>{t("group.moveToUnassigned")}</span>
                </button>
              ) : null}
              {targets.map((p) => (
                <button
                  key={p.id}
                  className="pw-tb-menu-item"
                  role="menuitem"
                  onClick={() => {
                    onPick(p.id);
                    setOpen(false);
                  }}
                >
                  <Icon.Folder size={14} />
                  <span>{p.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
