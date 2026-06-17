// 系统托盘:关窗后应用驻留后台时的入口。左键单击唤起菜单栏 Spotlight 浮动框,
// 左键双击打开主窗口,右键弹出菜单（显示主窗口 / 退出）。让定时任务在窗口关闭后仍能触发。
// menu bar 使用独立的 template 图标,避免受 Dock/app icon 背景影响。

import { Menu, Tray, nativeImage } from "electron";
import { app } from "electron";
import { join } from "path";

let tray: Tray | null = null;
// macOS 双击会先触发两次 click 再触发 double-click,用定时器延迟单击动作,
// 双击到来时取消,避免双击时 Spotlight 先闪一下。
let clickTimer: ReturnType<typeof setTimeout> | null = null;
const DOUBLE_CLICK_MS = 250;

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
  let image = nativeImage.createFromPath(trayIconPath());
  if (!image.isEmpty()) {
    image = image.resize({ width: 16, height: 16 });
    if (process.platform === "darwin") image.setTemplateImage(true);
  }
  tray = new Tray(image);
  tray.setToolTip("Cortex");
  const menu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => opts.onShow() },
    { type: "separator" },
    { label: "退出 Cortex", click: () => opts.onQuit() },
  ]);
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
  tray.on("right-click", () => tray?.popUpContextMenu(menu));
}

export function destroyTray(): void {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  tray?.destroy();
  tray = null;
}
