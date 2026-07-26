// deck 内容变更广播器(main → renderer)。
//
// 为什么单独一个模块、且**刻意不 import electron**:
//   1. 唯一的发送点在 bento-workspace(持久层咽喉),而 bento-workspace 本身跑在单测里,
//      import electron 会让整个持久层测试需要 mock Electron;
//   2. sender 面收窄成三个方法后,测试用 20 行手写替身就能覆盖广播与回收逻辑
//      (与 main/research/research-service.ts 的 ResearchEventSender 同一手法)。
import { SLIDES_DECK_EVENT_CHANNEL, type SlidesDeckChangedEvent } from "../../ipc/slides-ipc-types";

/// 事件接收方的最小面。真实类型是 Electron.WebContents。
export interface SlidesDeckEventSender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
}

const senders = new Set<SlidesDeckEventSender>();

/// 注册一个渲染进程接收方。**幂等**:同一个 sender 重复注册只保留一份,
/// 否则窗口每调一次 slides IPC 就会让它多收一份事件。
export function addSlidesDeckEventSender(sender: SlidesDeckEventSender): void {
  if (sender.isDestroyed() || senders.has(sender)) return;
  senders.add(sender);
  // renderer 只 reload 不关窗时,旧 WebContents 会被销毁但引用还挂在这里;
  // 监听 destroyed 主动回收,避免注册表随刷新次数无限增长。
  sender.once("destroyed", () => senders.delete(sender));
}

/// 广播一条 deck 变更。写盘成功路径调用;失败路径**绝不**调用 ——
/// 那会让渲染端刷新到一个并不存在的新 revision。
export function emitSlidesDeckChanged(
  event: SlidesDeckChangedEvent,
  logger?: { warn(...args: unknown[]): void },
): void {
  for (const sender of [...senders]) {
    if (sender.isDestroyed()) {
      senders.delete(sender);
      continue;
    }
    try {
      sender.send(SLIDES_DECK_EVENT_CHANNEL, event);
    } catch (err) {
      // 单个 sender 失败不能中断整轮广播(它可能正处于销毁竞态中)。
      logger?.warn("[slides] deck 变更推送失败", err);
    }
  }
}

/// 仅供单测复位模块级注册表。
export function __resetSlidesDeckEventSenders(): void {
  senders.clear();
}
