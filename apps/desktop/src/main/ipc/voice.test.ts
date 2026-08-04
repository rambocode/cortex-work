import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  register: vi.fn<(accelerator: string, callback: () => void) => boolean>(() => true),
  unregister: vi.fn<(accelerator: string) => void>(),
  unregisterAll: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
  },
  globalShortcut: {
    register: mocks.register,
    unregister: mocks.unregister,
    unregisterAll: mocks.unregisterAll,
  },
}));

import { registerVoiceHandlers, setVoiceHotkeyCallbacks } from "./voice";
import type { VoiceHotkeyResults } from "../voice/hotkeys";

const hotkeys = (overrides: Partial<Record<"chatHotkey" | "dictationHoldHotkey" | "dictationToggleHotkey", string>> = {}) => ({
  chatHotkey: "CommandOrControl+Shift+V",
  dictationHoldHotkey: "",
  dictationToggleHotkey: "CommandOrControl+Shift+D",
  ...overrides,
});

describe("voice:setHotkeys", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.register.mockReset().mockReturnValue(true);
    mocks.unregister.mockReset();
    mocks.unregisterAll.mockReset();
    registerVoiceHandlers();
    // registerVoiceHandlers 在真实主进程只会调用一次；测试复用模块实例前先通过正式
    // IPC 路径解除上例留下的状态，再清空 spy，避免引入仅供测试的生产重置入口。
    mocks.handlers.get("voice:setHotkeys")?.({}, hotkeys({ chatHotkey: "", dictationToggleHotkey: "" }));
    mocks.register.mockReset().mockReturnValue(true);
    mocks.unregister.mockReset();
  });

  it("只注册聊天与切换听写键，按住听写留给后续 helper 事件 tap", () => {
    const handler = mocks.handlers.get("voice:setHotkeys");

    const result = handler?.({}, hotkeys());

    expect(result).toEqual({
      chatHotkey: { ok: true },
      dictationHoldHotkey: { ok: true },
      dictationToggleHotkey: { ok: true },
    });
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.register.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+D",
    ]);
  });

  it("后续窗口控制器可替换回调而不重新注册 IPC 或 accelerator", () => {
    const onChatHotkey = vi.fn();
    const onDictationToggleHotkey = vi.fn();
    const handler = mocks.handlers.get("voice:setHotkeys")!;
    handler({}, hotkeys());
    const chatCallback = mocks.register.mock.calls[0]![1];
    const toggleCallback = mocks.register.mock.calls[1]![1];

    setVoiceHotkeyCallbacks({ onChatHotkey, onDictationToggleHotkey });
    chatCallback?.();
    toggleCallback?.();

    expect(onChatHotkey).toHaveBeenCalledOnce();
    expect(onDictationToggleHotkey).toHaveBeenCalledOnce();
    expect(mocks.handlers.size).toBe(1);
  });

  it("下一次设置前只精确注销上一组语音键，不调用 unregisterAll", () => {
    const handler = mocks.handlers.get("voice:setHotkeys")!;
    handler({}, hotkeys());

    handler({}, hotkeys({ chatHotkey: "CommandOrControl+Shift+C", dictationToggleHotkey: "" }));

    expect(mocks.unregister.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+D",
    ]);
    expect(mocks.unregisterAll).not.toHaveBeenCalled();
    expect(mocks.register.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+D",
      "CommandOrControl+Shift+C",
    ]);
  });

  it("空串解除已注册的聊天和切换听写键", () => {
    const handler = mocks.handlers.get("voice:setHotkeys")!;
    handler({}, hotkeys());

    const result = handler({}, hotkeys({ chatHotkey: "", dictationToggleHotkey: "" }));

    expect(result).toEqual({
      chatHotkey: { ok: true },
      dictationHoldHotkey: { ok: true },
      dictationToggleHotkey: { ok: true },
    });
    expect(mocks.unregister.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+D",
    ]);
  });

  it("拒绝非对象或缺失字段的 IPC 输入，不触碰系统级快捷键", () => {
    const handler = mocks.handlers.get("voice:setHotkeys")!;

    expect(handler({}, { chatHotkey: "CommandOrControl+Shift+V" })).toEqual({
      chatHotkey: { ok: false, toast: "语音快捷键输入无效" },
      dictationHoldHotkey: { ok: false, toast: "语音快捷键输入无效" },
      dictationToggleHotkey: { ok: false, toast: "语音快捷键输入无效" },
    });
    expect(handler({}, null)).toEqual({
      chatHotkey: { ok: false, toast: "语音快捷键输入无效" },
      dictationHoldHotkey: { ok: false, toast: "语音快捷键输入无效" },
      dictationToggleHotkey: { ok: false, toast: "语音快捷键输入无效" },
    });
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("新键被系统占用时恢复上一组绑定，避免持久化回滚后主进程失去快捷键", () => {
    const handler = mocks.handlers.get("voice:setHotkeys")!;
    handler({}, hotkeys());
    mocks.register.mockImplementation((accelerator) => accelerator !== "CommandOrControl+Shift+C");

    const result = handler({}, hotkeys({ dictationToggleHotkey: "CommandOrControl+Shift+C" })) as VoiceHotkeyResults;

    expect(result.chatHotkey).toEqual({ ok: true });
    expect(result.dictationToggleHotkey).toMatchObject({ ok: false });
    expect(mocks.unregister.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+D",
      "CommandOrControl+Shift+V",
    ]);
    expect(mocks.register.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+D",
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+C",
      "CommandOrControl+Shift+V",
      "CommandOrControl+Shift+D",
    ]);
  });
});
