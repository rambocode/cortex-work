// 语音聊天独立浮层：保持一扇可复用的、可聚焦的 panel 窗口。
//
// 它刻意不同于 reply bubble：语音聊天需要显示完整转写与流式回复、允许关闭按钮交互，
// 因而 focusable:true；录音只在这个独立 renderer 内发生，主窗口既不会失焦也不会持有
// getUserMedia。窗口隐藏而不销毁，使全局快捷键再次唤起时无需重建渲染进程。

import { BrowserWindow, screen } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";

export const VOICE_CHAT_WINDOW_WIDTH = 480;
export const VOICE_CHAT_WINDOW_HEIGHT = 520;

export interface VoiceChatWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VoiceChatCommand = "startListening" | "stopAndSubmit" | "focus";

let win: BrowserWindow | null = null;

/** 将固定尺寸浮层居中于给定工作区；小屏保持工作区左上角，绝不生成负坐标。 */
export function voiceChatWindowBounds(workArea: { x: number; y: number; width: number; height: number }): VoiceChatWindowBounds {
  return {
    x: Math.max(workArea.x, Math.round(workArea.x + (workArea.width - VOICE_CHAT_WINDOW_WIDTH) / 2)),
    y: Math.max(workArea.y, Math.round(workArea.y + (workArea.height - VOICE_CHAT_WINDOW_HEIGHT) / 2)),
    width: VOICE_CHAT_WINDOW_WIDTH,
    height: VOICE_CHAT_WINDOW_HEIGHT,
  };
}

// production 构建的 HTML 在 electron-vite 下可能为 flat 或 src 嵌套；双路径探测防止打包后白屏。
function voiceChatHtml(): string {
  const flat = join(__dirname, "../renderer/voice-chat.html");
  const nested = join(__dirname, "../renderer/src/voice-chat.html");
  return existsSync(flat) ? flat : nested;
}

function createVoiceChatWindow(): BrowserWindow {
  const bounds = voiceChatWindowBounds(screen.getPrimaryDisplay().workArea);
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    // 在全屏桌面上也保持可见；仍保持普通 app 进程类型，不隐藏 Dock 图标。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/voice-chat.html`);
  } else {
    void win.loadFile(voiceChatHtml());
  }
  win.on("closed", () => {
    win = null;
  });
  return win;
}

/** 显示并聚焦语音聊天窗；窗口不存在或已销毁时先创建。 */
export function openVoiceChatWindow(): BrowserWindow {
  const window = win && !win.isDestroyed() ? win : createVoiceChatWindow();
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  window.show();
  window.focus();
  return window;
}

/** 隐藏而非销毁，保留 renderer 中已经初始化的录音/播放资源和事件订阅。 */
export function closeVoiceChatWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

/** 向浮层发送命令；页面加载中的消息延迟到 did-finish-load，避免首次全局快捷键丢失。 */
export function sendVoiceChatCommand(command: VoiceChatCommand): void {
  const window = openVoiceChatWindow();
  const send = (): void => window.webContents.send("voice-chat:command", command);
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
}

export function getVoiceChatWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** 应用真正退出时销毁窗口，防止隐藏窗体在测试/重启过程中保留引用。 */
export function destroyVoiceChatWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
