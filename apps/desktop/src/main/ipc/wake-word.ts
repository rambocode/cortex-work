// 唤醒词 IPC 域(wakeWord:* 面向主窗口设置页;kws:* 面向 kws 隐藏窗口的窄桥)。
//
// 职责:①运行时开关——按设置拉起/销毁 kws 隐藏窗口;②命中链路——kws:hit 经 sender 校验
// 与冷却检查后走语音助手既有激活路径(含前台 pid 冻结),随即 suspend 识别;③状态查询。
// 设置持久化仍在 renderer 的 voiceSettings(personal-workspace.json),本模块只保存
// 运行时副本;app 启动时 index.ts 从持久化状态读出并调 applyWakeWordSettings。

import { ipcMain, systemPreferences } from "electron";
import type { WakeWordSettings } from "./types";
import { destroyKwsWindow, ensureKwsWindow, getKwsWindow, suspendKws } from "../kws-window";
import { activateVoiceAssistantFromWakeWord } from "./voice-assistant";

// 命中后冷却:防止一次呼喊在确认帧窗口内重复触发多次激活。
const HIT_COOLDOWN_MS = 2_000;

let current: WakeWordSettings = { enabled: false, wordId: "hey-jarvis", sensitivity: "medium" };
let lastHitAt = 0;
// kws renderer 上报的运行状态(设置页展示;degraded = 模型缺失/推理初始化失败)。
let reportedState: "starting" | "running" | "suspended" | "degraded" = "starting";

function sanitize(raw: unknown): WakeWordSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    wordId: "hey-jarvis",
    sensitivity: o.sensitivity === "low" || o.sensitivity === "high" ? o.sensitivity : "medium",
  };
}

/** 应用唤醒词设置(设置页 configure 与 app 启动共用):开 → 拉起隐藏窗口;关 → 销毁。 */
export function applyWakeWordSettings(settings: WakeWordSettings): void {
  current = settings;
  if (settings.enabled) {
    reportedState = "starting";
    const win = ensureKwsWindow();
    // 配置变化(灵敏度等)对已在跑的窗口热下发,renderer 侧无需重建会话。
    win.webContents.send("kws:config-changed", current);
  } else {
    destroyKwsWindow();
  }
}

export function getWakeWordSettings(): WakeWordSettings {
  return current;
}

export function registerWakeWordHandlers(): void {
  // ── 主窗口设置页入口 ──
  ipcMain.handle("wakeWord:getStatus", () => ({
    running: !!getKwsWindow(),
    state: reportedState,
    micPermission:
      process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "granted",
  }));
  ipcMain.handle("wakeWord:configure", (_e, raw: unknown) => {
    const settings = sanitize(raw);
    if (!settings) throw new Error("非法的唤醒词设置");
    applyWakeWordSettings(settings);
  });

  // ── kws 隐藏窗口窄桥(全部校验 sender,防其它窗口伪造命中/借道读配置) ──
  const isKwsSender = (sender: Electron.WebContents): boolean => {
    const win = getKwsWindow();
    return !!win && sender === win.webContents;
  };
  ipcMain.handle("kws:get-config", (e) => {
    if (!isKwsSender(e.sender)) throw new Error("仅唤醒词窗口可用");
    return current;
  });
  ipcMain.on("kws:hit", (e, score: unknown) => {
    if (!isKwsSender(e.sender)) return;
    if (typeof score !== "number" || !Number.isFinite(score)) return;
    const now = Date.now();
    if (now - lastHitAt < HIT_COOLDOWN_MS) return;
    lastHitAt = now;
    // 先挂起识别再激活:激活后语音助手自己开麦,双路并存没问题,但 TTS 提示音/播报
    // 不能再喂回 KWS 造成二次触发。语音助手 deactivate 时由 voice-assistant.ts 恢复。
    suspendKws();
    reportedState = "suspended";
    activateVoiceAssistantFromWakeWord();
  });
  ipcMain.on("kws:state", (e, state: unknown) => {
    if (!isKwsSender(e.sender)) return;
    if (state === "running" || state === "degraded" || state === "suspended" || state === "starting") {
      reportedState = state;
    }
  });
}
