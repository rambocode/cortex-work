// 个人工作区持久化：~/.cortex-desktop/personal-workspace.json 全量读写。
// renderer 侧节流后调 store:save 覆盖；主进程串行化写入避免交错。

import { BrowserWindow, ipcMain } from "electron";
import { existsSync, promises as fsp } from "fs";
import { dirname } from "path";
import type { PersistedState, PushSettings } from "./types";
import { ensureMigrated, workspaceStorePath } from "../paths";
import { createLogger } from "../log";

const log = createLogger("personal-workspace");

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
//（generalSettings 立即落盘,反映 renderer 最新设置）。空串/失效目录视为未设置,
// 让调用方回退主目录,避免把失效路径交给 spawn 触发 ENOENT。
export async function getWorkspaceRoot(): Promise<string | undefined> {
  const root = (await getPersistedState()).generalSettings?.workspaceRoot;
  if (!root || !root.trim()) return undefined;
  return existsSync(root) ? root : undefined;
}

async function savePersistedState(state: PersistedState): Promise<void> {
  await ensureMigrated();
  const path = storePath();
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, path);
}

// pushSettings 变更广播：推给**所有**窗口（含发起方）。项目管理等二级窗口刻意不挂全量持久化
// （防陈旧快照 clobber，见 ProjectsWorkbench 注释），它们的 pushSettings 镜像只能靠这条窄通道
// 保持新鲜；主窗口收到自己发起的变更时内容相等、渲染端跳过写入，不会形成 save→广播→save 回环。
function broadcastPushSettingsIfChanged(prev: PushSettings | undefined, next: PushSettings | undefined): void {
  if (JSON.stringify(prev ?? {}) === JSON.stringify(next ?? {})) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("store:push-settings-changed", next ?? {});
  }
}

// onSaved 的模块级引用。提到模块作用域是为了让 updatePersistedState（main 内部发起的窄写）
// 与 renderer 发起的 store:save 走**完全相同**的提交路径——否则 main 侧写入不会触发订阅方
// （如 syncResearchEngineRuntime），改了设置却要重启才生效。
let onSavedCallback: ((state: PersistedState) => void) | undefined;

/// 统一的提交路径：更新内存镜像 → 通知订阅方 → 广播 → 串行落盘。
function commit(prev: PersistedState | null, state: PersistedState): Promise<void> {
  cached = state;
  onSavedCallback?.(state);
  broadcastPushSettingsIfChanged(prev?.pushSettings, state.pushSettings);
  writeQueue = writeQueue.then(() => savePersistedState(state)).catch((err) => {
    log.error("save failed:", err);
  });
  return writeQueue;
}

/// main 内部的窄写通道：在**权威态**上就地合并后落盘，返回合并后的状态。
///
/// 为什么不让 renderer 传全量状态过来：那会有「陈旧全量快照 clobber」问题
/// （同 store:patchPushSettings 的注释）。main 侧要写的东西——比如 safeStorage 加密后的
/// Search Server 密文——renderer 根本不该持有全量上下文，只能由 main 读最新态再改一处。
export async function updatePersistedState(
  mutate: (state: PersistedState) => PersistedState,
): Promise<PersistedState> {
  const base = await getPersistedState();
  const next = mutate(base);
  await commit(base, next);
  return next;
}

// onSaved：每次 renderer 全量落设置后同步调用（cached 已更新）。用于让 main 侧订阅方即时
// 反应设置变更——当前唯一订阅方是任务提醒调度器（读 pushSettings.internal.enabled opt-in 变化，
// off→on 建 Cron/补跑、on→off 拆全部）。回调抛错不阻断落盘（调用方自行兜底）。
export function registerStoreHandlers(onSaved?: (state: PersistedState) => void): void {
  onSavedCallback = onSaved;
  ipcMain.handle("store:load", () => getPersistedState());
  ipcMain.handle("store:save", (_e, state: PersistedState) => commit(cached, state));
  // pushSettings 窄写通道：main 在权威态上就地合并后落盘，供不挂全量持久化的窗口
  // （项目管理等）安全写入推送开关——绕开「陈旧全量快照 clobber」问题。
  ipcMain.handle("store:patchPushSettings", async (_e, patch: Partial<PushSettings>) => {
    const base = await getPersistedState();
    return commit(base, { ...base, pushSettings: { ...base.pushSettings, ...patch } });
  });
}
