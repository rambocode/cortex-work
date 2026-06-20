// 内嵌浏览器 IPC。webview 的导航/历史/状态全在渲染端用 webview 元素 API 完成
// (见计划 KTD5),主进程只需暴露「清除浏览数据」一条通道;其余安全靠 web-contents-created
// 上的全局闸门(webviewGuards.ts)与 partition 配置(partition.ts),不经 IPC。

import { ipcMain } from "electron";
import { clearBrowserData } from "../browser/partition";
import { resolveLocalHtml } from "../browser/localHtml";

export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:clearData", async () => {
    await clearBrowserData();
  });
  // 把 agent 产出的本地 HTML 路径授权为可内嵌预览的 file:// URL(校验在允许根内/.html/realpath)。
  // 不合规返回 null。
  ipcMain.handle("browser:resolveLocalHtml", async (_e, path: string): Promise<string | null> => {
    return resolveLocalHtml(path);
  });
}
