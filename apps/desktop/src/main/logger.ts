// 主进程文件日志「契约层」：在 electron-log（log/index.ts）之上重建既有对外能力——
// logs:* IPC、generalSettings.log 设置项、按天文件 + 保留 N 天清理、敏感字段脱敏。
//
// 分工：传输/分级/scope/console 接管/按天落盘/脱敏 transform 由 log/index.ts 负责；
// 本文件只保留「契约」——既有调用方（index 装配序列、preload logs:write、设置 UI）
// 看到的 API 形状不变，内部改走 electron-log 同一管线，避免两套日志/两个开关并行。

import { ipcMain, shell } from "electron";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { logsDir } from "./paths";
import { getPersistedState } from "./ipc/store";
import { redactString } from "./log/redact";
import log, { initLog, setFileLogEnabled } from "./log";
import { installScopeFilter, setDebugScopes } from "./log/scope-filter";

// 敏感字段脱敏统一走共享 log/redact。保留 redactSensitive 导出名以兼容既有调用方与测试。
export const redactSensitive = redactString;

// 即时更新落盘开关（renderer 切换「启用文件日志」时经 IPC 下发）。
// 映射到 electron-log 文件 transport 级别：关=false 彻底停写。
export function setLogEnabled(on: boolean): void {
  setFileLogEnabled(on);
}

// 日志文件名（按本地日期）。electron-log 的按天落盘由 log/index.ts 的 resolveLogFilePath
// 负责，本函数仅保留供既有调用方/测试引用（命名与落盘前缀不必一致）。
export function logFileName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}.log`;
}

// 删除 dir 下 mtime 超过 retentionDays 的 .log 文件。electron-log 只做单文件大小轮转、
// 不提供「保留 N 天」清理，故这段自研逻辑保留（启动时 initLogger 调用）。
export function cleanupOldLogs(dir: string, retentionDays: number, now: number): void {
  try {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".log")) continue;
      const full = join(dir, name);
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    }
  } catch {
    /* 目录不存在/读取失败忽略 */
  }
}

// 写一行日志（无 scope）：路由进 electron-log 同一管线（级别阈值 + 脱敏 transform + 落盘）。
// 供 logs:write（渲染端）与主进程通用日志复用。level 非法时回退 info。
// enabled 开关由文件 transport 级别承接（setLogEnabled），此处不再单独判断。
export function logLine(level: string, message: string): void {
  const fn = (log as unknown as Record<string, ((m: string) => void) | undefined>)[level];
  (typeof fn === "function" ? fn : log.info).call(log, message);
}

// 接管 console：委托给 electron-log 初始化（幂等）。保留 patchConsole 名以兼容 index
// 装配序列。须在 whenReady 最前调用以捕获迁移等启动期错误（initLog 接管全级别 console）。
export function patchConsole(): void {
  initLog();
}

// 启动时读设置：初始化 electron-log、装 scope 过滤、按设置开关 + 清理过期。
// 与 crash-guards 的协作：刻意不启用 electron-log 的 errorHandler.startCatching——
// crash-guards 是唯一崩溃捕获者，其 logger.error 经已接管的 console 进入 electron-log
// 单次落盘；两边都开会让同一条 crash 写两遍。
export async function initLogger(): Promise<void> {
  initLog();
  installScopeFilter();
  const logSettings = (await getPersistedState()).generalSettings?.log;
  setFileLogEnabled(logSettings?.enabled !== false);
  setDebugScopes(logSettings?.debugScopes);
  cleanupOldLogs(logsDir(), logSettings?.retentionDays ?? 2, Date.now());
  log.info("Cortex 启动");
}

export function registerLogHandlers(): void {
  ipcMain.handle("logs:open", async () => {
    mkdirSync(logsDir(), { recursive: true });
    await shell.openPath(logsDir());
  });
  ipcMain.handle("logs:setEnabled", (_e, on: boolean) => setLogEnabled(on));
  // 渲染端写一行日志（agent 报错/失败信息）。复用 logLine：同一管线 + 脱敏 + 开关。
  ipcMain.handle("logs:write", (_e, level: string, message: string) => logLine(level, message));
}
