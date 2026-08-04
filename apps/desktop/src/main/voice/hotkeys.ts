// 语音快捷键的纯校验规则。Electron 的 globalShortcut 只注册聊天/切换听写两键；
// 按住听写暂由后续 Cortex_Helper 事件 tap 消费，但现在一并校验，避免用户保存一组
// 内部冲突的配置后再在后续阶段出现不可解释的吞键行为。

import type { VoiceSettings } from "../ipc/types";
import {
  isValidAccelerator,
  NOTES_HOTKEY_ACCELERATOR,
  REPLY_HOTKEY_ACCELERATOR,
  TASKS_HOTKEY_ACCELERATOR,
} from "../hotkey";

export const RESERVED_VOICE_HOTKEYS = [
  ["闪记", NOTES_HOTKEY_ACCELERATOR],
  ["任务快速捕获", TASKS_HOTKEY_ACCELERATOR],
  ["快捷回复", REPLY_HOTKEY_ACCELERATOR],
] as const;

export const VOICE_HOTKEY_INVALID_TOAST = "语音快捷键格式无效";
export const VOICE_HOTKEY_CONFLICT_TOAST = "语音快捷键与已有快捷键冲突";

export type VoiceHotkeyField = "chatHotkey" | "dictationHoldHotkey" | "dictationToggleHotkey";

export type VoiceHotkeyInput = Pick<
  VoiceSettings,
  "chatHotkey" | "dictationHoldHotkey" | "dictationToggleHotkey"
>;

export interface VoiceHotkeyResult {
  ok: boolean;
  toast?: string;
}

export type VoiceHotkeyResults = Record<VoiceHotkeyField, VoiceHotkeyResult>;

const VOICE_HOTKEY_FIELDS: readonly VoiceHotkeyField[] = [
  "chatHotkey",
  "dictationHoldHotkey",
  "dictationToggleHotkey",
];

const reservedAccelerators = new Set(RESERVED_VOICE_HOTKEYS.map(([, accelerator]) => normalize(accelerator)));

/**
 * 校验整组语音键位，返回每项可直接给设置 UI 使用的结果。
 *
 * 空串是明确的「关闭」语义，不应要求 accelerator 格式；比较忽略大小写以和 Electron
 * accelerator 的解析保持一致。调用方在任意一项失败时不得变更已生效的系统级注册。
 */
export function validateVoiceHotkeys(input: VoiceHotkeyInput): VoiceHotkeyResults {
  const results: VoiceHotkeyResults = {
    chatHotkey: { ok: true },
    dictationHoldHotkey: { ok: true },
    dictationToggleHotkey: { ok: true },
  };

  for (const field of VOICE_HOTKEY_FIELDS) {
    const accelerator = input[field];
    if (!accelerator) continue;
    if (!isValidAccelerator(accelerator)) {
      results[field] = { ok: false, toast: VOICE_HOTKEY_INVALID_TOAST };
      continue;
    }
    if (reservedAccelerators.has(normalize(accelerator))) {
      results[field] = { ok: false, toast: VOICE_HOTKEY_CONFLICT_TOAST };
    }
  }

  // 只在两个候选都已通过格式/保留键校验时比较，避免一条无效输入连带污染另一项的提示。
  for (let i = 0; i < VOICE_HOTKEY_FIELDS.length; i += 1) {
    const left = VOICE_HOTKEY_FIELDS[i]!;
    const leftAccelerator = input[left];
    if (!leftAccelerator || !results[left].ok) continue;
    for (let j = i + 1; j < VOICE_HOTKEY_FIELDS.length; j += 1) {
      const right = VOICE_HOTKEY_FIELDS[j]!;
      const rightAccelerator = input[right];
      if (!rightAccelerator || !results[right].ok) continue;
      if (normalize(leftAccelerator) === normalize(rightAccelerator)) {
        results[left] = { ok: false, toast: VOICE_HOTKEY_CONFLICT_TOAST };
        results[right] = { ok: false, toast: VOICE_HOTKEY_CONFLICT_TOAST };
      }
    }
  }

  return results;
}

function normalize(accelerator: string): string {
  return accelerator.toLowerCase();
}
