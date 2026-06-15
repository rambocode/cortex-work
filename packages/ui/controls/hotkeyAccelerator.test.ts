// 录制式快捷键的纯函数:KeyboardEvent → Electron accelerator 映射 + 显示格式化。
// 不触碰真实 DOM/electron,全用最小事件形状,便于穷举各类按键。

import { describe, it, expect } from "vitest";
import { eventToAccelerator, formatAccelerator, isModifierOnlyCode } from "./hotkeyAccelerator";

// 构造 eventToAccelerator 入参的便捷工厂(默认全部修饰键关闭)。
function ev(p: Partial<Parameters<typeof eventToAccelerator>[0]>): Parameters<typeof eventToAccelerator>[0] {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: "",
    key: "",
    ...p,
  };
}

describe("eventToAccelerator", () => {
  it("meta + 字母 → CommandOrControl+主键(跨平台)", () => {
    expect(eventToAccelerator(ev({ metaKey: true, code: "KeyN", key: "n" }))).toBe("CommandOrControl+N");
  });

  it("ctrl + 字母 → 同样归一化为 CommandOrControl", () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "KeyN", key: "n" }))).toBe("CommandOrControl+N");
  });

  it("meta+shift+字母 → 修饰键顺序固定 CommandOrControl→Shift→主键", () => {
    expect(eventToAccelerator(ev({ metaKey: true, shiftKey: true, code: "KeyN", key: "N" }))).toBe(
      "CommandOrControl+Shift+N",
    );
  });

  it("alt 单独 + 字母 → Alt+主键", () => {
    expect(eventToAccelerator(ev({ altKey: true, code: "KeyA", key: "a" }))).toBe("Alt+A");
  });

  it("修饰键顺序固定 CommandOrControl→Alt→Shift→主键", () => {
    expect(
      eventToAccelerator(ev({ metaKey: true, altKey: true, shiftKey: true, code: "KeyJ", key: "j" })),
    ).toBe("CommandOrControl+Alt+Shift+J");
  });

  it("用 e.code 取主键而非 e.key(Shift 改变字符不影响)", () => {
    // Shift+1 在 e.key 是 "!",但 e.code 是 "Digit1" → 主键应为 1。
    expect(eventToAccelerator(ev({ ctrlKey: true, shiftKey: true, code: "Digit1", key: "!" }))).toBe(
      "CommandOrControl+Shift+1",
    );
  });

  it("数字键 DigitN → N", () => {
    expect(eventToAccelerator(ev({ metaKey: true, code: "Digit5", key: "5" }))).toBe("CommandOrControl+5");
  });

  it("Space → Space", () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "Space", key: " " }))).toBe("CommandOrControl+Space");
  });

  it("功能键 F1-F24 原样", () => {
    expect(eventToAccelerator(ev({ altKey: true, code: "F5", key: "F5" }))).toBe("Alt+F5");
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "F12", key: "F12" }))).toBe("CommandOrControl+F12");
  });

  it("Tab / Enter / Backquote / Minus 等常见键 → Electron 名", () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "Tab", key: "Tab" }))).toBe("CommandOrControl+Tab");
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "Enter", key: "Enter" }))).toBe("CommandOrControl+Enter");
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "Backquote", key: "`" }))).toBe("CommandOrControl+`");
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "Minus", key: "-" }))).toBe("CommandOrControl+-");
  });

  it("纯修饰键(主键是 Meta/Control/Alt/Shift 本身)返回 null", () => {
    expect(eventToAccelerator(ev({ metaKey: true, code: "MetaLeft", key: "Meta" }))).toBeNull();
    expect(eventToAccelerator(ev({ shiftKey: true, code: "ShiftLeft", key: "Shift" }))).toBeNull();
    expect(eventToAccelerator(ev({ ctrlKey: true, code: "ControlLeft", key: "Control" }))).toBeNull();
    expect(eventToAccelerator(ev({ altKey: true, code: "AltLeft", key: "Alt" }))).toBeNull();
  });

  it("有主键但无任何修饰键 → null(防注册成拦截普通打字的全局键)", () => {
    expect(eventToAccelerator(ev({ code: "KeyN", key: "n" }))).toBeNull();
  });

  it("无主键(只按修饰)→ null", () => {
    expect(eventToAccelerator(ev({ metaKey: true, code: "", key: "" }))).toBeNull();
  });

  it("无法识别的 code → null", () => {
    expect(eventToAccelerator(ev({ metaKey: true, code: "Lang1", key: "" }))).toBeNull();
  });
});

describe("isModifierOnlyCode 区分纯修饰键(等主键)与未映射主键", () => {
  it("修饰键 code → true(左右 Meta/Control/Alt/Shift)", () => {
    expect(isModifierOnlyCode("MetaLeft")).toBe(true);
    expect(isModifierOnlyCode("MetaRight")).toBe(true);
    expect(isModifierOnlyCode("ControlLeft")).toBe(true);
    expect(isModifierOnlyCode("AltLeft")).toBe(true);
    expect(isModifierOnlyCode("ShiftRight")).toBe(true);
  });

  it("非修饰键 code → false(字母/未映射键)", () => {
    expect(isModifierOnlyCode("KeyN")).toBe(false);
    expect(isModifierOnlyCode("Lang1")).toBe(false);
    expect(isModifierOnlyCode("")).toBe(false);
  });
});

describe("formatAccelerator", () => {
  it("mac:CommandOrControl→⌘、Shift→⇧、主键大写", () => {
    expect(formatAccelerator("CommandOrControl+Shift+N", true)).toBe("⌘⇧N");
  });

  it("mac:Alt→⌥、Control→⌃", () => {
    expect(formatAccelerator("Alt+F5", true)).toBe("⌥F5");
    expect(formatAccelerator("Control+K", true)).toBe("⌃K");
  });

  it("mac:符号无分隔直接拼接", () => {
    expect(formatAccelerator("CommandOrControl+Alt+Shift+J", true)).toBe("⌘⌥⇧J");
  });

  it("非 mac:Ctrl/Alt/Shift + 文字,用 + 连接", () => {
    expect(formatAccelerator("CommandOrControl+Shift+N", false)).toBe("Ctrl+Shift+N");
    expect(formatAccelerator("Alt+F5", false)).toBe("Alt+F5");
  });

  it("非 mac:主键大写", () => {
    expect(formatAccelerator("CommandOrControl+n", false)).toBe("Ctrl+N");
  });

  it("空串原样返回(防御)", () => {
    expect(formatAccelerator("", true)).toBe("");
  });
});
