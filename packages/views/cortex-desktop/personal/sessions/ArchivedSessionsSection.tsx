import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "@cortex-work/ui/icons";
import {
  closePiSession,
  partitionArchivedSessions,
  reapSessionRun,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { SessionMeta } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { SettingCard } from "../settings/settingsControls";
import { relTime } from "../layout/PersonalSidebar";

// 设置页「已归档对话」分区:集中展示所有 archivedAt != null 的会话,按项目(文件夹)分组、
// 顶部搜索 + 已归档计数。每条:点击标题=打开会话详情(setActiveSession,不改归档态);
// 「取消归档」按钮=unarchiveSession(条目离开列表,停留设置页);删除=就地二次确认后走
// 与侧边栏一致的四步(reapSessionRun→removeSession→deleteChat→closePiSession),四步缺一留孤儿。
// 纯 UI 消费层:不新增 IPC,归档/删除状态随既有 store:save 落盘。

// 单条归档会话行(独立组件以隔离各自的删除二次确认态)。
function ArchivedRow({
  session,
  onOpen,
  onUnarchive,
  onDelete,
}: {
  session: SessionMeta;
  onOpen: (id: string) => void;
  onUnarchive: (s: SessionMeta) => void;
  onDelete: (s: SessionMeta) => void;
}) {
  const { t } = useTranslation("settings");
  const [confirming, setConfirming] = useState(false);

  const handleDelete = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    onDelete(session);
  };

  const meta = session.model ? `${relTime(session.updatedAt)} · ${session.model}` : relTime(session.updatedAt);

  return (
    <div className="pw-arch-row" onMouseLeave={() => setConfirming(false)}>
      <button className="pw-arch-open" onClick={() => onOpen(session.id)} title={session.title}>
        <span className="pw-arch-title">{session.title}</span>
        <span className="pw-arch-meta">{meta}</span>
      </button>
      <div className="pw-arch-acts">
        <button className="pw-btn pw-arch-unarchive" onClick={() => onUnarchive(session)}>
          <Icon.Reply size={13} />
          <span>{t("archivedSessions.unarchive")}</span>
        </button>
        <button
          className={`pw-icon-btn pw-arch-del ${confirming ? "is-danger" : ""}`}
          title={confirming ? t("archivedSessions.deleteConfirm") : t("archivedSessions.delete")}
          onClick={handleDelete}
        >
          {confirming ? <Icon.Check size={14} /> : <Icon.Trash size={14} />}
        </button>
      </div>
    </div>
  );
}

export function ArchivedSessionsSection() {
  const { t } = useTranslation("settings");
  const sessions = usePersonalStore((s) => s.sessions);
  const projects = usePersonalStore((s) => s.projects);
  const unarchiveSession = usePersonalStore((s) => s.unarchiveSession);
  const removeSession = usePersonalStore((s) => s.removeSession);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const pushToast = useCortexUIStore((s) => s.pushToast);
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");

  const { groups, archivedTotal, filteredTotal } = partitionArchivedSessions(sessions, query);

  // 项目 id → 文件夹名;orphan(项目已删除但会话 projectId 仍在)回退「已删除项目」,防崩溃/留空。
  const folderName = (projectId?: string): string => {
    if (projectId == null) return t("archivedSessions.noProject");
    const p = projects.find((x) => x.id === projectId);
    return p ? p.name : t("archivedSessions.deletedProject");
  };

  // 打开会话详情:仅设为活跃(setActiveSession 内部已置 settingsOpen:false 并跳转),不改归档态。
  const openDetail = (id: string) => setActiveSession(id);

  const onUnarchive = (s: SessionMeta) => {
    unarchiveSession(s.id);
    pushToast(t("archivedSessions.unarchiveToast", { title: s.title }));
  };

  // 永久删除:四步与侧边栏 SessionRow 完全一致,缺一会留孤儿(看门狗 interval / 磁盘文件 / pi 进程)。
  const onDelete = (s: SessionMeta) => {
    reapSessionRun(qc, s.id);
    removeSession(s.id);
    void bridge?.deleteChat?.(s.id);
    void closePiSession(bridge, s.id);
    pushToast(t("archivedSessions.deleteToast", { title: s.title }));
  };

  // 搜索框 ESC:query 非空时仅清空并阻止冒泡;空时透传(由设置页全局 ESC 关闭)。
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) {
      e.stopPropagation();
      setQuery("");
    }
  };

  return (
    <SettingCard title={t("archivedSessions.title")}>
      <div className="pw-arch">
        <div className="pw-arch-intro">
          <div className="pw-arch-subtitle">{t("archivedSessions.subtitle")}</div>
          <div className="pw-arch-desc">{t("archivedSessions.desc")}</div>
        </div>

        <div className="pw-arch-toolbar">
          <div className="pw-arch-search">
            <Icon.Search size={15} />
            <input
              className="pw-arch-search-input"
              type="text"
              value={query}
              placeholder={t("archivedSessions.searchPlaceholder")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <span className="pw-arch-chip">
            <Icon.Archive size={13} />
            {t("archivedSessions.countBadge", { count: archivedTotal })}
          </span>
        </div>

        {archivedTotal === 0 ? (
          <div className="pw-arch-empty">{t("archivedSessions.empty")}</div>
        ) : filteredTotal === 0 ? (
          <div className="pw-arch-empty">
            <span>{t("archivedSessions.searchEmpty")}</span>
            <button className="pw-arch-clear" onClick={() => setQuery("")}>
              {t("archivedSessions.clearSearch")}
            </button>
          </div>
        ) : (
          <div className="pw-arch-list">
            {groups.map((g) => (
              <div className="pw-arch-group" key={g.projectId ?? "__noproject__"}>
                <div className="pw-arch-group-h">
                  <Icon.Folder size={14} />
                  <span className="pw-arch-group-name">{folderName(g.projectId)}</span>
                  <span className="pw-arch-group-count">
                    {t("archivedSessions.groupCount", { count: g.sessions.length })}
                  </span>
                </div>
                {g.sessions.map((s) => (
                  <ArchivedRow
                    key={s.id}
                    session={s}
                    onOpen={openDetail}
                    onUnarchive={onUnarchive}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingCard>
  );
}
