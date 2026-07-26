// deck 变更广播器测试:注册幂等 / 销毁自回收 / 单个 sender 失败不中断整轮。
// 用手写替身而非 Electron WebContents —— deck-events 刻意不 import electron 就是为了这个。
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSlidesDeckEventSenders,
  addSlidesDeckEventSender,
  emitSlidesDeckChanged,
  type SlidesDeckEventSender,
} from "./deck-events";
import { SLIDES_DECK_EVENT_CHANNEL, type SlidesDeckChangedEvent } from "../../ipc/slides-ipc-types";

/** 最小 sender 替身:记录收到的 (channel, payload),可切换 destroyed / 抛错。 */
function fakeSender(options: { destroyed?: boolean; throwOnSend?: boolean } = {}): SlidesDeckEventSender & {
  received: Array<{ channel: string; payload: unknown }>;
  destroyedListeners: Array<() => void>;
  destroyed: boolean;
} {
  return {
    received: [],
    destroyedListeners: [],
    destroyed: options.destroyed ?? false,
    isDestroyed() {
      return this.destroyed;
    },
    send(channel: string, payload: unknown) {
      if (options.throwOnSend) throw new Error("sender 已进入销毁竞态");
      this.received.push({ channel, payload });
    },
    once(_event: "destroyed", listener: () => void) {
      this.destroyedListeners.push(listener);
    },
  };
}

const EVENT: SlidesDeckChangedEvent = {
  workspaceRoot: "/ws",
  deckId: "deckabc1",
  revision: 72,
  source: "agent",
  slideIds: ["slide-3"],
  pages: [3],
  slideCount: 13,
  at: "2026-07-26T00:00:00.000Z",
};

beforeEach(() => {
  __resetSlidesDeckEventSenders();
});

describe("addSlidesDeckEventSender", () => {
  it("重复注册同一个 sender 只保留一份(否则每次订阅都会多收一份事件)", () => {
    const sender = fakeSender();
    addSlidesDeckEventSender(sender);
    addSlidesDeckEventSender(sender);
    emitSlidesDeckChanged(EVENT);
    expect(sender.received).toHaveLength(1);
    expect(sender.received[0]).toEqual({ channel: SLIDES_DECK_EVENT_CHANNEL, payload: EVENT });
  });

  it("已销毁的 sender 不入注册表", () => {
    const sender = fakeSender({ destroyed: true });
    addSlidesDeckEventSender(sender);
    emitSlidesDeckChanged(EVENT);
    expect(sender.received).toHaveLength(0);
  });

  it("destroyed 事件触发后自动回收(renderer 只 reload 不关窗的场景)", () => {
    const sender = fakeSender();
    addSlidesDeckEventSender(sender);
    expect(sender.destroyedListeners).toHaveLength(1);
    sender.destroyedListeners[0]!();
    sender.destroyed = true;
    emitSlidesDeckChanged(EVENT);
    expect(sender.received).toHaveLength(0);
  });
});

describe("emitSlidesDeckChanged", () => {
  it("广播给全部存活 sender", () => {
    const a = fakeSender();
    const b = fakeSender();
    addSlidesDeckEventSender(a);
    addSlidesDeckEventSender(b);
    emitSlidesDeckChanged(EVENT);
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
  });

  it("单个 sender 抛错不中断整轮广播", () => {
    const bad = fakeSender({ throwOnSend: true });
    const good = fakeSender();
    addSlidesDeckEventSender(bad);
    addSlidesDeckEventSender(good);
    expect(() => emitSlidesDeckChanged(EVENT)).not.toThrow();
    expect(good.received).toHaveLength(1);
  });

  it("广播时发现已销毁的 sender 就地剔除", () => {
    const sender = fakeSender();
    addSlidesDeckEventSender(sender);
    sender.destroyed = true;
    emitSlidesDeckChanged(EVENT);
    sender.destroyed = false;
    emitSlidesDeckChanged(EVENT);
    expect(sender.received).toHaveLength(0);
  });

  it("没有任何 sender 时静默返回(主进程写盘不该因没人听而失败)", () => {
    expect(() => emitSlidesDeckChanged(EVENT)).not.toThrow();
  });

  it("logger 注入后,send 失败会记一条 warn", () => {
    const warn = vi.fn();
    addSlidesDeckEventSender(fakeSender({ throwOnSend: true }));
    emitSlidesDeckChanged(EVENT, { warn });
    expect(warn).toHaveBeenCalled();
  });
});
