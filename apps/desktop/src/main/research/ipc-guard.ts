// research IPC 的 sender 校验（spec §16「main 校验 sender 和 schema」）。
//
// **仓库现状**：其余 IPC 域没有统一的 sender 校验（历史包袱）。本次**只对 research 域引入**，
// 不改全仓——一次性给上百个 handler 加守卫，风险远大于收益。将来若要推广，把本文件提到
// main/ipc/ 下做成通用中间件即可，判定逻辑无需改动。
//
// 为什么需要它：CRE 的 IPC 能触发外部网络请求与本地磁盘写入。若某个被劫持的 <webview>
// 或被注入的远程页面能拿到 ipcRenderer（例如未来某处误开 nodeIntegration），
// 它就能借 research:run 把主进程当成代理去打内网。校验 senderFrame 的 URL 属于本应用自身，
// 是最小成本的一道闸。
import type { IpcMainInvokeEvent } from "electron";

/// 判断一个 sender frame 的 URL 是否属于本应用自身。
///
/// 允许两种形态，且**只有这两种**：
/// - `file://`：打包态渲染进程加载的本地页面；
/// - 与 devServerUrl 同 origin 的页面：开发态 electron-vite dev server。
///   同 origin 而非同前缀——`http://localhost:5173.evil.com` 会通过前缀匹配，但过不了 origin 比较。
///
/// devServerUrl 缺省（打包态）时，任何 http(s) 来源一律拒绝。
export function isAllowedResearchSenderUrl(
  rawUrl: string | null | undefined,
  devServerUrl?: string,
): boolean {
  if (!rawUrl) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return true;
  if (!devServerUrl) return false;

  try {
    return url.origin === new URL(devServerUrl).origin && url.origin !== "null";
  } catch {
    return false;
  }
}

/// 校验一次 IPC 调用的发起方；不属于本应用自身即抛错。
///
/// 错误消息只带 origin 不带完整 URL：完整 URL 的 query string 可能含一次性凭据，
/// 而这条消息会进日志。
export function assertResearchSender(event: IpcMainInvokeEvent): void {
  const rawUrl = event.senderFrame?.url ?? null;
  if (isAllowedResearchSenderUrl(rawUrl, process.env["ELECTRON_RENDERER_URL"])) return;
  throw new Error(`research IPC 拒绝了不可信的调用方：${describeOrigin(rawUrl)}`);
}

/// 只提取 origin 用于报错；无法解析时给固定占位。
function describeOrigin(rawUrl: string | null): string {
  if (!rawUrl) return "<no-frame>";
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "<invalid-url>";
  }
}
