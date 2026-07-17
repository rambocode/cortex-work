// 桌面宠物 overlay 窗口:小尺寸、transparent + alwaysOnTop + skipTaskbar 的独立
// BrowserWindow,刚好包住宠物本体,靠 Electron 原生的 `-webkit-app-region: drag`
// (渲染端 Pet.tsx 在 windowFollowsPet 模式下给 .pet 根节点加的 CSS)让操作系统直接
// 移动这扇窗口本身——拖到哪块物理显示器都是原生窗口移动,不存在"一个透明窗口横跨
// 多个显示器"的合成/裁剪问题。
//
// 踩过的坑(勿回退):最初做法是建一扇铺满所有显示器的巨大透明窗口,靠 CSS
// position:fixed 在窗口内部挪动宠物——macOS 对"跨物理显示器"的窗口有限制,宠物拖到
// 第二块屏幕后那部分区域实际没有真实渲染(表现为"拖过去就找不到了"),即使放开
// movable/resizable 限制问题依旧存在,说明限制在更底层,遂改为本文件这种"小窗口跟随"方案。
//
// 窗口尺寸固定为 OVERLAY_WINDOW_W × OVERLAY_WINDOW_H(比宠物最大缩放尺寸略宽松,详见
// Pet.tsx 里同名常量的注释——两处必须保持一致,宠物在窗口内居中显示)。位置由主进程
// 监听 `moved` 事件自行持久化(不经 IPC 往返;窗口原生拖拽产生的位置变化,主进程自己
// 就能观察到,不需要渲染端上报)。

import { BrowserWindow, screen } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { is } from "@electron-toolkit/utils";
import { loadPetPosition, savePetPosition } from "./ipc/pet-store";

let win: BrowserWindow | null = null;
// 原生窗口是否应显示由 overlay renderer 的真实 Pet enabled 状态驱动。初始必须为 false：
// PetBridge 快照尚未到达时 renderer 可能为空，提前展示透明 BrowserWindow 会吞掉底层应用点击。
let visibilityRequested = false;
let contentReady = false;

// 与 packages/views/cortex-desktop/pet/Pet.tsx 里的同名常量保持一致(该文件据此把
// 宠物居中定位在窗口内)。
export const OVERLAY_WINDOW_W = 260;
export const OVERLAY_WINDOW_H = 240;

// prod 下 html 可能落在 flat(../renderer/pet-overlay.html)或 nested(../renderer/src/pet-overlay.html);
// 双路径 existsSync 探测兜底(漏抄会打包后白屏)。仿 notes-overlay.ts。
function petOverlayHtml(): string {
  const flat = join(__dirname, "../renderer/pet-overlay.html");
  const nested = join(__dirname, "../renderer/src/pet-overlay.html");
  return existsSync(flat) ? flat : nested;
}

// 默认位置(尚无持久化记录时):主显示器右下角,对齐原内嵌 CSS 的 `right:18px; bottom:64px`。
function defaultPosition(): { x: number; y: number } {
  const { bounds } = screen.getPrimaryDisplay();
  return {
    x: bounds.x + bounds.width - OVERLAY_WINDOW_W - 18,
    y: bounds.y + bounds.height - OVERLAY_WINDOW_H - 64,
  };
}

function create(): BrowserWindow {
  contentReady = false;
  const { x, y } = defaultPosition();
  win = new BrowserWindow({
    x,
    y,
    width: OVERLAY_WINDOW_W,
    height: OVERLAY_WINDOW_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true, // 原生 app-region:drag 拖拽依赖 movable,不能锁 false
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  if (process.platform === "darwin") {
    // skipTransformProcessType:true —— 同 notes-overlay.ts:避免 visibleOnFullScreen 把进程切成
    // accessory 而隐藏 Dock 图标,保持本 app 的 Dock 常驻。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // skipTaskbar 在 macOS 上只影响 Dock 图标本身,不影响 Dock 图标右键/Window 菜单里的
    // "打开窗口列表"——那个列表由 AppKit 按 isExcludedFromWindowsMenu 生成,skipTaskbar
    // 管不到,必须单独设这个属性才能把 overlay 窗口从该列表里排除。
    win.excludedFromShownWindowsMenu = true;
  }
  // 拖拽结束后(原生 app-region 拖拽,或程序性移动)持久化位置,防抖避免拖拽过程中
  // 逐像素触发的 moved 事件把磁盘写爆——只在停止移动 300ms 后落盘一次。
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  win.on("moved", () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) savePetPosition(win.getBounds());
    }, 300);
  });
  // 内容与 enabled 状态都就绪后才显示。仅 ready 就展示会在宠物被隐藏时留下整块透明原生窗，
  // 该区域仍参与 macOS 命中测试并吞掉对后方应用的点击。
  win.once("ready-to-show", () => {
    contentReady = true;
    if (visibilityRequested) win?.showInactive();
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/pet-overlay.html`);
  } else {
    void win.loadFile(petOverlayHtml());
  }
  win.on("closed", () => {
    win = null;
    contentReady = false;
  });
  // 用上次记忆的位置覆盖默认位置(异步读盘,不阻塞建窗;读到之前用默认右下角兜底,
  // 多数情况下 ready-to-show 尚未触发,不会有肉眼可见的"跳一下")。
  void loadPetPosition().then((pos) => {
    if (pos && win && !win.isDestroyed()) win.setPosition(Math.round(pos.x), Math.round(pos.y));
  });
  return win;
}

export function ensurePetOverlayWindow(): BrowserWindow {
  const existing = win && !win.isDestroyed() ? win : null;
  if (existing) {
    if (visibilityRequested && contentReady && !existing.isVisible()) existing.showInactive();
    return existing;
  }
  return create();
}

/** 让原生窗口跟随 Pet 的真实 enabled 状态；隐藏空 overlay 可释放其整块鼠标命中区。 */
export function setPetOverlayVisibility(visible: boolean): void {
  visibilityRequested = visible;
  const current = win && !win.isDestroyed() ? win : null;
  if (!current) return;
  if (!visible) {
    if (current.isVisible()) current.hide();
    return;
  }
  if (contentReady && !current.isVisible()) current.showInactive();
}

export function getPetOverlayWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyPetOverlayWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  visibilityRequested = false;
  contentReady = false;
}
