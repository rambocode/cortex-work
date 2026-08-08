// 语音助手 IPC 域(voiceAssistant:*)。架构与 ipc/pet.ts 同构:语音管线(录音/VAD/STT/
// 发送/TTS)全在**主窗口**的 headless 控制器(views 的 VoiceAssistantController),本模块
// 只做三件事——①窗口编排:激活/退出时切 pet-overlay 窗口的 pet↔voice 模式;②状态中继:
// 缓存主窗口上报的快照并转发 overlay(挂载竞态用 request-sync 回放);③指令归一:热键与
// overlay 点击都归一成 voiceAssistant:command 下发给主窗口控制器。
// 类型契约见 ./types.ts 的 VoiceAssistant*(与 packages/core/desktop/types.ts 镜像)。

import { BrowserWindow, ipcMain } from "electron";
import type {
  VoiceAssistantCommand,
  VoiceAssistantFeed,
  VoiceAssistantIntentResult,
  VoiceAssistantSnapshot,
} from "./types";
import {
  ensurePetOverlayWindow,
  getPetOverlayMode,
  getPetOverlayWindow,
  setPetOverlayMode,
} from "../pet-overlay-window";
import { captureVoiceScreenshot, setVoiceChatScreenContextPid } from "./voice";
import { understandVoiceIntentFromSettings } from "../capabilities/voice-intent/understand";
import { setVoiceAssistantIntentDispatcher } from "../capabilities/voice-intent/assistant-tools";
import { getKwsWindow, resumeKws, suspendKws } from "../kws-window";

interface VoiceAssistantWiring {
  getMainWindow: () => BrowserWindow | null;
  /** 激活时冻结原前台 app 的 pid(macOS AX 快照,供屏幕上下文截图);无 helper 时返回 null。 */
  captureForegroundPid?: () => Promise<number | null>;
}

let wiring: VoiceAssistantWiring | null = null;
let cachedSnapshot: VoiceAssistantSnapshot | null = null;
// 「其它会话 agent 活动」卡片缓存(overlay 晚挂载时经 request-sync 回放)。
let cachedFeed: VoiceAssistantFeed | null = null;
// 激活单飞:热键/宠物按钮快速连按时,后到的请求等待首个激活完成而不是并发跑两遍
// (并发会把 axCapture 冻结的 pid 覆盖成 Cortex 自己)。
let activating: Promise<void> | null = null;

/** index.ts 在建好主窗口后装配依赖(register 阶段拿不到 mainWindow,与 voice.ts 的
 * setVoiceHotkeyCallbacks 同款两段式)。 */
export function setVoiceAssistantWiring(next: VoiceAssistantWiring): void {
  wiring = next;
}

function mainWindow(): BrowserWindow | null {
  const w = wiring?.getMainWindow() ?? null;
  return w && !w.isDestroyed() ? w : null;
}

function sendCommandToMain(command: VoiceAssistantCommand): void {
  mainWindow()?.webContents.send("voiceAssistant:command", command);
}

async function activate(reason: "hotkey" | "pet" | "settings" | "wakeword"): Promise<void> {
  if (activating) return activating;
  const run = (async (): Promise<void> => {
    // 语音助手活跃期挂起 KWS(任何激活入口,不只 wakeword):TTS 播报里再喊唤醒词不应二次触发。
    if (getKwsWindow()) suspendKws();
    // 冻结前台 pid 必须发生在 overlay 展示之前——语音球出现后 frontmost 语义已被污染。
    try {
      const pid = (await wiring?.captureForegroundPid?.()) ?? null;
      setVoiceChatScreenContextPid(pid);
    } catch {
      // 没有 AX 权限时仍允许激活;截图请求会显式失败而非错误截取 Cortex 自己。
      setVoiceChatScreenContextPid(null);
    }
    ensurePetOverlayWindow();
    setPetOverlayMode("voice");
    // 主窗口隐藏(closeToTray)时 Chromium 会把 timers 节流到秒级,控制器 32ms 的 VAD
    // 采样环路会失真;语音激活期间关掉节流,退出时恢复。media(getUserMedia/Audio)本身
    // 不受节流影响,这里只为了 VAD/状态机的定时器。
    mainWindow()?.webContents.setBackgroundThrottling(false);
    sendCommandToMain({ type: "activate", reason });
  })();
  activating = run;
  try {
    await run;
  } finally {
    if (activating === run) activating = null;
  }
}

function deactivate(): void {
  setPetOverlayMode("pet");
  setVoiceChatScreenContextPid(null);
  cachedSnapshot = null;
  cachedFeed = null;
  mainWindow()?.webContents.setBackgroundThrottling(true);
  sendCommandToMain({ type: "deactivate" });
  // 语音助手退出 → 恢复 KWS 识别(窗口只在唤醒词开启时存在,resume 对空窗口是 no-op)。
  resumeKws();
}

export function registerVoiceAssistantHandlers(): void {
  // 语音控制工具(assistant-tools.ts)的动作下发装配:工具模块不直接 import 本文件
  // (避免把 electron 窗口链拖进 cli/pi-session 的单测),经 setter 注入。
  setVoiceAssistantIntentDispatcher(dispatchVoiceAssistantIntentAction);
  ipcMain.handle("voiceAssistant:activate", async (_e, reason: unknown): Promise<void> => {
    const r = reason === "hotkey" || reason === "pet" || reason === "settings" ? reason : "settings";
    await activate(r);
  });
  ipcMain.handle("voiceAssistant:deactivate", (): void => deactivate());
  ipcMain.handle("voiceAssistant:understandIntent", async (e, text: unknown): Promise<VoiceAssistantIntentResult> => {
    // 意图文本属于用户原始语音内容，只允许主窗口调用；overlay 没有识别管线，也不应获得
    // 一个可借主进程模型处理任意文本的入口。
    const main = mainWindow();
    if (!main || e.sender !== main.webContents) throw new Error("意图理解仅主窗口可用");
    if (typeof text !== "string" || !text.trim()) return { name: "continue_chat", source: "fallback" };
    return understandVoiceIntentFromSettings(text);
  });

  // 主窗口控制器上报状态快照:缓存 + 转发 overlay。仅接受主窗口 sender,防其它窗口伪造。
  ipcMain.on("voiceAssistant:report-state", (e, snapshot: unknown) => {
    const main = mainWindow();
    if (!main || e.sender !== main.webContents) return;
    if (!snapshot || typeof snapshot !== "object") return;
    cachedSnapshot = snapshot as VoiceAssistantSnapshot;
    const overlay = getPetOverlayWindow();
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("voiceAssistant:sync-state", cachedSnapshot);
  });

  // 其它会话 agent 活动卡片:主窗口采集(已节流),缓存 + 转发 overlay。仅接受主窗口 sender。
  ipcMain.on("voiceAssistant:feed", (e, feed: unknown) => {
    const main = mainWindow();
    if (!main || e.sender !== main.webContents) return;
    if (feed !== null && (typeof feed !== "object" || typeof (feed as VoiceAssistantFeed).title !== "string" || typeof (feed as VoiceAssistantFeed).text !== "string")) return;
    cachedFeed = feed as VoiceAssistantFeed | null;
    const overlay = getPetOverlayWindow();
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("voiceAssistant:feed-update", cachedFeed);
  });

  // 电平流:30Hz 高频只转发不缓存(快照里的 level 只作挂载初值)。
  ipcMain.on("voiceAssistant:level", (e, level: unknown) => {
    const main = mainWindow();
    if (!main || e.sender !== main.webContents) return;
    if (typeof level !== "number" || !Number.isFinite(level)) return;
    const overlay = getPetOverlayWindow();
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("voiceAssistant:level", level);
  });

  // overlay 语音球的控制动作。仅接受 overlay 自身 sender(仿 pet:set-enabled 的校验口径)。
  ipcMain.on("voiceAssistant:control", (e, action: unknown) => {
    const overlay = getPetOverlayWindow();
    if (!overlay || overlay.isDestroyed() || e.sender !== overlay.webContents) return;
    if (action === "exit") {
      deactivate();
      return;
    }
    if (action === "ballClick" || action === "micToggle" || action === "speakerToggle") {
      sendCommandToMain({ type: action });
    }
  });

  // overlay 挂载时回放缓存(应对「谁先挂载」的时序竞态,同 pet:request-sync)。
  ipcMain.on("voiceAssistant:request-sync", (e) => {
    e.sender.send("voiceAssistant:mode", getPetOverlayMode());
    if (cachedSnapshot) e.sender.send("voiceAssistant:sync-state", cachedSnapshot);
    if (cachedFeed) e.sender.send("voiceAssistant:feed-update", cachedFeed);
  });

  // 屏幕上下文截图:只允许主窗口(控制器)调用,复用 voice.ts 的冻结 pid + provider 实现。
  ipcMain.handle("voiceAssistant:captureScreen", (e): Promise<{ path: string; mimeType: "image/png" }> => {
    const main = mainWindow();
    if (!main || e.sender !== main.webContents) throw new Error("屏幕上下文仅主窗口可用");
    return captureVoiceScreenshot();
  });
}

/** 语音助手当前是否激活(overlay 处于 voice 模式)。语音控制工具的执行门控用。 */
export function isVoiceAssistantActive(): boolean {
  return getPetOverlayMode() === "voice";
}

/** Agent 语音控制工具的动作下发入口(assistant-tools.ts 调用):验激活态后把本地动作
 * 交主窗口控制器执行(控制器复用与 fast-path 意图相同的动作路径,含 exitAfterSpeech
 * 播完再退的体验红线)。未激活 / 主窗口不在 → false,工具据此返回可读错误而非静默成功。 */
export function dispatchVoiceAssistantIntentAction(
  intent: Exclude<VoiceAssistantIntentResult["name"], "continue_chat">,
): boolean {
  if (!isVoiceAssistantActive()) return false;
  const main = mainWindow();
  if (!main) return false;
  sendCommandToMain({ type: "intentAction", intent });
  return true;
}

/** 全局热键入口:未激活 → 唤起(冻结 pid + 切 voice 模式 + 通知控制器);已激活 → 把
 * 按键语义交给控制器裁决(listening 提交 / speaking 打断,主进程不掺和状态机)。 */
export function toggleVoiceAssistantFromHotkey(): void {
  if (getPetOverlayMode() === "voice") {
    sendCommandToMain({ type: "hotkey" });
    return;
  }
  void activate("hotkey");
}

/** 唤醒词命中入口:已在语音模式则忽略(kws 本应处于 suspend,这里是双保险),
 * 否则走与热键同款的激活路径(含前台 pid 冻结与 overlay 切模式)。 */
export function activateVoiceAssistantFromWakeWord(): void {
  if (getPetOverlayMode() === "voice") return;
  void activate("wakeword");
}
