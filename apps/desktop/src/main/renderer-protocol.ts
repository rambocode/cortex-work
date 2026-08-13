// 渲染端页面承载协议(cortex-app://):打包态主窗口不再用 file:// 直载 out/renderer。
//
// 为什么:Electron 39 下,宿主页面是 file:// 时其内的 <webview> guest 合成不上屏——
// guest 实际加载成功(CDP 可截到完整内容)但一帧都不绘制,实机表现为「内嵌浏览器/画板
// HTML 框架整片白屏」(v0.1.60 用户实锤;A/B 复现:同一 bundle 换 http 源即恢复)。
// 标准 scheme(standard+secure)与 http 同一套 origin/进程模型,无此问题。
//
// 安全边界:只读 out/renderer 目录、路径规范化防穿越、host 固定,未命中一律 404;
// **不**代理任意本地文件——聊天/写作图片等本地资源仍走 bridge IPC dataURL,不经此协议。
// dev 不经过这里(仍走 vite http 源),本协议只服务打包态。
import { net, protocol } from "electron";
import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_SCHEME = "cortex-app";
// 固定 host:标准 scheme 需要 host 才有稳定 origin(cortex-app://renderer)。
const RENDERER_HOST = "renderer";

/** 打包态某渲染端页面的加载 URL(page 形如 "index.html")。 */
export function rendererPageUrl(page: string): string {
  return `${APP_SCHEME}://${RENDERER_HOST}/${page}`;
}

/**
 * 把请求 URL 解析成 out/renderer 内的绝对文件路径;host 不符 / 越出根目录 → null。
 * 纯函数导出供单测(防目录穿越是这里唯一的安全不变量)。
 */
export function resolveRendererFile(root: string, rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.host !== RENDERER_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!pathname || pathname === "/") pathname = "/index.html";
  const target = normalize(join(root, pathname));
  // 规范化后必须仍在 root 之下(../ 穿越、绝对路径注入一律拒绝)。
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/** 注册 cortex-app:// 的文件服务 handler。app.ready 后调用一次(特权注册在 registerAppSchemes)。 */
export function registerRendererProtocol(): void {
  const root = join(__dirname, "../renderer");
  protocol.handle(APP_SCHEME, (request) => {
    const target = resolveRendererFile(root, request.url);
    if (!target || !existsSync(target)) return new Response("not found", { status: 404 });
    // net.fetch(file://):Chromium 按扩展名给 Content-Type(html/js/css/wasm 等),且透明支持 asar。
    return net.fetch(pathToFileURL(target).toString());
  });
}
