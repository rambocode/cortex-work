// 主进程文件日志：写 logs/YYYY-MM-DD.log,启动时按保留天数清理过期,接管 console.error/warn
// 落盘并对 apiKey/token 等敏感字段脱敏。提供「打开日志目录」入口。

import { ipcMain, shell } from "electron";
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { logsDir } from "./paths";
import { getPersistedState } from "./ipc/store";
import { redactString } from "./log/redact";

let enabled = true;
let patched = false;

// 即时更新落盘开关（renderer 切换「启用文件日志」时经 IPC 下发,本次运行内生效）。
export function setLogEnabled(on: boolean): void {
  enabled = on;
}

// 敏感字段脱敏统一走共享 log/redact。保留 redactSensitive 导出名以兼容既有调用方与测试。
export const redactSensitive = redactString;

// 日志文件名（按本地日期）。
export function logFileName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}.log`;
}

// 写一行日志到 dir/<date>.log（on=false 跳过）。落盘失败不影响主流程。
export function appendLog(dir: string, on: boolean, level: string, message: string, date: Date): void {
  if (!on) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, logFileName(date)),
      redactSensitive(`[${date.toISOString()}] [${level}] ${message}\n`),
    );
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

// 删除 dir 下 mtime 超过 retentionDays 的 .log 文件。
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

export function logLine(level: string, message: string): void {
  appendLog(logsDir(), enabled, level, message, new Date());
}

// 接管主进程 console.error/warn → 同步落盘（保留控制台输出）。幂等：重复调用 no-op,
// 避免嵌套包裹导致重复落盘。可在 whenReady 最前调用以捕获启动期错误（默认 enabled=true）。
export function patchConsole(): void {
  if (patched) return;
  patched = true;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    logLine("error", args.map(String).join(" "));
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    logLine("warn", args.map(String).join(" "));
    origWarn(...args);
  };
}

// 启动时读设置：恢复 enabled、清理过期。console 接管由 patchConsole 负责（幂等,
// 通常 main 已在 whenReady 最前调用以捕获迁移等早期错误）。
export async function initLogger(): Promise<void> {
  patchConsole();
  const log = (await getPersistedState()).generalSettings?.log;
  enabled = log?.enabled !== false;
  cleanupOldLogs(logsDir(), log?.retentionDays ?? 2, Date.now());
  logLine("info", "Cortex 启动");
}

export function registerLogHandlers(): void {
  ipcMain.handle("logs:open", async () => {
    mkdirSync(logsDir(), { recursive: true });
    await shell.openPath(logsDir());
  });
  ipcMain.handle("logs:setEnabled", (_e, on: boolean) => setLogEnabled(on));
  // 渲染端写一行日志（不落盘的 agent 报错/失败信息）。复用 logLine：尊重 enabled 开关 + 脱敏。
  ipcMain.handle("logs:write", (_e, level: string, message: string) => logLine(level, message));
}
