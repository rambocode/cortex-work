// 候选气泡窗（U6，KTD5）：不抢焦浮动 BrowserWindow，锚定目标输入框上方展示回复候选。
// 窗口配方照抄 notification-window.ts —— frameless + 透明 + focusable:false + showInactive，
// 永不抢焦，故用户当前 app 的输入焦点不被打断（抢焦即丢焦，与本功能目标相悖）。
//
// 尺寸/定位契约：宽度固定（BUBBLE_WIDTH），高度由 renderer 实测内容上报（reply-bubble:resize）；
// 主进程据上报高度 + 锚定输入框 frame，经 bubble-window-geometry 计算 bounds 后 setBounds。
// 键盘不在此处理（窗口 focusable:false）：←/→/↩/esc/Tab 由 helper 吞键 → controller 驱动状态重推。

import { BrowserWindow, screen } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { is } from "@electron-toolkit/utils";
import type {
  ReplyBubbleState,
  ReplyBubbleAction,
  ReplyBubbleVoiceCommand,
  ReplyBubbleVoiceResult,
  ReplyRect,
} from "../ipc/reply-types";
import { bubbleWindowBounds, BUBBLE_WIDTH } from "./bubble-window-geometry";

let win: BrowserWindow | null = null;
// 当前会话锚定的输入框 frame（controller 在 open 时提供；null = AX 取不到，走鼠标兜底）。
let anchor: ReplyRect | null = null;
// 最近一次 renderer 上报的内容高度（用于锚点变化时无需等下一次 resize 也能重定位）。
let lastHeight = 120;

// 气泡渲染端鼠标动作的处理器：U6 仅提供可注入注册表，U7 controller 接管真正的翻牌/重试/关闭逻辑。
let actionHandler: ((action: ReplyBubbleAction) => void) | null = null;
// 气泡渲染端语音转写结果的处理器（U8 controller 注入）。
let voiceResultHandler: ((result: ReplyBubbleVoiceResult) => void) | null = null;

/// 注入气泡鼠标动作处理器（U7 controller 调用；未注入时动作被安全忽略）。
export function setReplyBubbleActionHandler(handler: ((action: ReplyBubbleAction) => void) | null): void {
  actionHandler = handler;
}

/// 分发一条气泡动作到已注入的处理器（供 ipc/reply.ts 的 reply-bubble:action 通道调用）。
export function dispatchReplyBubbleAction(action: ReplyBubbleAction): void {
  actionHandler?.(action);
}

/// 注入气泡语音结果处理器（U8 controller 调用；未注入时结果被安全忽略）。
export function setReplyBubbleVoiceResultHandler(
  handler: ((result: ReplyBubbleVoiceResult) => void) | null,
): void {
  voiceResultHandler = handler;
}

/// 分发一条气泡语音转写结果（供 ipc/reply.ts 的 reply-bubble:voice-result 通道调用）。
export function dispatchReplyBubbleVoiceResult(result: ReplyBubbleVoiceResult): void {
  voiceResultHandler?.(result);
}

// prod 下 html 可能落在 flat / nested，双路径探测兜底（漏抄会白屏）。仿 notification-window.ts。
function bubbleHtml(): string {
  const flat = join(__dirname, "../renderer/reply.html");
  const nested = join(__dirname, "../renderer/src/reply.html");
  return existsSync(flat) ? flat : nested;
}

function create(): BrowserWindow {
  win = new BrowserWindow({
    width: BUBBLE_WIDTH,
    height: lastHeight,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 永不抢焦：目标 app 输入焦点不被打断（本功能核心约束）
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
    // 同 notification：全屏空间也可见，且不把进程切成 accessory（保持 Dock 图标）。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/reply.html`);
  } else {
    void win.loadFile(bubbleHtml());
  }
  win.on("closed", () => {
    win = null;
  });
  return win;
}

// 依当前锚点 + 高度算 bounds 并 setBounds（不负责 show/hide，交调用方决定时机）。
function reposition(height: number): void {
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  // Electron display.workArea 与 ax frame 同为左上原点 point/DIP（几何契约，见 geometry 注释）。
  const displays = screen.getAllDisplays().map((d) => d.workArea as ReplyRect);
  win.setBounds(bubbleWindowBounds({ frame: anchor, bubbleHeight: height, displays, cursor }));
}

/// 打开气泡会话：记录锚定输入框 frame（null=AX 缺失→鼠标兜底），创建窗口但先不显示——
/// 等 renderer 首次 resize 上报真实高度后再定位并 showInactive，避免透明窗闪现错误尺寸。
export function openReplyBubble(anchorFrame: ReplyRect | null): void {
  anchor = anchorFrame;
  const w = win && !win.isDestroyed() ? win : create();
  if (process.platform === "darwin")
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

/// 推送气泡可视状态到 renderer（窗口未建则先建）。webContents 尚在加载则等 did-finish-load 再发，
/// 避免推送早于监听丢失（仿 notification-window.ts 的 push 时序守卫）。
export function pushReplyBubbleState(state: ReplyBubbleState): void {
  const w = win && !win.isDestroyed() ? win : create();
  const send = (): void => w.webContents.send("reply-bubble:state", state);
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
}

/// 主进程 → 气泡渲染端下发录音指令（voice start/stop，U8）。窗口尚在加载则等 did-finish-load 再发，
/// 避免指令早于 renderer 的 onVoice 监听丢失（同 pushReplyBubbleState 的时序守卫）。
export function sendReplyBubbleVoice(command: ReplyBubbleVoiceCommand): void {
  const w = win && !win.isDestroyed() ? win : create();
  const send = (): void => w.webContents.send("reply-bubble:voice", command);
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
}

/// renderer 实测高度上报：夹取最小值后重定位并（必要时）showInactive 显示。
export function resizeReplyBubble(height: number): void {
  if (!win || win.isDestroyed()) return;
  lastHeight = Math.max(1, Math.round(height));
  reposition(lastHeight);
  if (!win.isVisible()) win.showInactive();
}

/// 关闭气泡（隐藏，不销毁——下次唤起复用窗口，避免重建开销与闪现）。
export function closeReplyBubble(): void {
  anchor = null;
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function getReplyBubbleWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyReplyBubbleWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  anchor = null;
}
