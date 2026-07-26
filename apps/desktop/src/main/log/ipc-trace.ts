// IPC 调用边界统一可观测（U5）。
//
// 背景：register.ts 没有统一的 invoke 包装层，~28 个 handler 各自裸 ipcMain.handle。
// 更关键的缺口（见 crash-guards 头注释）：ipcMain.handle 链内的 reject 由 Electron 直接
// 转发给渲染端 invoke，既不冒泡到进程级 crash-guards、也不落盘 —— handler 异常无据可查。
//
// 方案：仿 logger.patchConsole 的幂等 monkey-patch，在 register 入口一次性接管 ipcMain.handle，
// 包一层记录 channel + 耗时 +（reject 时）入参摘要 + error。不逐文件改 handler（阻力最小）。
//  - 成功：debug 级（dev 才落盘），只记 channel + 耗时，避免高频 invoke 的 payload 噪声。
//  - reject：error 级（始终落盘），补记脱敏入参摘要 + error message，填补上述缺口。

import { ipcMain } from "electron";
import { createLogger } from "./index";
import { redactData } from "./redact";

const log = createLogger("ipc");
let installed = false;

// 入参摘要：第 0 个实参是 IpcMainInvokeEvent（含 sender 等重对象），跳过；其余脱敏 + 截断。
function summarizeArgs(args: unknown[]): unknown {
  return redactData(args.slice(1));
}

/** ENOENT(读/stat 不存在的路径)。errno code 优先,message 兜底(部分包装层只留文案)。 */
function isMissingFileError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return true;
  const message = (err as Error | null)?.message;
  return typeof message === "string" && message.startsWith("ENOENT");
}

// 幂等接管 ipcMain.handle。须在任何 registerXxxHandlers() 之前调用，使其后所有 .handle 被包裹。
// ipcMain.handle 有重载签名，难以直接结构匹配；用一个宽松的本地别名 + 经 unknown 转回。
type IpcHandle = typeof ipcMain.handle;
type LooseHandle = (channel: string, listener: (...args: unknown[]) => unknown) => unknown;

export function installIpcTrace(): void {
  if (installed) return;
  installed = true;
  const orig = ipcMain.handle.bind(ipcMain) as unknown as LooseHandle;
  const patched: LooseHandle = (channel, listener) =>
    orig(channel, async (...args: unknown[]) => {
      const start = Date.now();
      try {
        const result = await listener(...args);
        try {
          log.debug(`ipc ${channel}`, { ms: Date.now() - start });
        } catch {
          /* 日志失败不影响 IPC */
        }
        return result;
      } catch (err) {
        try {
          // 「文件不存在」不是故障:探测可选文件是常规用法(如设计稿的
          // .cortex-design/<doc>/chat/meta.json —— 首次打开本就没有),调用方按 ok:false
          // 优雅降级。按 error 记会持续刷屏、把真正的故障淹掉,故降到 debug。
          // 其余错误(EACCES/EISDIR/业务异常)一律保持 error。
          const level = isMissingFileError(err) ? log.debug : log.error;
          level(`ipc ${channel} 失败`, {
            ms: Date.now() - start,
            args: summarizeArgs(args),
            error: (err as Error)?.message ?? String(err),
          });
        } catch {
          /* 日志失败不影响 IPC */
        }
        throw err; // 保持原 reject 行为不变（渲染端 invoke 仍收到拒绝）
      }
    });
  ipcMain.handle = patched as unknown as IpcHandle;
}

// 仅供单测重置已安装标志。生产代码不要调用。
export function __resetIpcTraceForTests(): void {
  installed = false;
}
