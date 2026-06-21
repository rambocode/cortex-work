// 内嵌浏览器 <webview> 的主进程安全闸门。移植自参考仓库 Kun
// (src/main/index.ts installDevPreviewWebviewGuards),但因本应用地址栏要支持**任意
// https 公网站点**(Kun 只服务本地预览),把「local-only allow-list」放宽为
// 「严格 scheme 白名单 + 公网 origin 禁跳私网」(见计划 KTD2/KTD6)。
//
// 三道闸门(全部挂在 app 'web-contents-created' 上):
//   1. will-attach-webview:强制覆盖 webPreferences(删业务 preload、关 nodeIntegration、
//      开 contextIsolation/sandbox),不信渲染端声明(防篡改绕过隔离)。
//   2. will-navigate / will-redirect:共用 evaluateNavigation —— 严格 scheme + 公网禁跳私网。
//   3. setWindowOpenHandler:一律 deny;仅 http(s) 交系统浏览器(openExternal)。
//
// 安全核心不变量(KTD6):agent 输出与第三方页面内容均不可信;公网 origin 不得自动
// 导航进私网/环回(SSRF 跳板)。

import { app, shell } from "electron";
import type { WebContents } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isAllowedDevPreviewHostname } from "@cortex-work/core/personal/devPreviewUrl";
import { isAuthorizedFileUrl } from "./localHtml";

// 内嵌浏览器专用会话分区(跨进程契约:渲染端 <webview partition> 与本常量必须一致)。
// persist: 前缀 = 持久化第三方登录态,配套「清除浏览数据」入口(见 partition.ts)。
export const BROWSER_PARTITION = "persist:browser-panel";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// 当前页 origin 是否为「公网」。私网/环回/.local 归为非公网;空/about:blank 视为
// 用户主动发起(地址栏输入或首次加载),按非公网处理放行后续判定。
function isPublicOrigin(currentOrigin: string | null | undefined): boolean {
  if (!currentOrigin) return false;
  const url = parseUrl(currentOrigin);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !isAllowedDevPreviewHostname(url.hostname);
}

export interface NavigationContext {
  targetUrl: string;
  // 触发导航时 webview 当前页的 URL;地址栏主动输入/首次加载传 null。
  currentOrigin?: string | null;
}

// 纯函数:判定一次导航/重定向/attach 是否放行。被 will-navigate / will-redirect /
// will-attach-webview 共用,亦可单测。
export function evaluateNavigation({ targetUrl, currentOrigin }: NavigationContext): boolean {
  const url = parseUrl(targetUrl);
  if (!url) return false;

  const fromPublic = isPublicOrigin(currentOrigin);

  if (url.protocol === "https:") {
    // 任意 https 放行;但公网页不得跳进私网/环回(SSRF 跳板)。
    if (fromPublic && isAllowedDevPreviewHostname(url.hostname)) return false;
    return true;
  }

  if (url.protocol === "http:") {
    // 明文 http 仅放行本地/私网(dev 预览);公网明文 http 一律拒。
    if (!isAllowedDevPreviewHostname(url.hostname)) return false;
    // 公网页不得跳进私网/环回。
    if (fromPublic) return false;
    return true;
  }

  if (url.protocol === "file:") {
    // file:// 仅放行**已授权**的本地 HTML(经 browser:resolveLocalHtml 校验在允许根内、
    // .html、realpath),其余 file:// 一律拒;公网页更不得跳 file://(SSRF/本地文件读取)。
    if (fromPublic) return false;
    return isAuthorizedFileUrl(url.toString());
  }

  // deny-by-default:javascript: / data: / blob: / about: / 自定义协议一律拒。
  return false;
}

// window.open / target=_blank 的目标若为 http(s) 则返回它(交系统浏览器),否则返回 null
// (既不导航也不外溢)。复用 fs.ts:shell:openExternal 的「仅 http/https」策略。
export function externalUrlForWindowOpen(value: string): string | null {
  const url = parseUrl(value);
  if (!url) return null;
  if (url.protocol === "http:" || url.protocol === "https:") return value;
  return null;
}

// 解析打包内**可信**标注 preload 的绝对路径(计划 KTD1)。__dirname 指向 out/main,
// preload 产物在 out/preload/annotation.js(electron-vite 双入口,dev 与 asar 同相对布局)。
// 文件不存在 → 返回 null(fail-closed:标注禁用而非开洞)。路径只从主进程可信值派生,绝不掺渲染端输入。
let cachedAnnotationPreload: string | null | undefined;
export function resolveAnnotationPreloadPath(): string | null {
  if (cachedAnnotationPreload !== undefined) return cachedAnnotationPreload;
  const candidate = join(__dirname, "../preload/annotation.js");
  cachedAnnotationPreload = existsSync(candidate) ? candidate : null;
  return cachedAnnotationPreload;
}

// 强制覆盖 webview 的安全相关 webPreferences,不信渲染端 attribute(防篡改绕过隔离)。
// deny-by-default:已知危险项一律清零/关闭,而非只覆盖常见几项(安全评审 P1-1)。
//
// preload 处理(计划 KTD1,唯一受控放行):先**无条件删除**渲染端声明的任意 preload(fail-closed),
// 再仅当主进程解析出可信标注 preload 绝对路径时强制覆盖为它——用于「页面元素标注」(隔离世界、
// 只读 DOM、只暴露 annotation:* 最小通道)。trustedPreload 为 null(文件缺失)时保持 preload 未设,
// 标注降级不可用,但隔离不被绕过。其余隔离项一字不变。
export function hardenWebviewPreferences(
  webPreferences: Record<string, unknown>,
  trustedPreload: string | null,
): void {
  delete webPreferences["preload"]; // 永不信任渲染端声明的 preload(fail-closed)
  if (trustedPreload) {
    webPreferences["preload"] = trustedPreload; // 强制为打包内可信标注 preload
  }
  delete webPreferences["enableBlinkFeatures"]; // 不放行实验性 Blink 能力
  delete webPreferences["experimentalFeatures"];
  webPreferences["nodeIntegration"] = false;
  webPreferences["nodeIntegrationInSubFrames"] = false;
  webPreferences["nodeIntegrationInWorker"] = false;
  webPreferences["webviewTag"] = false; // 禁止在不可信内容里再嵌套 webview
  webPreferences["contextIsolation"] = true;
  webPreferences["sandbox"] = true;
  webPreferences["webSecurity"] = true;
  webPreferences["allowRunningInsecureContent"] = false;
}

function attachWebviewNavigationGuards(contents: WebContents): void {
  contents.on("will-navigate", (event, navigationUrl) => {
    if (!evaluateNavigation({ targetUrl: navigationUrl, currentOrigin: contents.getURL() })) {
      event.preventDefault();
    }
  });
  // 服务端重定向同样要过闸门(否则公网页 30x 跳私网即绕过 will-navigate)。
  contents.on("will-redirect", (event, navigationUrl) => {
    if (!evaluateNavigation({ targetUrl: navigationUrl, currentOrigin: contents.getURL() })) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalUrlForWindowOpen(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
}

// 安装全局 webview 闸门。须在任何 webview 可能 attach 之前调用一次(app.whenReady 内、
// createWindow 之前)。
export function installBrowserWebviewGuards(): void {
  app.on("web-contents-created", (_event, contents) => {
    // 宿主 webContents 上挂 attach 闸门:webview 挂载时强制安全 prefs + 锁定 partition +
    // 校验初始 src。强制 partition 防渲染端把 webview 改挂到无 deny-by-default 防护的
    // session 上绕过 partition.ts 的权限/下载拦截(安全评审 P1-2,不信渲染端声明)。
    contents.on("will-attach-webview", (event, webPreferences, params) => {
      hardenWebviewPreferences(
        webPreferences as unknown as Record<string, unknown>,
        resolveAnnotationPreloadPath(),
      );
      (params as { partition?: string }).partition = BROWSER_PARTITION;
      const src = typeof params.src === "string" ? params.src : "";
      if (src && !evaluateNavigation({ targetUrl: src, currentOrigin: null })) {
        event.preventDefault();
      }
    });

    // webview 自身的 webContents 上挂导航/新窗口闸门。
    if (contents.getType() === "webview") {
      attachWebviewNavigationGuards(contents);
    }
  });
}
