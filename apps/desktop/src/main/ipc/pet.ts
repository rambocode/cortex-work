// 桌面宠物脱离主窗体(独立 pet-overlay 窗口)的状态同步 IPC。主窗口 PetBridge 组件用
// pet:report-state 转发 usePetStore 变化,这里缓存最新一份快照并广播给 pet-overlay 窗口
// (仿 ipc/app.ts 的 broadcastLocale 范式);pet-overlay 窗口挂载时用 pet:request-sync
// 主动要一次,应对"谁先挂载"的时序竞态。
//
// 位置持久化不走这里——pet-overlay-window.ts 里监听窗口自身的 `moved` 事件直接落盘
// (原生 app-region 拖拽产生的位置变化,主进程自己就能观察到,不需要渲染端上报)。

import { BrowserWindow, ipcMain } from "electron";
import type { PetStateSnapshot } from "./types";
import { getPetOverlayWindow, setPetOverlayVisibility } from "../pet-overlay-window";

let cachedState: PetStateSnapshot | null = null;

export function registerPetHandlers(): void {
  ipcMain.on("pet:report-state", (_e, snapshot: PetStateSnapshot) => {
    cachedState = snapshot;
    const overlay = getPetOverlayWindow();
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("pet:sync-state", snapshot);
  });
  ipcMain.on("pet:request-sync", (e) => {
    if (cachedState) e.sender.send("pet:sync-state", cachedState);
  });
  // 仅宠物 overlay 自身可同步其原生窗口可见性。Pet 返回 null 时必须 hide BrowserWindow，
  // 不能只清空 DOM，否则透明窗口仍会拦截对其它应用的点击。
  ipcMain.on("pet:set-overlay-visible", (e, visible: unknown) => {
    if (typeof visible !== "boolean") return;
    const overlay = getPetOverlayWindow();
    if (!overlay || overlay.isDestroyed() || e.sender !== overlay.webContents) return;
    setPetOverlayVisibility(visible);
  });
  // overlay 的关闭按钮必须回写主窗口设置真源；否则主窗口下一次状态广播会携旧的 enabled=true，
  // 把刚隐藏的宠物重新顶出来。只接受 overlay 自身，并只向其它窗口广播这一项设置变更。
  ipcMain.on("pet:set-enabled", (e, enabled: unknown) => {
    if (typeof enabled !== "boolean") return;
    const overlay = getPetOverlayWindow();
    if (!overlay || overlay.isDestroyed() || e.sender !== overlay.webContents) return;
    if (cachedState) cachedState = { ...cachedState, enabled };
    setPetOverlayVisibility(enabled);
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed() && target.webContents !== overlay.webContents)
        target.webContents.send("pet:enabled-changed", enabled);
    }
  });
  // overlay 的缩放手柄同理:overlay 页面的 localStorage 与主窗口不同源,落盘只能由主窗口
  // 做;不回写则下一次状态广播会带旧 size,把刚拖大的宠物顶回原大小。
  ipcMain.on("pet:set-size", (e, size: unknown) => {
    // 区间与 packages/views/cortex-desktop/pet/prefs.ts 的 PET_SIZE_MIN/MAX 对齐
    // (main 不能 import views 层)。上限由 pet-overlay 窗口的固定像素尺寸决定,改一处要改两处。
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0.8 || size > 2) return;
    const overlay = getPetOverlayWindow();
    if (!overlay || overlay.isDestroyed() || e.sender !== overlay.webContents) return;
    if (cachedState) cachedState = { ...cachedState, size };
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed() && target.webContents !== overlay.webContents)
        target.webContents.send("pet:size-changed", size);
    }
  });
}
