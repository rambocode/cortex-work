// 消息中心主进程域（侧栏底部铃铛的数据源）。main 是 owner：notifications.json 单文件全量，
// 经 notificationCenter: 域做读/标已读/清空，变更经 notification-center:changed 推回渲染端。
//
// 为什么 main-owned 而不是渲染端 Zustand：写入方全在主进程且**主窗可能根本没开**——
// 自动化无头执行（关窗仍跑）、任务提醒定时器、更新检查都跑在 main。渲染端持有的话，
// 关窗期间产生的消息会整段丢失，而那恰恰是用户最需要回头看的一批。
//
// 存储核心在 notification-center-store.ts（不依赖 electron，可单测）；本文件只注入
// paths.notificationsStorePath + 注册 ipcMain.handle + broadcast。仿 ipc/notes.ts。

import { BrowserWindow, ipcMain } from "electron";
import { notificationsStorePath } from "../paths";
import { NotificationStore } from "./notification-center-store";
import type { NotificationInput, NotificationRecord } from "./types";

// 单例存储（注入主进程的路径解析）。
const store = new NotificationStore({ notificationsStorePath });

// 推全量快照给所有存活窗口（窗口可能已关，getAllWindows() 返回 [] → 事件丢失但不影响落盘，
// renderer 重开时用 list 补拉）。仿 ipc/notes.ts:broadcastNotesChanged。
function broadcastChanged(list: NotificationRecord[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("notification-center:changed", list);
  }
}

async function emitChanged(): Promise<void> {
  broadcastChanged(await store.list());
}

/// 主进程内部写入口——**所有埋点都走这里**（自动化收尾 / 任务提醒 / 更新可用）。
/// 刻意不暴露成 IPC：消息是主进程事实的存档，渲染端只读，不能自己伪造历史。
///
/// fire-and-forget：写盘失败只在 store 内 log，绝不冒泡影响调用方的主流程
///（自动化收尾、提醒投递都不该因为「消息没存上」而失败）。
export function recordNotification(input: NotificationInput): void {
  void store
    .add(input)
    .then(() => emitChanged())
    .catch(() => {
      // store 内部已 log.error；这里兜住 promise rejection，避免 unhandled。
    });
}

export function registerNotificationCenterHandlers(): void {
  // 全量列表（已按 createdAt 倒序 + 过期裁剪）。未读计数由渲染端自己算 readAt == null。
  ipcMain.handle("notification-center:list", (): Promise<NotificationRecord[]> => store.list());

  // 标已读：传 ids 标指定几条；不传 = 全部已读。
  ipcMain.handle("notification-center:mark-read", async (_e, ids?: string[]): Promise<void> => {
    await store.markRead(ids);
    await emitChanged();
  });

  // 清空全部。
  ipcMain.handle("notification-center:clear", async (): Promise<void> => {
    await store.clear();
    await emitChanged();
  });
}

// 退出收尾 / 测试用。
export function flushNotificationCenter(): Promise<void> {
  return store.flush();
}
