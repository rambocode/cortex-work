// 失效通知统一出口(信封归一方案 P1,docs/plans/2026-08-18-001)。
//
// 「某数据变了,请重拉」类低频通知一律走单一 channel `sync:invalidate` + {scope, hint} 载荷,
// 渲染端按 core/personal/sync-invalidate.ts 的静态映射表 invalidate 对应 React Query key。
// 新增此类通知只需扩 scope 联合类型 + 渲染端映射表一行,不再新开 `*:changed` channel、
// 不再动 preload 与 DesktopBridge 契约。
//
// 边界(务必遵守):本通道只发**信号**,不塞数据快照。载荷携带全量数据、渲染端直接消费
// (workflow:changed / automation:changed / roles:changed / memory:changed)的是「状态推送」
// 语义,不属于本通道——要迁移它们必须先把消费端改为 invalidate+重拉,那是行为变更,另评。

import { BrowserWindow } from "electron";

/** 已接入的失效域。渲染端映射表(core/personal/sync-invalidate.ts)须与此保持一一对应。 */
export type SyncInvalidateScope = "tasks" | "task-resources" | "notes";

/** 广播一条失效信号给所有存活窗口(窗口可能已关,事件丢失不影响落盘,renderer 重开补拉)。 */
export function broadcastSyncInvalidate(scope: SyncInvalidateScope, hint?: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("sync:invalidate", { scope, hint });
  }
}
