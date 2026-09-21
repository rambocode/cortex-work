// 侧栏活动视图(对齐 Codex「查看活动」):点顶部铃铛后,侧栏正文从「置顶 + 项目树」切成按活动排序的扁平列表:
//   消息(消息中心记录,有才显示)→ 优先级(需要你关注的对话)→ 今天 → 昨天 → 更早。
// 每条对话两行:标题 + 归属(项目名 / 聊天),右侧沿用 SessionRow 的 未读蓝点 / 运行态 / 等确认 徽标。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import type { NotificationRecord, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { SessionRow } from "./SessionRow";
import { NotificationList } from "./NotificationBell";

// 「更早」分组默认露出的条数,超出收进「展开显示」。
const EARLIER_VISIBLE = 20;

// 需要关注(进「优先级」分组)的对话 id:手动未读 / 等待确认 / 正在运行 / 已结束但还没看。
// 铃铛角标也用它计数,所以抽成 hook 供侧栏与活动视图共用同一口径。
export function usePrioritySessionIds(sessions: SessionMeta[]): Set<string> {
  const piUiPending = usePersonalStore((s) => s.piUiPending);
  const runningBySession = usePersonalStore((s) => s.runningBySession);
  const runOutcomeBySession = usePersonalStore((s) => s.runOutcomeBySession);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  // 「等确认」谓词与 SessionRow 的徽标一致(confirm / askquestion 才弹 UI)。
  const awaiting = new Set(
    piUiPending
      .filter((p) => p.request.method === "confirm" || p.request.method === "askquestion")
      .map((p) => p.uiSessionId),
  );
  const ids = new Set<string>();
  for (const s of sessions) {
    if (s.relation === "side" || s.archivedAt != null) continue;
    // 已结束徽标只对非当前对话有意义(与 SessionRow 的 !active 守卫同口径)。
    const finishedUnseen = s.id !== activeSessionId && !!runOutcomeBySession[s.id];
    if (s.unread || awaiting.has(s.id) || runningBySession[s.id] || finishedUnseen) ids.add(s.id);
  }
  return ids;
}

// 本地日期的 00:00 时间戳,用于「今天 / 昨天」分组边界。
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function SidebarActivityView({
  sessions,
  projects,
  priorityIds,
  activeSessionId,
  onSelect,
  onToast,
  notifications,
  onClearNotifications,
}: {
  sessions: SessionMeta[];
  projects: ProjectMeta[];
  priorityIds: Set<string>;
  activeSessionId: string | undefined;
  onSelect: (id: string) => void;
  onToast: (text: string) => void;
  notifications: NotificationRecord[];
  onClearNotifications: () => void;
}) {
  const [showAllEarlier, setShowAllEarlier] = useState(false);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  const list = sessions
    .filter((s) => s.relation !== "side" && s.archivedAt == null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const priority = list.filter((s) => priorityIds.has(s.id));
  const rest = list.filter((s) => !priorityIds.has(s.id));
  const today = startOfDay(Date.now());
  const yesterday = today - 24 * 60 * 60 * 1000;
  const todayList = rest.filter((s) => s.updatedAt >= today);
  const yesterdayList = rest.filter((s) => s.updatedAt >= yesterday && s.updatedAt < today);
  const earlier = rest.filter((s) => s.updatedAt < yesterday);
  const earlierVisible = showAllEarlier ? earlier : earlier.slice(0, EARLIER_VISIBLE);

  // 第二行归属:有项目显示项目名;无项目(或项目已被移除)显示「聊天」。
  const renderRow = (s: SessionMeta) => {
    const name = s.projectId ? projectName.get(s.projectId) : undefined;
    return (
      <SessionRow
        key={s.id}
        session={s}
        active={s.id === activeSessionId}
        onSelect={() => onSelect(s.id)}
        onToast={onToast}
        variant="activity"
        meta={name ? { kind: "project", label: name } : { kind: "chat", label: "聊天" }}
      />
    );
  };

  const group = (title: string, items: SessionMeta[]) =>
    items.length > 0 ? (
      <section className="pw-activity-group" aria-label={title}>
        <div className="pw-section-h">
          <span>{title}</span>
        </div>
        {items.map(renderRow)}
      </section>
    ) : null;

  return (
    <div className="pw-activity-view">
      {notifications.length > 0 ? (
        <NotificationList items={notifications} onClear={onClearNotifications} />
      ) : null}
      {group("优先级", priority)}
      {group("今天", todayList)}
      {group("昨天", yesterdayList)}
      {earlier.length > 0 ? (
        <section className="pw-activity-group" aria-label="更早">
          <div className="pw-section-h">
            <span>更早</span>
          </div>
          {earlierVisible.map(renderRow)}
          {earlier.length > EARLIER_VISIBLE ? (
            <button
              className="pw-session-more"
              data-collapsed={!showAllEarlier}
              onClick={() => setShowAllEarlier((v) => !v)}
            >
              <span className="chev">
                <Icon.Chevron size={10} />
              </span>
              <span>{showAllEarlier ? "折叠显示" : `展开显示 (${earlier.length - EARLIER_VISIBLE})`}</span>
            </button>
          ) : null}
        </section>
      ) : null}
      {list.length === 0 && notifications.length === 0 ? (
        <div className="pw-project-switch-empty">暂无活动</div>
      ) : null}
    </div>
  );
}
