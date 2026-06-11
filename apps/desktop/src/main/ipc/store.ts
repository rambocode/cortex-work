// 个人工作区持久化：~/.cortex-desktop/personal-workspace.json 全量读写。
// renderer 侧节流后调 store:save 覆盖；主进程串行化写入避免交错。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { dirname } from "path";
import type { PersistedState } from "./types";
import { ensureMigrated, workspaceStorePath } from "../paths";

const EMPTY: PersistedState = { version: 1, projects: [], sessions: [] };

function storePath(): string {
  return workspaceStorePath();
}

let writeQueue: Promise<void> = Promise.resolve();

export async function getPersistedState(): Promise<PersistedState> {
  await ensureMigrated();
  try {
    const raw = await fsp.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.projects) && Array.isArray(parsed.sessions)) {
      return parsed;
    }
  } catch {
    // 首次启动或文件损坏，回退空状态。
  }
  return EMPTY;
}

async function savePersistedState(state: PersistedState): Promise<void> {
  await ensureMigrated();
  const path = storePath();
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, path);
}

export function registerStoreHandlers(): void {
  ipcMain.handle("store:load", () => getPersistedState());
  ipcMain.handle("store:save", (_e, state: PersistedState) => {
    writeQueue = writeQueue.then(() => savePersistedState(state)).catch((err) => {
      console.error("[personal-workspace] save failed:", err);
    });
    return writeQueue;
  });
}
