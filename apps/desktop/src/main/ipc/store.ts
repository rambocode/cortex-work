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

// 内存镜像：store:save 一到就同步更新,使后续 IPC（如 fs 路径白名单校验）立即
// 看到最新 projects,不必等磁盘写完——否则「添加项目 → 马上扫描目录」会因
// 落盘节流被误拒。
let cached: PersistedState | null = null;

export async function getPersistedState(): Promise<PersistedState> {
  if (cached) return cached;
  await ensureMigrated();
  try {
    const raw = await fsp.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.projects) && Array.isArray(parsed.sessions)) {
      cached = parsed;
      return parsed;
    }
  } catch {
    // 首次启动或文件损坏，回退空状态（不缓存,等首次 save 建立镜像）。
  }
  return EMPTY;
}

// 通用设置里的默认工作目录（agent 启动未显式传 cwd 时兜底）。读 in-memory 镜像
//（generalSettings 立即落盘,反映 renderer 最新设置）。空串视为未设置。
export async function getWorkspaceRoot(): Promise<string | undefined> {
  const root = (await getPersistedState()).generalSettings?.workspaceRoot;
  return root && root.trim() ? root : undefined;
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
    cached = state;
    writeQueue = writeQueue.then(() => savePersistedState(state)).catch((err) => {
      console.error("[personal-workspace] save failed:", err);
    });
    return writeQueue;
  });
}
