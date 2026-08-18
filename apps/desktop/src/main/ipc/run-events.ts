// 运行事件唯一出口(信封归一方案 P0,docs/plans/2026-08-18-001)。
//
// 主进程所有「会话级流式事件」(cli:event channel)必须经 sendRunEvent 发出——isDestroyed
// 守卫与信封形状集中在此,新代码禁止绕过它直发 sender.send("cli:event", ...)。
// channel 名保持 "cli:event" 不变:载荷是旧形状 {runId, sessionId, event} 的超集
// (多 v/domain 两个字段),preload 现有解构天然向后兼容。

import type { WebContents } from "electron";

import type { RunEventEnvelope } from "./types";

/** 把一个信封发往渲染端。sender 已销毁时静默丢弃(与旧各发送点的守卫语义一致)。 */
export function sendRunEvent(sender: WebContents, envelope: RunEventEnvelope): void {
  if (sender.isDestroyed()) return;
  sender.send("cli:event", envelope);
}
