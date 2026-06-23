import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";

import { clearGuestIf, getLiveGuest, readConsoleBuffer, setGuest } from "./guest-registry";

// 最小 fake:isDestroyed() + on/emit(供 console-message 捕获测试)。
type FakeWc = WebContents & { _destroy: () => void; emit: (ev: string, ...args: unknown[]) => void };
function fakeWc(): FakeWc {
  let destroyed = false;
  const listeners: Record<string, (...a: unknown[]) => void> = {};
  return {
    isDestroyed: () => destroyed,
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      listeners[ev] = cb;
    },
    emit: (ev: string, ...args: unknown[]) => listeners[ev]?.(...args),
    _destroy: () => {
      destroyed = true;
    },
  } as unknown as FakeWc;
}

describe("guest WebContents 注册表（U4）", () => {
  it("setGuest 后 getLiveGuest 返回该引用", () => {
    const wc = fakeWc();
    setGuest(wc);
    expect(getLiveGuest()).toBe(wc);
  });

  it("已销毁的 guest → getLiveGuest 返回 null 并清", () => {
    const wc = fakeWc();
    setGuest(wc);
    wc._destroy();
    expect(getLiveGuest()).toBeNull();
    expect(getLiveGuest()).toBeNull();
  });

  it("clearGuestIf 仅清匹配引用(重挂安全:旧 destroyed 不误清新引用)", () => {
    const oldWc = fakeWc();
    const newWc = fakeWc();
    setGuest(oldWc);
    setGuest(newWc);
    clearGuestIf(oldWc);
    expect(getLiveGuest()).toBe(newWc);
    clearGuestIf(newWc);
    expect(getLiveGuest()).toBeNull();
  });

  it("setGuest 接控制台捕获;新面板清缓冲(U5)", () => {
    const wc = fakeWc();
    setGuest(wc);
    wc.emit("console-message", {}, { level: 2, message: "warn-1" });
    wc.emit("console-message", {}, { level: 3, message: "err-1" });
    expect(readConsoleBuffer()).toEqual([
      { level: 2, message: "warn-1" },
      { level: 3, message: "err-1" },
    ]);
    // 重挂新面板 → 缓冲清空。
    setGuest(fakeWc());
    expect(readConsoleBuffer()).toEqual([]);
  });
});
