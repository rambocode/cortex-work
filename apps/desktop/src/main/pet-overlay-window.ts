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
// 高度按「最大只宠物 + 状态气泡」定:petdex 造型在 size=2 时是 220×238,居中后上方还剩
// (304-238)/2 = 33px,刚好容得下 .pet-tip(约 25px + 6px 间距)。窗口是 transparent 的,
// 这块留白不可见,但少了它气泡会被窗口边界裁掉——状态提示等于没有。
export const OVERLAY_WINDOW_W = 260;
export const OVERLAY_WINDOW_H = 304;

// ── 悬停探测:为什么要由主进程轮询光标 ────────────────────────────────────────
// 这扇窗口收不到鼠标**移动**事件,两个原因各自都足以致命:
// ① focusable:false + type:"panel" —— 它永远不会成为 key window,而 macOS 只把
//    mouseMoved 派发给 key window;
// ② 宠物本体整块标了 `-webkit-app-region: drag` —— drag 区域上的移动被 OS 当作
//    窗口拖拽吃掉,不会转成 renderer 的 pointermove。
// 于是 CSS `:hover` 与 React 的 pointerEnter 在 overlay 里永远不更新,实测表现为
// 「必须右键点一下,✕ 和缩放手柄才冒出来」(右键不参与窗口拖拽,会触发一次命中测试)。
// 故这里轮询光标全局坐标,换算成窗口内 CSS 坐标推给渲染端,由它自己判断是否落在宠物
// 身上(见 Pet.tsx 的 externalCursor)。窗口隐藏时不轮询,没有常驻开销。
const CURSOR_POLL_MS = 60;
let cursorTimer: ReturnType<typeof setInterval> | null = null;
let lastCursor: { x: number; y: number } | null = null;

/** 只在坐标变化时发,避免 60ms 一发的常量 IPC 噪音(光标静止时一条都不发)。 */
function sendCursor(next: { x: number; y: number } | null): void {
  if (next?.x === lastCursor?.x && next?.y === lastCursor?.y) return;
  lastCursor = next;
  if (win && !win.isDestroyed()) win.webContents.send("pet:overlay-cursor", next);
}

function pollCursor(): void {
  const current = win && !win.isDestroyed() ? win : null;
  if (!current || !current.isVisible()) {
    sendCursor(null);
    return;
  }
  // getCursorScreenPoint 与 getBounds 同为 DIP 坐标系(多显示器各自缩放已归一),
  // 相减即窗口内 CSS 像素坐标,渲染端可直接与 getBoundingClientRect 比对。
  const point = screen.getCursorScreenPoint();
  const b = current.getBounds();
  const inside =
    point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  sendCursor(inside ? { x: point.x - b.x, y: point.y - b.y } : null);
}

// ── 拖动方向:同样只有主进程看得见 ────────────────────────────────────────────
// 原生 app-region 拖拽全程不经渲染进程(它连 pointerdown 都收不到,窗口是被 OS 搬的),
// 但主进程能从窗口自己的 moved 事件里看出往哪边走。把方向推给渲染端,宠物就能朝拖动
// 方向播奔跑帧(petdex sprite 的行 1/2,见 views 的 rows.ts)。
/** 停止移动多久算「不拖了」。太短会在拖动的微小停顿里反复起停,看起来一顿一顿。 */
const MOVE_IDLE_MS = 180;
let lastMoveX: number | null = null;
let lastMoveDir: "left" | "right" | null = null;
let moveIdleTimer: ReturnType<typeof setTimeout> | null = null;

function sendMoveDir(next: "left" | "right" | null): void {
  if (next === lastMoveDir) return;
  lastMoveDir = next;
  if (win && !win.isDestroyed()) win.webContents.send("pet:overlay-move-dir", next);
}

/** 每次窗口位置变化时调用:横向位移定方向,停手后回落 null。 */
function trackMove(x: number): void {
  // 只看横向:纯上下拖没有左右之分,保持上一个方向比来回翻转自然。
  if (lastMoveX !== null && Math.abs(x - lastMoveX) >= 1) sendMoveDir(x > lastMoveX ? "right" : "left");
  lastMoveX = x;
  if (moveIdleTimer) clearTimeout(moveIdleTimer);
  moveIdleTimer = setTimeout(() => {
    moveIdleTimer = null;
    lastMoveX = null;
    sendMoveDir(null);
  }, MOVE_IDLE_MS);
}

function stopMoveTracking(): void {
  if (moveIdleTimer) clearTimeout(moveIdleTimer);
  moveIdleTimer = null;
  lastMoveX = null;
  sendMoveDir(null);
}

function startCursorPolling(): void {
  if (cursorTimer) return;
  cursorTimer = setInterval(pollCursor, CURSOR_POLL_MS);
}

function stopCursorPolling(): void {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
  sendCursor(null); // 收尾一条,免得窗口再显示时渲染端还挂着上次的悬停态
}

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

/**
 * 把记忆位置钳回它所在那块显示器的可视范围。两个必要场景:
 * ① 换显示器 / 改分辨率后,旧坐标可能整个落在屏幕外 —— 宠物就此"消失",用户无从找回;
 * ② OVERLAY_WINDOW_H 变化时(如本次为状态气泡加高),贴着屏幕底边的旧位置会让窗口底部
 *    被切掉。持久化里只存 {x,y} 没有旧尺寸,做不了精确迁移,钳一下是最省事的兜底。
 * 用 bounds 而非 workArea:宠物是 alwaysOnTop 的 panel,本就允许浮在 Dock / 菜单栏之上,
 * 按 workArea 钳会把它从 Dock 区域挤出来,与 defaultPosition 的取值口径也不一致。
 */
function clampToDisplay(x: number, y: number): { x: number; y: number } {
  const px = Math.round(x);
  const py = Math.round(y);
  const { bounds } = screen.getDisplayNearestPoint({ x: px, y: py });
  return {
    x: Math.min(Math.max(bounds.x, px), bounds.x + bounds.width - OVERLAY_WINDOW_W),
    y: Math.min(Math.max(bounds.y, py), bounds.y + bounds.height - OVERLAY_WINDOW_H),
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
    // 窗口不可聚焦,不加这个的话 macOS 会把落在非激活窗口上的第一次点击吞掉用于「激活窗口」,
    // 表现为 ✕ / 缩放手柄要点两下才响应。
    acceptFirstMouse: true,
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
    // macOS 上 moved 在拖拽过程中连续触发,正好当"窗口在动"的信号用(见 trackMove)。
    if (win && !win.isDestroyed()) trackMove(win.getBounds().x);
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) savePetPosition(win.getBounds());
    }, 300);
  });
  // 内容与 enabled 状态都就绪后才显示。仅 ready 就展示会在宠物被隐藏时留下整块透明原生窗，
  // 该区域仍参与 macOS 命中测试并吞掉对后方应用的点击。
  win.once("ready-to-show", () => {
    contentReady = true;
    if (!visibilityRequested) return;
    win?.showInactive();
    startCursorPolling();
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/pet-overlay.html`);
  } else {
    void win.loadFile(petOverlayHtml());
  }
  win.on("closed", () => {
    stopCursorPolling();
    stopMoveTracking();
    win = null;
    contentReady = false;
  });
  // 用上次记忆的位置覆盖默认位置(异步读盘,不阻塞建窗;读到之前用默认右下角兜底,
  // 多数情况下 ready-to-show 尚未触发,不会有肉眼可见的"跳一下")。
  void loadPetPosition().then((pos) => {
    if (!pos || !win || win.isDestroyed()) return;
    const safe = clampToDisplay(pos.x, pos.y);
    win.setPosition(safe.x, safe.y);
  });
  return win;
}

export function ensurePetOverlayWindow(): BrowserWindow {
  const existing = win && !win.isDestroyed() ? win : null;
  if (existing) {
    if (visibilityRequested && contentReady && !existing.isVisible()) {
      existing.showInactive();
      startCursorPolling();
    }
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
    stopCursorPolling(); // 隐藏后没有悬停可言,别让定时器空转
    stopMoveTracking();
    if (current.isVisible()) current.hide();
    return;
  }
  if (contentReady && !current.isVisible()) {
    current.showInactive();
    startCursorPolling();
  }
}

export function getPetOverlayWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyPetOverlayWindow(): void {
  stopCursorPolling();
  stopMoveTracking();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  visibilityRequested = false;
  contentReady = false;
}
