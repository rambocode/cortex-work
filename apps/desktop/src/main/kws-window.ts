// 唤醒词 KWS 的常驻 hidden window 生命周期。
//
// 为什么独立窗口而不是主窗口/主进程：主窗口可被 closeToTray 隐藏，隐藏时 Chromium 把
// 定时器节流到秒级，7×24 的 KWS 采样环会失真（语音助手靠激活期临时关节流规避，KWS 没有
// "激活期"）；主进程没有 getUserMedia，引入原生采集 + onnxruntime-node 两个新原生依赖
// 得不偿失，还丢掉 Chromium 自带 AEC（防 TTS 自唤醒的第一道防线）。
// 该窗口只在用户显式开启唤醒词后创建；suspend 时停推理不放流（保持 track 打开，避免设备
// 重新上电延迟；macOS 橙点在监听期间常亮，本身就是隐私透明的一部分）。

import { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";

let win: BrowserWindow | null = null;
// 崩溃退避重建:连崩 3 次后放弃(标 degraded),防止坏模型/坏驱动进入无限重启循环。
let crashCount = 0;
let recreateTimer: ReturnType<typeof setTimeout> | null = null;

function kwsHtml(): string {
  const flat = join(__dirname, "../renderer/kws.html");
  const nested = join(__dirname, "../renderer/src/kws.html");
  return existsSync(flat) ? flat : nested;
}

/** 创建(或复用)KWS 隐藏窗口。窗口从不 show,仅作为音频采集与 wasm 推理的宿主。 */
export function ensureKwsWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false },
  });
  // 该窗口没有 UI,无省电语义损失;不关节流的话隐藏窗口的采样定时器同样会被降到秒级。
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on("render-process-gone", () => {
    // 崩溃重建走退避:模型/驱动异常时不无限循环烧 CPU。
    crashCount += 1;
    const dead = win;
    win = null;
    dead?.destroy();
    if (crashCount > 3) return;
    if (recreateTimer) clearTimeout(recreateTimer);
    recreateTimer = setTimeout(() => {
      recreateTimer = null;
      if (crashCount <= 3) ensureKwsWindow();
    }, 1000 * crashCount);
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/kws.html`);
  else void win.loadFile(kwsHtml());
  return win;
}

export function getKwsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyKwsWindow(): void {
  if (recreateTimer) clearTimeout(recreateTimer);
  recreateTimer = null;
  crashCount = 0;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

/** 语音助手活跃期挂起识别(防 TTS 播报期自唤醒/重复触发);退出后恢复。
 * 只停推理不放流——kws renderer 收到后停 onnx 环但保持 getUserMedia track。 */
export function suspendKws(): void {
  getKwsWindow()?.webContents.send("kws:control", "suspend");
}

export function resumeKws(): void {
  getKwsWindow()?.webContents.send("kws:control", "resume");
}
