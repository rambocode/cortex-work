// 系统托盘:关窗后应用驻留后台时的入口。左键单击唤起菜单栏 Spotlight 浮动框,
// 左键双击打开主窗口,右键弹出菜单（显示主窗口 / 退出）。让定时任务在窗口关闭后仍能触发。
// menu bar 使用独立的 template 图标,避免受 Dock/app icon 背景影响。

import { Menu, Tray, nativeImage } from "electron";
import { app } from "electron";
import { join } from "path";
import { trayStrings, DEFAULT_LOCALE, type Locale } from "@cortex-work/core/i18n/native";

let tray: Tray | null = null;
// macOS 双击会先触发两次 click 再触发 double-click,用定时器延迟单击动作,
// 双击到来时取消,避免双击时 Spotlight 先闪一下。
let clickTimer: ReturnType<typeof setTimeout> | null = null;
const DOUBLE_CLICK_MS = 250;

// 菜单点击回调留在模块作用域:语言切换需重建菜单(buildFromTemplate 不可改),
// 重建时复用同一组回调。
let menuCallbacks: { onShow: () => void; onQuit: () => void } | null = null;
// 当前托盘语言(主窗口 i18next 为权威源,主进程为最终一致镜像)。
let currentLocale: Locale = DEFAULT_LOCALE;
// 右键弹出用的当前菜单:rebuildTrayMenu 重建后替换,right-click 始终弹最新语言版本。
let contextMenu: Menu | null = null;

// 按当前语言构建托盘菜单(显示主窗口 / 退出),并缓存供 right-click 弹出。
function buildTrayMenu(): Menu {
  const t = trayStrings(currentLocale);
  contextMenu = Menu.buildFromTemplate([
    { label: t.showMainWindow, click: () => menuCallbacks?.onShow() },
    { type: "separator" },
    { label: t.quit, click: () => menuCallbacks?.onQuit() },
  ]);
  return contextMenu;
}

// 语言切换时(主进程 app:setLocale 收到后调用)重建并重应用托盘菜单。
// 托盘未创建时仅记录语言,createTray 时按此语言初次构建。
export function rebuildTrayMenu(locale: Locale): void {
  currentLocale = locale;
  if (!tray) return;
  // 不用 setContextMenu(macOS 左键会弹菜单吃掉 toggle):只重建缓存,right-click 弹新菜单。
  buildTrayMenu();
}

function trayIconPath(): string {
  const name = "cortex-tray-iconTemplate.png";
  return app.isPackaged
    ? join(app.getAppPath(), "assets", name)
    : join(__dirname, "../../assets", name);
}

export function createTray(opts: {
  onShow: () => void;
  onQuit: () => void;
  onToggleSpotlight: () => void;
}): void {
  if (tray) return;
  menuCallbacks = { onShow: opts.onShow, onQuit: opts.onQuit };
  let image = nativeImage.createFromPath(trayIconPath());
  if (!image.isEmpty()) {
    image = image.resize({ width: 16, height: 16 });
    if (process.platform === "darwin") image.setTemplateImage(true);
  }
  tray = new Tray(image);
  tray.setToolTip("Cortex");
  // 初次按当前已记录语言构建(默认 zh-Hans;若启动前已 setLocale 则用其值)。
  buildTrayMenu();
  // 不用 setContextMenu:否则 macOS 左键也弹菜单,吃掉 toggle。
  // 左键单击:延迟后 toggle Spotlight 浮动框（等待是否有双击）;
  // 左键双击:取消单击,打开主窗口;右键:手动弹菜单。
  tray.on("click", () => {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      opts.onToggleSpotlight();
    }, DOUBLE_CLICK_MS);
  });
  tray.on("double-click", () => {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    opts.onShow();
  });
  tray.on("right-click", () => {
    if (contextMenu) tray?.popUpContextMenu(contextMenu);
  });
}

export function destroyTray(): void {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  tray?.destroy();
  tray = null;
  contextMenu = null;
  menuCallbacks = null;
}
