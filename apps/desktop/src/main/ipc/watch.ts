// 目录实时监听（右栏「文件」视图自动刷新）。借鉴 fanbox：fs.watch 原生递归
// （macOS FSEvents/Windows;Linux 递归不可靠则降级非递归）,噪声过滤 + 250ms
// 去抖后只推「变了」信号,renderer 收到后自行重扫 scanDirTree。

import { ipcMain } from "electron";
import { watch, type FSWatcher } from "fs";
import { assertAllowed } from "./fs";
import { isNoisyChange } from "./watch-noise";

const DEBOUNCE_MS = 250;

interface WatchEntry {
  watcher: FSWatcher;
  timer?: NodeJS.Timeout;
}

const watchers = new Map<string, WatchEntry>();

function closeWatcher(id: string): void {
  const entry = watchers.get(id);
  if (!entry) return;
  watchers.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch {
    /* 已失效 */
  }
}

export function registerWatchHandlers(): void {
  ipcMain.handle("fs:watchDir", async (event, { id, path }: { id: string; path: string }) => {
    await assertAllowed(path);
    closeWatcher(id); // 同 id 重复 watch（切项目/重挂载）先关旧的
    const sender = event.sender;
    try {
      const recursive = process.platform !== "linux";
      const watcher = watch(path, { persistent: false, recursive }, (_evt, filename) => {
        if (isNoisyChange(filename ? filename.toString() : null)) return;
        const entry = watchers.get(id);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (!sender.isDestroyed()) sender.send("fs:dirChanged", { id });
        }, DEBOUNCE_MS);
      });
      // 根目录被删/重命名等导致 watcher 失效:静默关闭,保留手动刷新兜底。
      watcher.on("error", () => closeWatcher(id));
      watchers.set(id, { watcher });
    } catch {
      /* 无权限/目录消失:不抛错,renderer 仍可手动刷新 */
    }
  });

  ipcMain.on("fs:unwatchDir", (_e, { id }: { id: string }) => closeWatcher(id));
}

export function closeAllWatchers(): void {
  for (const id of [...watchers.keys()]) closeWatcher(id);
}
