import { describe, expect, it } from "vitest";
import {
  HOLD_HOTKEY_UNSUPPORTED_MESSAGE,
  mapAcceleratorToMacKeyCode,
} from "./accelerator-keycode";

describe("mapAcceleratorToMacKeyCode", () => {
  it("将 macOS 上的 CommandOrControl 与 ANSI 字母映射为 helper 配置", () => {
    expect(mapAcceleratorToMacKeyCode("CommandOrControl+Shift+D")).toEqual({
      ok: true,
      config: { keyCode: 2, modifiers: ["command", "shift"] },
    });
  });

  it("保留纯修饰键组合，让 helper 用 flagsChanged 判定按住开始和结束", () => {
    expect(mapAcceleratorToMacKeyCode("Control+Option")).toEqual({
      ok: true,
      config: { keyCode: null, modifiers: ["control", "option"] },
    });
  });

  it("支持明确的 ANSI 数字和标点键码", () => {
    expect(mapAcceleratorToMacKeyCode("Cmd+Alt+/")).toEqual({
      ok: true,
      config: { keyCode: 44, modifiers: ["command", "option"] },
    });
  });

  it("拒绝没有修饰键的普通按键，避免吞掉正常输入", () => {
    expect(mapAcceleratorToMacKeyCode("D")).toEqual({
      ok: false,
      message: HOLD_HOTKEY_UNSUPPORTED_MESSAGE,
    });
  });

  it("拒绝没有 ANSI 物理键映射的功能键", () => {
    expect(mapAcceleratorToMacKeyCode("Command+F5")).toEqual({
      ok: false,
      message: HOLD_HOTKEY_UNSUPPORTED_MESSAGE,
    });
  });
});
