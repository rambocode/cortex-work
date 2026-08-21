// 服务器工作区选择器（herdrm 式两级列表）：daemon 机器分组头（在线点）→ 工作区行
// （名称 + 共享/独立徽标 + 空闲/我在用/被占用·排队 N）。以 popover 形式挂在会话
// Composer 的选择 pill 下，也可被设置页内嵌复用。选中结果写 useTeamUIStore（客户端态），
// 权威占用态仍在 React Query——本组件只读。

import { useEffect, useRef } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  pickRuntime,
  useCoreContext,
  useServerWorkspaces,
  useTeamUIStore,
  workspaceOccupancy,
  type ServerWorkspaceSelection,
} from "@cortex-work/core";
import type { ServerWorkspace } from "@cortex-work/core/api/types";

export function ServerWorkspacePicker({
  targetId,
  onPicked,
  onClose,
}: {
  // 会话目标（contactId / 分身 runtime_id）：选择按目标记忆，切会话互不影响。
  targetId: string;
  onPicked?: (sel: ServerWorkspaceSelection) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { identity } = useCoreContext();
  const { data, isLoading } = useServerWorkspaces();
  const setSelection = useTeamUIStore((s) => s.setSelection);
  const current = useTeamUIStore((s) => s.selection[targetId]);
  const ref = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭（浮层老规矩：mousedown 捕获阶段判定，避免选中行的 click 先被外点关闭吃掉）。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const groups = data?.groups ?? [];

  return (
    <div className="serverws-picker" ref={ref} role="listbox" aria-label={t("serverWs.pickerTitle")}>
      <div className="serverws-picker-head">{t("serverWs.pickerTitle")}</div>
      {groups.length === 0 ? (
        <div className="serverws-empty-hint">{isLoading ? t("loading") : t("serverWs.pickerEmpty")}</div>
      ) : (
        groups.map((g) => (
          <div key={g.daemonId} className="serverws-picker-group">
            <div className="serverws-picker-machine">
              <span className={`mini-dot ${g.online ? "green" : "amber"}`} />
              <b>{g.label}</b>
            </div>
            {g.workspaces
              .filter((sw) => sw.status !== "error")
              .map((sw) => {
                const runtime = pickRuntime(g);
                const occupancy = workspaceOccupancy(sw, identity.userId);
                const disabled = sw.status !== "ready" || !runtime;
                return (
                  <button
                    key={sw.id}
                    className={`serverws-picker-row ${current?.serverWorkspaceId === sw.id ? "is-active" : ""}`}
                    disabled={disabled}
                    onClick={() => {
                      const sel = { runtimeId: runtime!.id, serverWorkspaceId: sw.id };
                      setSelection(targetId, sel);
                      onPicked?.(sel);
                      onClose();
                    }}
                  >
                    <Icon.Folder size={13} />
                    <span className="serverws-picker-name">{sw.name}</span>
                    <em className={`serverws-mode-badge is-${sw.mode}`}>
                      {sw.mode === "shared" ? t("serverWs.badgeShared") : t("serverWs.badgeIsolated")}
                    </em>
                    <small>{pickerStatusText(sw, occupancy, t)}</small>
                  </button>
                );
              })}
          </div>
        ))
      )}
    </div>
  );
}

// 行尾状态短文案：provisioning 优先，其后按占用态。
function pickerStatusText(
  sw: ServerWorkspace,
  occupancy: "free" | "mine" | "occupied",
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (sw.status === "provisioning") return t("serverWs.statusProvisioning");
  if (occupancy === "occupied")
    return sw.queue_depth ? `${t("serverWs.occupiedBy")} · ${t("serverWs.queueDepth", { n: sw.queue_depth })}` : t("serverWs.occupiedBy");
  if (occupancy === "mine") return t("serverWs.mine");
  return t("serverWs.free");
}
