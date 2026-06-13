// 系统托盘:关窗后应用驻留后台时的入口（显示主窗口 / 退出）。让定时任务在窗口
// 关闭后仍能触发。图标暂复用应用图标（resize 到菜单栏尺寸）;后续可换成
// tray-iconTemplate.png（深浅色菜单栏自适应,macOS setTemplateImage）。

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

export function createTray(opts: { onShow: () => void; onQuit: () => void }): void {
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
  tray.setContextMenu(menu);
  // 左键点击托盘也显示窗口（macOS/Windows）。
  tray.on("click", () => opts.onShow());
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
