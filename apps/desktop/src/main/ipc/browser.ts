// 内嵌浏览器 IPC。webview 的导航/历史/状态全在渲染端用 webview 元素 API 完成
// (见计划 KTD5),主进程只需暴露「清除浏览数据」一条通道;其余安全靠 web-contents-created
// 上的全局闸门(webviewGuards.ts)与 partition 配置(partition.ts),不经 IPC。

import { ipcMain, clipboard, nativeImage } from "electron";
import { clearBrowserData } from "../browser/partition";
import { resolveLocalHtml } from "../browser/localHtml";

// 截图 PNG 上限:防畸形/超大 buffer 撑爆主进程内存(安全评审)。32MB 足够任意可视区截图。
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;

export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:clearData", async () => {
    await clearBrowserData();
  });
  // 把渲染端 webview.capturePage() 得到的 PNG 字节写入系统剪贴板(计划 U3/KTD4)。
  // contextIsolation+sandbox 下渲染端不能直接用 clipboard,必须经此 IPC。
  // 入参严格校验(PNG 魔数 + 非空 + 上限)再构造 NativeImage,防滥用。返回是否成功。
  ipcMain.handle("browser:copyImage", async (_e, png: unknown): Promise<boolean> => {
    if (!(png instanceof Uint8Array) || png.byteLength < 8 || png.byteLength > MAX_SCREENSHOT_BYTES) {
      return false;
    }
    // PNG 魔数:89 50 4E 47。
    if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return false;
    const image = nativeImage.createFromBuffer(Buffer.from(png));
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });
  // 把 agent 产出的本地 HTML 路径授权为可内嵌预览的 file:// URL(校验在允许根内/.html/realpath)。
  // 不合规返回 null。
  ipcMain.handle("browser:resolveLocalHtml", async (_e, path: string): Promise<string | null> => {
    return resolveLocalHtml(path);
  });
}
