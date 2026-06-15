import { describe, it, expect } from "vitest";
import {
  resolveHotkeyRegistration,
  NOTES_HOTKEY_OCCUPIED_TOAST,
  NOTES_HOTKEY_ACCELERATOR,
} from "./hotkey";

describe("resolveHotkeyRegistration", () => {
  it("ok=true → 注册成功、无降级、无提示", () => {
    const r = resolveHotkeyRegistration(true);
    expect(r.registered).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.toast).toBeUndefined();
  });

  it("ok=false → 注册失败、降级、带占用提示文案", () => {
    const r = resolveHotkeyRegistration(false);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.toast).toBe(NOTES_HOTKEY_OCCUPIED_TOAST);
  });

  it("默认键位为 CommandOrControl+Shift+N", () => {
    expect(NOTES_HOTKEY_ACCELERATOR).toBe("CommandOrControl+Shift+N");
  });
});
