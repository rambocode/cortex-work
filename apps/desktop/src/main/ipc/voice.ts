// 语音聊天 / 听写的主进程快捷键入口。
//
// globalShortcut 只适合 keydown 型触发，因此本阶段只注册语音聊天和「切换听写」；
// 按住听写将在后续阶段由 Cortex_Helper 的 keyDown/keyUp event tap 接管。三个配置仍在
// 一次 IPC 中整体校验，保证未来启用按住听写时不会接手一组已冲突的用户设置。

import { globalShortcut, ipcMain } from "electron";
import {
  validateVoiceHotkeys,
  type VoiceHotkeyInput,
  type VoiceHotkeyResults,
  type VoiceHotkeyField,
} from "../voice/hotkeys";

export const VOICE_HOTKEY_INPUT_INVALID_TOAST = "语音快捷键输入无效";
export const VOICE_HOTKEY_OCCUPIED_TOAST = "语音快捷键已被系统占用";
export const VOICE_HOTKEY_RESTORED_TOAST = "语音快捷键未生效，已恢复原设置";

type GlobalVoiceHotkeyField = "chatHotkey" | "dictationToggleHotkey";

interface RegisteredVoiceHotkeys {
  chatHotkey: string;
  dictationToggleHotkey: string;
}

export interface VoiceHotkeyCallbacks {
  /** 语音聊天浮层在阶段 4 接线前故意为 no-op，确保本阶段的注册不会造成副作用。 */
  onChatHotkey?: () => void;
  /** 听写 controller 在阶段 5 接线前故意为 no-op。 */
  onDictationToggleHotkey?: () => void;
}

let registered: RegisteredVoiceHotkeys = { chatHotkey: "", dictationToggleHotkey: "" };
let callbacks: Required<VoiceHotkeyCallbacks> = {
  onChatHotkey: () => {},
  onDictationToggleHotkey: () => {},
};

const GLOBAL_FIELDS: readonly GlobalVoiceHotkeyField[] = ["chatHotkey", "dictationToggleHotkey"];

/**
 * 注册 renderer 可调用的语音快捷键 IPC。主进程生命周期内只应调用一次；后续语音浮层 /
 * 听写 controller 需要接线时必须调用 setVoiceHotkeyCallbacks，而不能重复 ipcMain.handle。
 */
export function registerVoiceHandlers(nextCallbacks: VoiceHotkeyCallbacks = {}): void {
  setVoiceHotkeyCallbacks(nextCallbacks);
  ipcMain.handle("voice:setHotkeys", (_event, input: unknown): VoiceHotkeyResults => {
    if (!isVoiceHotkeyInput(input)) return invalidInputResults();
    return applyVoiceHotkeys(input);
  });
}

/**
 * 只替换热键触发回调、不重复注册 IPC 或 accelerator。阶段 4/5 创建语音窗口控制器后
 * 调用此函数，已生效的快捷键会在下一次按下时转发到真实控制器。
 */
export function setVoiceHotkeyCallbacks(nextCallbacks: VoiceHotkeyCallbacks): void {
  callbacks = {
    onChatHotkey: nextCallbacks.onChatHotkey ?? callbacks.onChatHotkey,
    onDictationToggleHotkey: nextCallbacks.onDictationToggleHotkey ?? callbacks.onDictationToggleHotkey,
  };
}

/**
 * 让启动恢复与 IPC 设置走同一条重绑事务，防止重启后 shortcut 行为与设置页不一致。
 * 返回每项结果以便调用方记录诊断；空串会精确解绑此前已注册的同类键。
 */
export function applyVoiceHotkeys(input: VoiceHotkeyInput): VoiceHotkeyResults {
  const validation = validateVoiceHotkeys(input);
  if (!allSucceeded(validation)) return validation;

  const previous = { ...registered };
  unregisterRegisteredHotkeys();

  const newlyRegistered: RegisteredVoiceHotkeys = { chatHotkey: "", dictationToggleHotkey: "" };
  let failedField: GlobalVoiceHotkeyField | undefined;

  for (const field of GLOBAL_FIELDS) {
    const accelerator = input[field];
    if (!accelerator) continue;
    if (!tryRegister(field, accelerator)) {
      failedField = field;
      break;
    }
    newlyRegistered[field] = accelerator;
  }

  if (failedField) {
    // 不能让 renderer 的持久化回滚把 main 留在「旧值显示、实际没绑」的裂脑状态。
    // 所以先撤掉本次部分成功的键，再尽力恢复上一组；每次均精确 unregister，绝不误伤
    // notes/tasks/reply 等独立 globalShortcut。
    unregisterHotkeys(newlyRegistered);
    registered = { chatHotkey: "", dictationToggleHotkey: "" };
    restoreHotkeys(previous);
    return restoreFailureResults(input, previous, failedField);
  }

  registered = newlyRegistered;
  return validation;
}

function tryRegister(field: GlobalVoiceHotkeyField, accelerator: string): boolean {
  try {
    // 注册的是间接调用，而非当前函数引用。这样后续阶段装配真实窗口 controller 时不必
    // 重新 register（重复 ipcMain.handle 会抛错，重绑也会短暂丢失用户按键）。
    const callback = (): void => {
      if (field === "chatHotkey") callbacks.onChatHotkey();
      else callbacks.onDictationToggleHotkey();
    };
    return globalShortcut.register(accelerator, callback);
  } catch {
    // Electron 会在系统拒绝 accelerator 时返回 false；极少数平台实现会抛错，同样按占用/不可用
    // 处理，以免一次设置操作杀掉 IPC handler。
    return false;
  }
}

function unregisterRegisteredHotkeys(): void {
  unregisterHotkeys(registered);
  registered = { chatHotkey: "", dictationToggleHotkey: "" };
}

function unregisterHotkeys(hotkeys: RegisteredVoiceHotkeys): void {
  for (const field of GLOBAL_FIELDS) {
    const accelerator = hotkeys[field];
    if (!accelerator) continue;
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // 进程退出 / 系统已回收注册时 unregister 可能失败；本地状态仍须清空。
    }
  }
}

function restoreHotkeys(previous: RegisteredVoiceHotkeys): void {
  for (const field of GLOBAL_FIELDS) {
    const accelerator = previous[field];
    if (!accelerator || !tryRegister(field, accelerator)) continue;
    registered[field] = accelerator;
  }
}

function restoreFailureResults(
  desired: VoiceHotkeyInput,
  previous: RegisteredVoiceHotkeys,
  failedField: GlobalVoiceHotkeyField,
): VoiceHotkeyResults {
  const results = validateVoiceHotkeys(desired);
  for (const field of GLOBAL_FIELDS) {
    if (desired[field] === previous[field]) continue;
    results[field] = {
      ok: false,
      toast: field === failedField ? VOICE_HOTKEY_OCCUPIED_TOAST : VOICE_HOTKEY_RESTORED_TOAST,
    };
  }
  return results;
}

function isVoiceHotkeyInput(value: unknown): value is VoiceHotkeyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<VoiceHotkeyField, unknown>;
  return (
    typeof candidate.chatHotkey === "string" &&
    typeof candidate.dictationHoldHotkey === "string" &&
    typeof candidate.dictationToggleHotkey === "string"
  );
}

function invalidInputResults(): VoiceHotkeyResults {
  const failed = { ok: false, toast: VOICE_HOTKEY_INPUT_INVALID_TOAST };
  return {
    chatHotkey: { ...failed },
    dictationHoldHotkey: { ...failed },
    dictationToggleHotkey: { ...failed },
  };
}

function allSucceeded(results: VoiceHotkeyResults): boolean {
  return Object.values(results).every((result) => result.ok);
}
