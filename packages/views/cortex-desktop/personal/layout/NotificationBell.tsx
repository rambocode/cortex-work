// 侧栏顶部铃铛(对齐 Codex「查看活动」):点击切换侧栏的活动视图,而不是弹 popover。
// 消息中心(主进程 notifications.json)的记录并入活动视图顶部「消息」分组展示。
//
// 数据源是主进程的 notifications.json（main-owned，见 ipc/notification-center.ts）：
// 写入方全在主进程且**主窗常常没开**（自动化无头执行、任务提醒定时器、更新检查），
// 所以这里只订阅 + 只读，不在渲染端维护任何本地消息状态。
//
// 挂载时 list() 拉一次全量，之后靠 onNotificationCenterChanged 增量推全量快照。
// 两者都要：推送只覆盖「本窗口存活期间」，冷启动/重开窗必须靠 list 补拉。

import { useCallback, useEffect, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import type { NotificationRecord } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { relTime } from "./relTime";

// 各来源在列表里的图标（与触发它的功能入口图标保持一致，用户一眼认出是哪来的）。
const SOURCE_ICON: Record<NotificationRecord["source"], typeof Icon.Bell> = {
  "task-reminder": Icon.Bell,
  automation: Icon.Workflow,
  workflow: Icon.GitBranch,
  update: Icon.Download,
};

// 订阅消息中心:返回全量记录、未读数与 已读 / 清空 操作。旧壳 / web 无桥时 available=false、列表恒空。
export function useNotificationCenter() {
  const bridge = useDesktopBridge();
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const available = !!bridge?.notificationCenterList;

  const refresh = useCallback(async () => {
    if (!bridge?.notificationCenterList) return;
    try {
      setItems(await bridge.notificationCenterList());
    } catch {
      // 读失败保持上一份快照（宁可显示旧数据，也不要把列表清空吓人）
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    // 订阅主进程推送的全量快照；返回值是取消订阅函数（旧壳可能没有该方法）。
    return bridge?.onNotificationCenterChanged?.((list) => setItems(list));
  }, [bridge, refresh]);

  const unread = items.filter((n) => n.readAt == null).length;
  const markRead = useCallback(() => {
    void bridge?.notificationCenterMarkRead?.();
  }, [bridge]);
  const clear = useCallback(() => {
    void bridge?.notificationCenterClear?.();
  }, [bridge]);

  return { available, items, unread, markRead, clear };
}

// 铃铛按钮:切换活动视图。badge = 需要关注的数量(未读消息 + 优先级对话),>0 时右上角出蓝点(不显示数字)。
export function NotificationBell({
  active,
  badge,
  onToggle,
}: {
  active: boolean;
  badge: number;
  onToggle: () => void;
}) {
  const label = active ? "关闭活动视图" : "查看活动";
  return (
    <button
      type="button"
      className={`pw-sb-bell ${active ? "is-open" : ""}`}
      aria-pressed={active}
      aria-label={badge > 0 ? `${label}（${badge} 条待关注）` : label}
      title={`${label} (⌥⌘U)`}
      onClick={onToggle}
    >
      <Icon.Bell size={15} />
      {/* 只标「有待关注」,不显示数字(对齐 Codex);条数已写进 aria-label。 */}
      {badge > 0 ? <span className="pw-sb-bell-dot" /> : null}
    </button>
  );
}

// 活动视图里的「消息」列表(原 popover 内容)。空列表不渲染(由调用方决定是否显示该分组)。
export function NotificationList({ items, onClear }: { items: NotificationRecord[]; onClear: () => void }) {
  return (
    <div className="pw-activity-msgs" aria-label="消息列表">
      <div className="pw-section-h">
        <span>消息</span>
        <button type="button" className="pw-sb-msgs-clear" onClick={onClear}>
          清空
        </button>
      </div>
      {items.map((n) => {
        const SrcIcon = SOURCE_ICON[n.source] ?? Icon.Bell;
        return (
          <div key={n.id} className={`pw-sb-msg is-${n.level}`}>
            <span className="pw-sb-msg-icon">
              <SrcIcon size={14} />
            </span>
            <div className="pw-sb-msg-main">
              <div className="pw-sb-msg-title">{n.title}</div>
              {n.body ? <div className="pw-sb-msg-body">{n.body}</div> : null}
              <div className="pw-sb-msg-time">{relTime(n.createdAt)}</div>
            </div>
          </div>
        );
      })}
      {/* 保留期告知：用户看到旧消息消失时不会以为是 bug。 */}
      <div className="pw-sb-msgs-foot">消息保留 60 天</div>
    </div>
  );
}
