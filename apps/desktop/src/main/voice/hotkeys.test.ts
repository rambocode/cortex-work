import { describe, expect, it } from "vitest";
import {
  RESERVED_VOICE_HOTKEYS,
  VOICE_HOTKEY_CONFLICT_TOAST,
  VOICE_HOTKEY_INVALID_TOAST,
  validateVoiceHotkeys,
} from "./hotkeys";

describe("validateVoiceHotkeys", () => {
  it("空串表示关闭，三项均可安全解除", () => {
    expect(
      validateVoiceHotkeys({
        chatHotkey: "",
        dictationHoldHotkey: "",
        dictationToggleHotkey: "",
      }),
    ).toEqual({
      chatHotkey: { ok: true },
      dictationHoldHotkey: { ok: true },
      dictationToggleHotkey: { ok: true },
    });
  });

  it("拒绝非空但不符合 Electron accelerator 格式的键位", () => {
    const result = validateVoiceHotkeys({
      chatHotkey: "bare-key",
      dictationHoldHotkey: "",
      dictationToggleHotkey: "",
    });

    expect(result.chatHotkey).toEqual({ ok: false, toast: VOICE_HOTKEY_INVALID_TOAST });
    expect(result.dictationHoldHotkey).toEqual({ ok: true });
    expect(result.dictationToggleHotkey).toEqual({ ok: true });
  });

  it.each(RESERVED_VOICE_HOTKEYS)("拒绝与既有 %s 快捷键冲突", (_name, accelerator) => {
    const result = validateVoiceHotkeys({
      chatHotkey: accelerator,
      dictationHoldHotkey: "",
      dictationToggleHotkey: "",
    });

    expect(result.chatHotkey).toEqual({ ok: false, toast: VOICE_HOTKEY_CONFLICT_TOAST });
  });

  it("拒绝语音聊天、按住听写、切换听写之间的重复键位", () => {
    const result = validateVoiceHotkeys({
      chatHotkey: "CommandOrControl+Shift+V",
      dictationHoldHotkey: "CommandOrControl+Shift+V",
      dictationToggleHotkey: "CommandOrControl+Shift+D",
    });

    expect(result.chatHotkey).toEqual({ ok: false, toast: VOICE_HOTKEY_CONFLICT_TOAST });
    expect(result.dictationHoldHotkey).toEqual({ ok: false, toast: VOICE_HOTKEY_CONFLICT_TOAST });
    expect(result.dictationToggleHotkey).toEqual({ ok: true });
  });

  it("比较 accelerator 时忽略大小写，避免 Electron 解析后静默抢占已有键", () => {
    const result = validateVoiceHotkeys({
      chatHotkey: "commandorcontrol+shift+n",
      dictationHoldHotkey: "",
      dictationToggleHotkey: "",
    });

    expect(result.chatHotkey).toEqual({ ok: false, toast: VOICE_HOTKEY_CONFLICT_TOAST });
  });
});
