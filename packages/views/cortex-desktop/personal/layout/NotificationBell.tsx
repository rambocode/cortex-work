// 侧栏底部消息铃铛 + 消息列表 popover。
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
import { useDismissableMenu } from "../shared/useDismissableMenu";
import { relTime } from "./relTime";

// 各来源在列表里的图标（与触发它的功能入口图标保持一致，用户一眼认出是哪来的）。
const SOURCE_ICON: Record<NotificationRecord["source"], typeof Icon.Bell> = {
  "task-reminder": Icon.Bell,
  automation: Icon.Workflow,
  workflow: Icon.GitBranch,
  update: Icon.Download,
};

export function NotificationBell() {
  const bridge = useDesktopBridge();
  const menu = useDismissableMenu();
  const [items, setItems] = useState<NotificationRecord[]>([]);

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

  // 旧壳 / web 端无此桥能力 → 整个铃铛不渲染（而不是渲染一个点了没反应的按钮）。
  if (!bridge?.notificationCenterList) return null;

  const unread = items.filter((n) => n.readAt == null).length;

  // 打开即把当前可见的未读全部标已读：popover 展开就等于用户看到了，
  // 再要求逐条点「已读」是多余操作。红点随之消失。
  const openAndMarkRead = () => {
    const next = !menu.open;
    menu.setOpen(next);
    if (next && unread > 0) void bridge.notificationCenterMarkRead?.();
  };

  return (
    <div className="pw-tb-menu-wrap pw-sb-bell-wrap" ref={menu.wrapRef}>
      <button
        type="button"
        className={`pw-sb-bell ${menu.open ? "is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={menu.open}
        aria-label={unread > 0 ? `消息（${unread} 条未读）` : "消息"}
        title={unread > 0 ? `${unread} 条未读消息` : "消息"}
        onClick={openAndMarkRead}
      >
        <Icon.Bell size={15} />
        {/* 未读红点：只标「有」不标数量到两位以上，99+ 封顶避免撑破圆点。 */}
        {unread > 0 ? <span className="pw-sb-bell-dot">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {menu.open ? (
        <div className="pw-sb-msgs" role="dialog" aria-label="消息列表">
          <div className="pw-sb-msgs-head">
            <span className="pw-sb-msgs-title">消息</span>
            {items.length > 0 ? (
              <button
                type="button"
                className="pw-sb-msgs-clear"
                onClick={() => void bridge.notificationCenterClear?.()}
              >
                清空
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <div className="pw-sb-msgs-empty">暂无消息</div>
          ) : (
            <div className="pw-sb-msgs-list">
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
            </div>
          )}
          {/* 保留期告知：用户看到旧消息消失时不会以为是 bug。 */}
          <div className="pw-sb-msgs-foot">消息保留 60 天</div>
        </div>
      ) : null}
    </div>
  );
}
