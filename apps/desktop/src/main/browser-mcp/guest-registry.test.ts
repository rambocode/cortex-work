import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";

import { clearGuestIf, getLiveGuest, setGuest } from "./guest-registry";

// 最小 fake:仅需 isDestroyed();_destroy 切换销毁态。
function fakeWc(): WebContents & { _destroy: () => void } {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    _destroy: () => {
      destroyed = true;
    },
  } as unknown as WebContents & { _destroy: () => void };
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
    expect(getLiveGuest()).toBeNull(); // 已清,稳定
  });

  it("clearGuestIf 仅清匹配引用(重挂安全:旧 destroyed 不误清新引用)", () => {
    const oldWc = fakeWc();
    const newWc = fakeWc();
    setGuest(oldWc);
    setGuest(newWc); // webview 重挂 → 新 guest 覆盖
    clearGuestIf(oldWc); // 旧 guest 的 destroyed 事件迟到 → 不应清掉新引用
    expect(getLiveGuest()).toBe(newWc);
    clearGuestIf(newWc);
    expect(getLiveGuest()).toBeNull();
  });
});
