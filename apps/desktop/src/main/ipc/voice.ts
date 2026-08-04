// 语音聊天 / 听写的主进程快捷键入口。
//
// globalShortcut 只适合 keydown 型触发，因此本阶段只注册语音聊天和「切换听写」；
// 按住听写将在后续阶段由 Cortex_Helper 的 keyDown/keyUp event tap 接管。三个配置仍在
// 一次 IPC 中整体校验，保证未来启用按住听写时不会接手一组已冲突的用户设置。

import { globalShortcut, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateVoiceHotkeys,
  type VoiceHotkeyInput,
  type VoiceHotkeyResults,
  type VoiceHotkeyField,
} from "../voice/hotkeys";
import {
  closeVoiceChatWindow,
  getVoiceChatWindow,
  openVoiceChatWindow,
  sendVoiceChatCommand,
} from "../voice/voice-chat-window";
import { loadChat, saveChat } from "./chat";
import { updatePersistedState } from "./store";
import type { PersistedState, SessionMeta } from "./types";

export const VOICE_HOTKEY_INPUT_INVALID_TOAST = "语音快捷键输入无效";
export const VOICE_HOTKEY_OCCUPIED_TOAST = "语音快捷键已被系统占用";
export const VOICE_HOTKEY_RESTORED_TOAST = "语音快捷键未生效，已恢复原设置";
export const VOICE_CHAT_SESSION_ID = "voice-chat";

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
  /** 一组键位通过校验并成功重绑后通知 helper 配置（按住听写不走 globalShortcut）。 */
  onVoiceHotkeysChanged?: (hotkeys: VoiceHotkeyInput) => void;
}

/** 听写栏仅回传某个录音 token 的最终文本；真实粘贴仍由 main 侧 controller 经 helper 完成。 */
export type DictationResultPayload =
  | { ok: true; text: string; token: number }
  | { ok: false; token: number; reason?: string };

let registered: RegisteredVoiceHotkeys = { chatHotkey: "", dictationToggleHotkey: "" };
let callbacks: Required<VoiceHotkeyCallbacks> = {
  onChatHotkey: () => {},
  onDictationToggleHotkey: () => {},
  onVoiceHotkeysChanged: () => {},
};
let dictationResultHandler: ((result: DictationResultPayload) => Promise<void> | void) | null = null;
let screenshotProvider: (() => Promise<Record<string, unknown>>) | null = null;
// 全局热键唤起前由 main 捕获的前台应用 pid；浮层 focus 后 frontmost 会变成 Cortex，
// 因而截图必须使用这个快照而不是在 renderer 提交时重新猜测。
let voiceChatScreenContextPid: number | null = null;

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
  ipcMain.handle("voice:openChat", (): void => {
    // 非全局热键入口没有「打开前的原应用」快照，宁可让截图显式失败也不能复用上一轮 pid。
    voiceChatScreenContextPid = null;
    openVoiceChatWindow();
    sendVoiceChatCommand("focus");
  });
  ipcMain.handle("voice:closeChat", (): void => closeVoiceChatWindow());
  ipcMain.handle("voice-chat:captureScreen", async (): Promise<{ path: string; mimeType: "image/png" }> => {
    if (!screenshotProvider) throw new Error("屏幕上下文暂不可用");
    const screenshot = await screenshotProvider();
    if (screenshot.ok !== true || screenshot.mimeType !== "image/png" || typeof screenshot.pngBase64 !== "string") {
      throw new Error(typeof screenshot.error === "string" ? screenshot.error : "屏幕截图失败");
    }
    const path = join(tmpdir(), `cortex-voice-${randomUUID()}.png`);
    await fsp.writeFile(path, Buffer.from(screenshot.pngBase64, "base64"), { mode: 0o600 });
    // CLI 已在启动时读取附件；延迟清理避免临时图长期保留潜在敏感屏幕内容。
    setTimeout(() => void fsp.unlink(path).catch(() => undefined), 10 * 60_000).unref?.();
    return { path, mimeType: "image/png" };
  });
  ipcMain.handle("dictation:result", async (_event, payload: unknown): Promise<void> => {
    const result = parseDictationResult(payload);
    if (result) await dictationResultHandler?.(result);
  });
  // 浮层只可接触固定语音会话，不能借 preload 读取或覆盖任意个人聊天记录。
  ipcMain.handle("voice-chat:load", async (_event, sessionId: unknown): Promise<unknown> => {
    assertVoiceChatSessionId(sessionId);
    return loadChat(VOICE_CHAT_SESSION_ID);
  });
  ipcMain.handle("voice-chat:save", async (_event, sessionId: unknown, messages: unknown): Promise<void> => {
    assertVoiceChatSessionId(sessionId);
    if (!Array.isArray(messages)) throw new Error("语音聊天消息列表必须是数组");
    await saveChat(VOICE_CHAT_SESSION_ID, messages);
    // 语音浮层没有全量 store:save 权限；因此主进程在权威态上维护这条固定会话的列表元数据，
    // 主窗口下次 hydrate 时即可用通常的 SessionMeta 路径加载历史，而不会出现孤立 chat 文件。
    await updatePersistedState((state) => upsertVoiceChatSession(state));
  });
}

/**
 * 为专用 `voice-chat` 消息文件维护主窗口会话列表所需的最小 SessionMeta。
 * 已有记录只刷新活跃时间，保留用户可能编辑过的标题、归档状态和既有 agent 元数据；新记录则
 * 沿用最后选择的 agent/model，缺省回退合法内置 agent `codex`，与普通 SessionMeta 结构兼容。
 */
export function upsertVoiceChatSession(state: PersistedState, now = Date.now()): PersistedState {
  const existing = state.sessions.find((session) => session.id === VOICE_CHAT_SESSION_ID);
  if (existing) {
    return {
      ...state,
      sessions: state.sessions.map((session) =>
        session.id === VOICE_CHAT_SESSION_ID ? { ...session, updatedAt: now } : session,
      ),
    };
  }

  const session: SessionMeta = {
    id: VOICE_CHAT_SESSION_ID,
    title: "语音聊天",
    agent: state.lastAgent ?? "codex",
    model: state.lastModel,
    providerId: state.lastProviderId,
    // 与主窗口 createSession 的默认值保持一致，避免复用固定会话时意外关闭 agent 自带 skills。
    useOwnSkills: true,
    createdAt: now,
    updatedAt: now,
  };
  return { ...state, sessions: [...state.sessions, session] };
}

/**
 * 只替换热键触发回调、不重复注册 IPC 或 accelerator。阶段 4/5 创建语音窗口控制器后
 * 调用此函数，已生效的快捷键会在下一次按下时转发到真实控制器。
 */
export function setVoiceHotkeyCallbacks(nextCallbacks: VoiceHotkeyCallbacks): void {
  callbacks = {
    onChatHotkey: nextCallbacks.onChatHotkey ?? callbacks.onChatHotkey,
    onDictationToggleHotkey: nextCallbacks.onDictationToggleHotkey ?? callbacks.onDictationToggleHotkey,
    onVoiceHotkeysChanged: nextCallbacks.onVoiceHotkeysChanged ?? callbacks.onVoiceHotkeysChanged,
  };
}

/** 安装听写栏结果处理器，不重复注册 IPC；未安装时安全忽略渲染端迟到结果。 */
export function setDictationResultHandler(
  handler: ((result: DictationResultPayload) => Promise<void> | void) | null,
): void {
  dictationResultHandler = handler;
}

/** 屏幕截图由唯一 Cortex_Helper 实例提供；未装配时 IPC 明确失败而不退化成错误的整屏抓取。 */
export function setVoiceScreenshotProvider(provider: (() => Promise<Record<string, unknown>>) | null): void {
  screenshotProvider = provider;
}

export function setVoiceChatScreenContextPid(pid: number | null): void {
  voiceChatScreenContextPid = pid;
}

export function getVoiceChatScreenContextPid(): number | null {
  return voiceChatScreenContextPid;
}

/** 全局聊天键第一次打开并录音；浮层可见时再次按下即要求 renderer 停录并提交。 */
export function toggleVoiceChatFromHotkey(): void {
  const active = getVoiceChatWindow();
  if (active?.isVisible()) {
    sendVoiceChatCommand("stopAndSubmit");
    return;
  }
  openVoiceChatWindow();
  sendVoiceChatCommand("startListening");
}

/** 专用 bridge 仍传入固定 ID；主进程二次验证，防止隔离窗口构造任意聊天文件访问。 */
function assertVoiceChatSessionId(sessionId: unknown): asserts sessionId is typeof VOICE_CHAT_SESSION_ID {
  if (sessionId !== VOICE_CHAT_SESSION_ID) throw new Error("语音聊天只能访问 voice-chat 会话");
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
  callbacks.onVoiceHotkeysChanged(input);
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

function parseDictationResult(value: unknown): DictationResultPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { ok?: unknown; text?: unknown; reason?: unknown; token?: unknown };
  // token 是跨进程隔离边界：没有它的旧/伪造消息不能被 controller 误当作当前轮结果。
  if (!Number.isSafeInteger(candidate.token) || (candidate.token as number) < 1) return null;
  if (candidate.ok === true && typeof candidate.text === "string") {
    return { ok: true, text: candidate.text, token: candidate.token as number };
  }
  if (candidate.ok === false && (candidate.reason == null || typeof candidate.reason === "string")) {
    return { ok: false, token: candidate.token as number, reason: candidate.reason as string | undefined };
  }
  return null;
}
