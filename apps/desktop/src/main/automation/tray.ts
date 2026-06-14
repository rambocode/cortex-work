// 系统托盘:关窗后应用驻留后台时的入口。左键唤起菜单栏 Spotlight 浮动框,右键弹出菜单
// （显示主窗口 / 退出）。让定时任务在窗口关闭后仍能触发。图标暂复用应用图标。

import { Menu, Tray, nativeImage } from "electron";
import { app } from "electron";
import { join } from "path";

let tray: Tray | null = null;

function trayIconPath(): string {
  const name = "cortex-neuron-icon.png";
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
  if (!image.isEmpty()) image = image.resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip("Cortex Desktop");
  const menu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => opts.onShow() },
    { type: "separator" },
    { label: "退出 Cortex", click: () => opts.onQuit() },
  ]);
  // 不用 setContextMenu:否则 macOS 左键也弹菜单,吃掉 toggle。
  // 左键:toggle Spotlight 浮动框;右键:手动弹菜单。
  tray.on("click", () => opts.onToggleSpotlight());
  tray.on("right-click", () => tray?.popUpContextMenu(menu));
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
