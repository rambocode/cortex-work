// 侧栏对话行(从 PersonalSidebar 拆出,供项目树 / 置顶分区 / 活动视图共用)。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  closePiSession,
  discardSessionChat,
  reapSessionRun,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { SessionMeta } from "@cortex-work/core";
import { relTime } from "./relTime";
import { SESSION_DRAG_MIME } from "./conversation-drag";
import { useHoverMarquee } from "./useHoverMarquee";
import { SessionMenu } from "./SessionMenu";

// 会话行:悬停在右侧浮现「⋯」(重命名 / 置顶 / 标记为未读 / 归档 / 删除 菜单)+「置顶」图钉(对齐 Codex)。
// 手动标记未读的对话在行尾显示蓝点;variant="pinned" 用于顶部「置顶」分区,前面带对话气泡图标;
// variant="activity" 用于活动视图:两行布局,标题下方一行显示归属(项目名 / 聊天)。
export function SessionRow({
  session,
  active,
  onSelect,
  onToast,
  variant = "tree",
  meta,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: () => void;
  onToast: (text: string) => void;
  variant?: "tree" | "pinned" | "activity";
  // 活动视图第二行:归属项目(文件夹图标 + 项目名)或无项目「聊天」(气泡图标)。
  meta?: { kind: "project" | "chat"; label: string };
}) {
  const bridge = useDesktopBridge();
  const archiveSession = usePersonalStore((s) => s.archiveSession);
  const unarchiveSession = usePersonalStore((s) => s.unarchiveSession);
  const removeSession = usePersonalStore((s) => s.removeSession);
  const renameSession = usePersonalStore((s) => s.renameSession);
  const toggleSessionPin = usePersonalStore((s) => s.toggleSessionPin);
  const setSessionUnread = usePersonalStore((s) => s.setSessionUnread);
  const qc = useQueryClient();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const archived = session.archivedAt != null;
  // 超长标题悬停时左右滚动显示全文。
  const marquee = useHoverMarquee();

  // 会话运行状态徽标三态派生:等待确认 > 正在运行 > 已结束(仅非活跃行)。
  // 三个 selector 均返回布尔/store 内稳定引用——96+ 会话时避免整 map/数组订阅引发全列表重渲。
  // 「等确认」谓词与 PiToolConfirmDialog(confirm)/AskQuestionCard(askquestion)一致,
  // jsrepl/select/input 等不弹 UI 的 method 天然排除;delegate 子会话审批已映射到父会话 uiSessionId。
  const awaitingConfirm = usePersonalStore((s) =>
    s.piUiPending.some(
      (p) =>
        p.uiSessionId === session.id &&
        (p.request.method === "confirm" || p.request.method === "askquestion"),
    ),
  );
  const running = usePersonalStore((s) => Boolean(s.runningBySession[session.id]));
  const outcome = usePersonalStore((s) => s.runOutcomeBySession[session.id]);
  // 读侧 !active 与写侧 markRunOutcome 的 active 守卫、setActiveSession 清除构成三道保险。
  const status = awaitingConfirm
    ? ("confirm" as const)
    : running
      ? ("running" as const)
      : !active && outcome
        ? outcome.ok
          ? ("ok" as const)
          : ("fail" as const)
        : null;
  const statusLabel =
    status === "confirm"
      ? "等待确认"
      : status === "running"
        ? "正在运行"
        : status === "ok"
          ? `已完成 · ${relTime(outcome?.endedAt ?? Date.now())}`
          : status === "fail"
            ? `已失败 · ${relTime(outcome?.endedAt ?? Date.now())}`
            : undefined;

  const commitRename = () => {
    if (renameDraft === null) return;
    renameSession(session.id, renameDraft);
    setRenameDraft(null);
  };

  const pinned = session.pinnedAt != null;
  const onTogglePin = () => {
    toggleSessionPin(session.id);
    onToast(pinned ? `已取消置顶 ${session.title}` : `已置顶 ${session.title}`);
  };

  const onArchive = () => {
    if (archived) {
      unarchiveSession(session.id);
      onToast(`已取消归档 ${session.title}`);
    } else {
      archiveSession(session.id);
      onToast(`已归档 ${session.title}`);
    }
  };

  // 删除(菜单内已做二次确认)。
  const onDelete = () => {
    const removedIds = removeSession(session.id); // 即时移除 UI，并级联取回 side 子会话 id。
    for (const sessionId of removedIds) {
      reapSessionRun(qc, sessionId); // 回收 renderer run(停看门狗/清 running),防孤儿 interval
      discardSessionChat(qc, sessionId); // 取消 reap 排出的节流保存，防 chat:delete 后旧缓存复活磁盘文件。
      void bridge?.deleteChat?.(sessionId); // 物理删父/子会话磁盘消息文件
      void closePiSession(bridge, sessionId); // 终止对应 pi 长驻进程（非 pi 会话 no-op）
    }
    onToast(`已删除 ${session.title}`);
  };

  return (
    <div
      className="pw-session-row"
      data-archived={archived}
      data-variant={variant}
      data-menu-open={menuAnchor ? "true" : undefined}
      onMouseEnter={marquee.start}
      onMouseLeave={marquee.stop}
    >
      {renameDraft !== null ? (
        <div className={`pw-session pw-session-rename ${active ? "is-active" : ""}`}>
          <input
            autoFocus
            className="pw-session-rename-input"
            aria-label="会话名称"
            value={renameDraft}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenameDraft(null);
              }
            }}
          />
        </div>
      ) : (
        <button
          className={`pw-session ${active ? "is-active" : ""}`}
          draggable
          title="拖到会话窗格的上、下、左、右以拆分"
          onClick={onSelect}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(SESSION_DRAG_MIME, session.id);
          }}
        >
          {variant === "pinned" ? <Icon.MessageCircle size={16} className="pw-session-lead" /> : null}
          {status === "confirm" ? (
            // 等确认点绝对定位于标题左侧 26px 缩进空白区,不挤压标题、不受 hover 时间隐藏规则影响。
            <span
              className="pw-session-status is-confirm"
              data-status="confirm"
              title={statusLabel}
              aria-label={statusLabel}
            />
          ) : null}
          {variant === "activity" ? (
            <span className="pw-session-main">
              <span
                ref={marquee.containerRef}
                className={`pw-session-title ${marquee.scrolling ? "is-scrolling" : ""}`}
                style={marquee.style}
              >
                <span className="pw-session-title-text">{session.title}</span>
              </span>
              {meta ? (
                <span className="pw-session-meta">
                  {meta.kind === "project" ? <Icon.Folder size={12} /> : <Icon.MessageCircle size={12} />}
                  <span>{meta.label}</span>
                </span>
              ) : null}
            </span>
          ) : (
            <span
              ref={marquee.containerRef}
              className={`pw-session-title ${marquee.scrolling ? "is-scrolling" : ""}`}
              style={marquee.style}
            >
              <span className="pw-session-title-text">{session.title}</span>
            </span>
          )}
          {status === "running" ? (
            // 运行中 loading 环占用右侧时间位(运行中相对时间无意义,hover 让位规则与时间同款)。
            <span
              className="pw-session-status is-running"
              data-status="running"
              title={statusLabel}
              aria-label={statusLabel}
            />
          ) : status === "ok" || status === "fail" ? (
            // 已结束成功/失败 icon 同样占右侧时间位;endedAt 详情在 title tooltip 里。
            <span
              className={`pw-session-status is-${status}`}
              data-status={status}
              title={statusLabel}
              aria-label={statusLabel}
            >
              {status === "ok" ? <Icon.CheckCircle size={12} /> : <Icon.XCircle size={12} />}
            </span>
          ) : session.unread ? (
            // 手动标记未读:蓝点占右侧时间位(打开对话即清除)。
            <span className="pw-session-unread" role="img" aria-label="未读" title="未读" />
          ) : (
            <span className="pw-session-time">{relTime(session.updatedAt)}</span>
          )}
        </button>
      )}
      {renameDraft === null ? (
        <div className="pw-session-actions">
          <button
            className={`pw-icon-btn pw-session-act ${menuAnchor ? "is-active" : ""}`}
            title="更多"
            aria-label={`${session.title} 更多操作`}
            aria-haspopup="menu"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <Icon.More size={14} />
          </button>
          {!archived ? (
            <button
              className={`pw-icon-btn pw-session-act ${pinned ? "is-on" : ""}`}
              title={pinned ? "取消置顶" : "置顶"}
              aria-label={pinned ? `取消置顶 ${session.title}` : `置顶 ${session.title}`}
              aria-pressed={pinned}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin();
              }}
            >
              <Icon.Pushpin size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
      {menuAnchor ? (
        <SessionMenu
          title={session.title}
          pinned={pinned}
          unread={!!session.unread}
          archived={archived}
          anchor={menuAnchor}
          onRename={() => setRenameDraft(session.title)}
          onTogglePin={onTogglePin}
          onToggleUnread={() => setSessionUnread(session.id, !session.unread)}
          onToggleArchive={onArchive}
          onDelete={onDelete}
          onClose={() => setMenuAnchor(null)}
        />
      ) : null}
    </div>
  );
}
