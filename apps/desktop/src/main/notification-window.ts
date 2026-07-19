// 独立通知窗体(第四个二级窗口,与 spotlight / notes / agent-trace 并列)。frameless + 透明 +
// 置顶 + focusable:false(永不抢焦,showInactive),屏幕右上角显示全局提醒卡片。
// 仅在主窗失焦/最小化时由主窗渲染端经 IPC 转发(决策在 App.tsx),应用在前台仍走应用内 toast。
// 骨架仿 notes-overlay.ts;几何抽到 notification-window-geometry.ts 可单测。
//
// 尺寸契约:窗体宽度固定(卡片宽 + 极小留白),高度由 renderer 实测内容上报(notification:resize),
// 主进程夹取后紧贴右上角定位;上报高度 <=1(空栈)即隐藏窗口。

import { BrowserWindow, screen } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { is } from "@electron-toolkit/utils";
import type { NotificationPayload } from "./ipc/types";
import {
  NTF_WIDTH,
  NTF_MAX_HEIGHT_RATIO,
  clampNotificationHeight,
  notificationWindowBounds,
} from "./notification-window-geometry";

let win: BrowserWindow | null = null;

// 就绪握手（KTD:首发丢失竞态）：renderer 的 onPush 监听在 React passive effect 里注册，
// 可能晚于 did-finish-load——只靠 did-finish-load 发送会丢首条(任务提醒单发场景必踩)。
// 改为:renderer 注册完监听后发 notification:ready,主进程在 ready 前把 payload 入队,
// ready 时统一冲刷。窗口重载/销毁时 ready 复位,pending 保留待下次冲刷(提醒不可静默丢)。
let rendererReady = false;
const pending: NotificationPayload[] = [];

// prod 下 html 可能落在 flat / nested,双路径探测兜底(漏抄会白屏)。仿 notes-overlay.ts。
function notificationHtml(): string {
  const flat = join(__dirname, "../renderer/notification.html");
  const nested = join(__dirname, "../renderer/src/notification.html");
  return existsSync(flat) ? flat : nested;
}

// 通知固定显示在主显示器(含菜单栏),与 macOS 原生通知一致、位置可预期。
function primaryWorkArea(): { x: number; y: number; width: number; height: number } {
  return screen.getPrimaryDisplay().workArea;
}

function position(w: BrowserWindow, height: number): void {
  const workArea = primaryWorkArea();
  w.setBounds(notificationWindowBounds(workArea, clampNotificationHeight(height, workArea.height)));
}

function create(): BrowserWindow {
  const workArea = primaryWorkArea();
  win = new BrowserWindow({
    width: NTF_WIDTH,
    height: Math.round(workArea.height * NTF_MAX_HEIGHT_RATIO),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 永不抢焦:用户当前 app 的输入焦点不被打断
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
    // 同 notes-overlay:全屏空间也可见,且不把进程切成 accessory(保持 Dock 图标)。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/notification.html`);
  } else {
    void win.loadFile(notificationHtml());
  }
  // 页面(重)加载即未就绪:等 renderer 重新注册监听后再发 ready(dev 热重载/异常刷新同样覆盖)。
  win.webContents.on("did-start-loading", () => {
    rendererReady = false;
  });
  win.on("closed", () => {
    win = null;
    rendererReady = false;
  });
  return win;
}

// 推送一条提醒到窗体。不在此处 show——等 renderer 渲染后经 resize 上报真实高度再显示,避免
// 透明窗口闪现错误尺寸。renderer 未就绪(首次创建/重载中)则入队,ready 握手后统一冲刷——
// 不能只等 did-finish-load:该事件可能早于 renderer 的监听注册,首条会静默丢失。
export function pushNotification(payload: NotificationPayload): void {
  const w = win && !win.isDestroyed() ? win : create();
  if (process.platform === "darwin")
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (!rendererReady) {
    pending.push(payload);
    return;
  }
  w.webContents.send("notification:push", payload);
}

// renderer 注册完监听后的 ready 回执:置就绪并冲刷积压 payload(按入队顺序)。
export function notificationRendererReady(): void {
  rendererReady = true;
  if (!win || win.isDestroyed()) return;
  for (const p of pending.splice(0)) win.webContents.send("notification:push", p);
}

// renderer 实测高度上报:<=1 视为空栈 → 隐藏;否则夹取定位并(必要时)显示。
export function resizeNotificationWindow(height: number): void {
  if (!win || win.isDestroyed()) return;
  if (height <= 1) {
    if (win.isVisible()) win.hide();
    return;
  }
  position(win, height);
  if (!win.isVisible()) win.showInactive();
}

// 主窗重获焦点时清空外部通知(回到应用即不再用独立窗体打扰)。
export function clearNotifications(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("notification:clear");
  win.hide();
}

export function getNotificationWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyNotificationWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
