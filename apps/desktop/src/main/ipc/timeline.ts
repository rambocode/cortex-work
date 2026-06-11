// 项目时间线持久化：~/.cortex-desktop/timelines/<projectId>.json。
// 数据结构对主进程不透明（core 的 TimelineFileData），按 unknown 读写。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { join } from "path";
import { timelinesDir } from "../paths";

const SAFE_ID = /^[\w-]+$/;

function timelinePath(projectId: string): string {
  if (!SAFE_ID.test(projectId)) throw new Error(`非法 project id: ${projectId}`);
  return join(timelinesDir(), `${projectId}.json`);
}

// 按项目串行化写入，避免同一文件交错。
const writeQueues = new Map<string, Promise<void>>();

export function registerTimelineHandlers(): void {
  ipcMain.handle("timeline:load", async (_e, projectId: string) => {
    try {
      const raw = await fsp.readFile(timelinePath(projectId), "utf8");
      return JSON.parse(raw) as unknown;
    } catch {
      return null; // 首次或文件不存在
    }
  });

  ipcMain.handle("timeline:save", (_e, projectId: string, data: unknown) => {
    const path = timelinePath(projectId);
    const prev = writeQueues.get(projectId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await fsp.mkdir(timelinesDir(), { recursive: true });
        const tmp = path + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(data), "utf8");
        await fsp.rename(tmp, path);
      })
      .catch((err) => {
        console.error("[personal-timeline] save failed:", err);
      });
    writeQueues.set(projectId, next);
    return next;
  });
}
