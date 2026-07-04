// 桌面宠物脱离主窗体(独立 pet-overlay 窗口)的状态同步 IPC。主窗口 PetBridge 组件用
// pet:report-state 转发 usePetStore 变化,这里缓存最新一份快照并广播给 pet-overlay 窗口
// (仿 ipc/app.ts 的 broadcastLocale 范式);pet-overlay 窗口挂载时用 pet:request-sync
// 主动要一次,应对"谁先挂载"的时序竞态。
//
// 位置持久化不走这里——pet-overlay-window.ts 里监听窗口自身的 `moved` 事件直接落盘
// (原生 app-region 拖拽产生的位置变化,主进程自己就能观察到,不需要渲染端上报)。

import { ipcMain } from "electron";
import type { PetStateSnapshot } from "./types";
import { getPetOverlayWindow } from "../pet-overlay-window";

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
}
