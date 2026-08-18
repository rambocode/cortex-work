// 运行事件唯一出口(信封归一方案 P0,docs/plans/2026-08-18-001)。
//
// 主进程所有「会话级流式事件」(cli:event channel)必须经 sendRunEvent 发出——isDestroyed
// 守卫与信封形状集中在此,新代码禁止绕过它直发 sender.send("cli:event", ...)。
// channel 名保持 "cli:event" 不变:载荷是旧形状 {runId, sessionId, event} 的超集
// (多 v/domain 两个字段),preload 现有解构天然向后兼容。

import type { WebContents } from "electron";

import { createLogger } from "../log";
import type { RunEventEnvelope } from "./types";

const log = createLogger("run-events");

/**
 * 把一个信封发往渲染端。sender 已销毁时静默丢弃;WebContents 可能在 isDestroyed 检查后、
 * send 前销毁(窗口关闭竞态),send 抛错同样吞掉——事件丢失不影响主进程状态,child 的取消
 * 由 destroyed 级联负责。集中在唯一出口处理,调用方不必再各自 try/catch。
 */
export function sendRunEvent(sender: WebContents, envelope: RunEventEnvelope): void {
  if (sender.isDestroyed()) return;
  try {
    sender.send("cli:event", envelope);
  } catch (error) {
    log.warn(`运行事件转发失败(domain=${envelope.domain}, session=${envelope.sessionId}): ${String(error)}`);
  }
}
