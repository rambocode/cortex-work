// 单个「标签页」的完整浏览面板(工具栏 + 内容区),由多标签壳 BrowserView 按标签渲染 N 份。
// 每个标签页自持全部浏览状态(地址栏草稿、历史、加载/错误态、标注),非活跃标签仅以
// visibility 隐藏(不卸载)——webview 保持存活,切回标签即恢复现场;不能用 display:none,
// Electron <webview> 在 display:none 下会进入异常状态(官方已知限制)。
//
// 原为单实例 BrowserView(移植自参考仓库 Kun 的 DevBrowserPanel),要点保留:
//   - 内容承载:Electron 用 <webview>(渲染进程 DOM,为「页面标注 → 发给 agent →
//     可视化编辑」铺路,见计划 KTD1);Web 端回退 <iframe>。靠 navigator.userAgent +
//     bridge 是否可用做环境探测,**不 import 任何 Electron 模块**(契合 views 平台无关边界)。
//   - 地址栏放宽 allow-list:支持任意 https 公网站点。安全靠主进程 webviewGuards
//     三道闸门兜底(见 apps/desktop/src/main/browser/webviewGuards.ts)。
//   - 外链/清除数据走注入的 DesktopBridge(openExternal / browserClearData),不碰 window。
//
// webview 的导航/历史/状态全在渲染端用 webview 元素 API + 事件处理(计划 KTD5),
// 主进程不参与(除安全闸门),故无 bounds-sync IPC。

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { normalizeDevPreviewUrlInput } from "@cortex-work/core/personal/devPreviewUrl";
import { describeBrowserError } from "@cortex-work/core/personal/browserErrorInfo";
import { BrowserErrorState } from "./BrowserErrorState";
import { buildErrorPageScript } from "./browserErrorPage";
import { useBrowserCapture } from "./useBrowserCapture";
import { useBrowserAnnotations, type AnnotatableWebview } from "./useBrowserAnnotations";
import { BrowserAnnotator } from "./BrowserAnnotator";

// 跨进程契约:须与主进程 webviewGuards.ts 的 BROWSER_PARTITION 一致(主进程会强制覆盖,
// 此处声明仅为正确性 + 可读性)。所有标签页共用同一 partition(同一份 cookie/存储)。
const BROWSER_PARTITION = "persist:browser-panel";
const IFRAME_LOAD_TIMEOUT_MS = 10_000;
const NAV_STACK_LIMIT = 30;

// Electron <webview> 元素的命令式导航 API(运行期由 Electron 提供)。
type WebviewTag = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  // 截图当前可视区 → NativeImage(计划 U3)。返回对象只用到 toPNG/isEmpty。
  capturePage(): Promise<{ toPNG(): Uint8Array; isEmpty(): boolean }>;
  // 宿主 → webview preload 的点对点消息(标注 enable/disable,计划 U5)。
  send(channel: string, ...args: unknown[]): void;
  // 在 webview 页面上下文执行脚本(用于失败时把自定义错误页注入页面 DOM,计划 U2-B)。
  executeJavaScript(code: string): Promise<unknown>;
};

type WebviewNavigateEvent = Event & { url: string };
type WebviewFailLoadEvent = Event & {
  errorCode: number;
  errorDescription: string;
  isMainFrame: boolean;
  validatedURL?: string;
};
type WebviewTitleEvent = Event & { title: string };

// 整页加载失败的结构化错误(计划 U2/KTD3)。code 为 null 表示 iframe 回退(同源策略拿不到错误码)。
type PageError = { code: number | null; description: string | null; url: string };

// 多标签壳 → 标签页的加载请求(nonce 变化即(重新)加载该 URL)。
export type PaneLoadRequest = { nonce: number; url: string };

// 标签页 → 多标签壳的元信息上报(标签条展示标题/URL 用)。
export type PaneMeta = { title: string; url: string | null };

// 从 URL 取 host(含端口);取不到时回退原串。错误页展示与标签条标题回退都用 host。
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// 环境探测:Electron 下(bridge 可用 + UA 含 Electron/)用 <webview>,否则 iframe 回退。
export function canUseElectronWebviewEnvironment(input: {
  bridgeAvailable: boolean;
  userAgent: string;
}): boolean {
  return input.bridgeAvailable && /\bElectron\//.test(input.userAgent);
}

// 地址栏回显:host + path(根路径省略)+ query/hash。
function formatAddressInput(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

// 地址栏输入归一化:本地输入走 dev 预览归一化(localhost:5173 → http://...);否则当公网,
// 缺 scheme 补 https://。file:// 直接透传(本地 HTML 预览),实际是否放行由主进程授权闸门把关
// (webviewGuards 只放行已授权的 file://),故此处透传安全。
function normalizeAddressInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  const local = normalizeDevPreviewUrlInput(trimmed);
  if (local) return local;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

// 单标签页浏览面板。id 只用于向壳回传元信息;active=false 时整面板隐藏但保持挂载。
export function BrowserTabPane({
  id,
  active,
  onToast,
  loadRequest,
  onMeta,
}: {
  id: number;
  active: boolean;
  onToast?: (text: string) => void;
  // 壳路由给本标签的加载请求(打开卡片/auto_open/新标签初始 URL);null 表示暂无。
  loadRequest: PaneLoadRequest | null;
  // 稳定回调(壳侧 useCallback):上报标题/URL 变化,壳据此刷新标签条文案。
  onMeta: (id: number, meta: PaneMeta) => void;
}) {
  const { t } = useTranslation("browser");
  const bridge = useDesktopBridge();

  const useElectronWebview = canUseElectronWebviewEnvironment({
    bridgeAvailable: typeof bridge?.openExternal === "function",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
  });

  const webviewRef = useRef<WebviewTag | null>(null);
  const iframeLoadedUrlRef = useRef<string | null>(null);
  // 暂存本次 webview 加载失败信息:did-fail-load 记录,待 did-stop-loading(错误页 DOM 就绪)
  // 再注入自定义错误页(计划 U2-B)。注入失败则回退宿主浮层(pageError)。
  const failedInfoRef = useRef<PageError | null>(null);
  // 从 0 起,而非挂载时的请求 nonce:标签页常是被本次请求创建/打开的(挂载时 loadRequest
  // 已带新 nonce),若用它初始化会把「触发打开的那次请求」误判为已消费 → 首次点击空白。
  // 从 0 起则挂载即消费当前 pending 请求。
  const lastRequestNonceRef = useRef<number>(0);

  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [loading, setLoading] = useState(false);
  // loadError:地址栏输入校验的细条提示(瞬态);pageError:整页加载失败错误态(计划 U2)。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<PageError | null>(null);
  const [pageTitle, setPageTitle] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [iframeBackStack, setIframeBackStack] = useState<string[]>([]);
  const [iframeForwardStack, setIframeForwardStack] = useState<string[]>([]);
  const [iframeReloadNonce, setIframeReloadNonce] = useState(0);
  const [instanceNonce, setInstanceNonce] = useState(0);

  const canNavigateBack = useElectronWebview ? canGoBack : iframeBackStack.length > 0;
  const canNavigateForward = useElectronWebview ? canGoForward : iframeForwardStack.length > 0;

  const loadUrl = useCallback(
    (value: string) => {
      const normalized = normalizeAddressInput(value);
      if (!normalized) {
        setLoadError(t("address.invalid"));
        return;
      }
      setLoadError(null);
      setPageError(null);
      setPageTitle("");
      setDraftUrl(formatAddressInput(normalized));
      setActiveUrl((prev) => {
        // iframe 模式:手动维护前进/后退栈(iframe 读不到真实历史)。
        if (!useElectronWebview && prev && normalized !== prev) {
          setIframeBackStack((stack) => [...stack, prev].slice(-NAV_STACK_LIMIT));
          setIframeForwardStack([]);
        }
        return normalized;
      });
      setLoading(true);
    },
    [t, useElectronWebview],
  );

  // 消费壳路由来的加载请求(打开卡片/auto_open → 活跃标签)。
  useEffect(() => {
    if (!loadRequest) return;
    if (loadRequest.nonce === lastRequestNonceRef.current) return;
    lastRequestNonceRef.current = loadRequest.nonce;
    loadUrl(loadRequest.url);
  }, [loadRequest, loadUrl]);

  // 标题/URL 变化上报壳(标签条文案)。onMeta 为壳侧稳定回调,不会造成 effect 抖动。
  useEffect(() => {
    onMeta(id, { title: pageTitle, url: activeUrl });
  }, [id, onMeta, pageTitle, activeUrl]);

  // webview 事件:驱动地址栏、按钮态、loading、错误。
  useEffect(() => {
    const webview = webviewRef.current;
    if (!useElectronWebview || !activeUrl || !webview) return;

    const syncNav = (): void => {
      try {
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
        const current = webview.getURL();
        if (current) setDraftUrl(formatAddressInput(current));
      } catch {
        /* webview 尚未 attach */
      }
    };
    // 把自定义错误页注入 webview 失败页 DOM(计划 U2-B):截图/标注得以作用于这张错误页。
    // 注入被拒(如特权错误页禁注入)→ 回退宿主浮层 pageError。
    const injectErrorPage = (info: PageError): void => {
      const host = hostOf(info.url);
      const desc = describeBrowserError(info.code ?? 0, host);
      const script = buildErrorPageScript({
        title: t("error.title"),
        reason: t(desc.reasonKey, { host }),
        hints: desc.hintKeys.map((k) => t(k)),
        codeLabel: t("error.code"),
        code: info.description,
        reloadLabel: t("error.reload"),
        openLabel: t("error.openExternal"),
        url: info.url,
      });
      webview.executeJavaScript(script).then(
        (ok) => {
          if (!ok) setPageError(info);
        },
        () => setPageError(info),
      );
    };

    const onStart = (): void => {
      setLoading(true);
      setPageError(null);
      failedInfoRef.current = null;
    };
    const onStop = (): void => {
      setLoading(false);
      syncNav();
      // did-stop-loading:错误页 DOM 已就绪,此时注入自定义错误页(单次,读后即清)。
      if (failedInfoRef.current) {
        const info = failedInfoRef.current;
        failedInfoRef.current = null;
        injectErrorPage(info);
      }
    };
    const onNavigate: EventListener = (event): void => {
      const url = (event as WebviewNavigateEvent).url;
      if (url) setDraftUrl(formatAddressInput(url));
      setPageError(null);
      syncNav();
    };
    const onFail: EventListener = (event): void => {
      const fail = event as WebviewFailLoadEvent;
      // -3 ERR_ABORTED 是用户/代码主动停止,不当错误。
      if (!fail.isMainFrame || fail.errorCode === -3) return;
      setLoading(false);
      // 捕获 errorCode + validatedURL(比 activeUrl 准),待 onStop 注入错误页(计划 KTD3/U2-B)。
      failedInfoRef.current = {
        code: fail.errorCode,
        description: fail.errorDescription || null,
        url: fail.validatedURL || activeUrl,
      };
      syncNav();
    };
    const onTitle: EventListener = (event): void => {
      setPageTitle((event as WebviewTitleEvent).title);
    };

    webview.addEventListener("did-start-loading", onStart);
    webview.addEventListener("did-stop-loading", onStop);
    webview.addEventListener("did-navigate", onNavigate);
    webview.addEventListener("did-navigate-in-page", onNavigate);
    webview.addEventListener("did-fail-load", onFail);
    webview.addEventListener("page-title-updated", onTitle);
    // 首帧补偿:若 did-stop-loading 在监听注册前已触发,主动同步一次按钮态/地址(正确性评审)。
    syncNav();
    return () => {
      webview.removeEventListener("did-start-loading", onStart);
      webview.removeEventListener("did-stop-loading", onStop);
      webview.removeEventListener("did-navigate", onNavigate);
      webview.removeEventListener("did-navigate-in-page", onNavigate);
      webview.removeEventListener("did-fail-load", onFail);
      webview.removeEventListener("page-title-updated", onTitle);
    };
  }, [activeUrl, instanceNonce, useElectronWebview, t]);

  // iframe 模式:无导航事件,用 10s 超时兜底失败态。
  useEffect(() => {
    if (useElectronWebview || !activeUrl) return;
    iframeLoadedUrlRef.current = null;
    setLoading(true);
    setPageError(null);
    const failedUrl = activeUrl;
    const timer = window.setTimeout(() => {
      if (iframeLoadedUrlRef.current === failedUrl) return;
      setLoading(false);
      // iframe 同源策略拿不到 errorCode → code:null,错误态降级为「被拒绝嵌入」通用文案。
      setPageError({ code: null, description: null, url: failedUrl });
    }, IFRAME_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [activeUrl, iframeReloadNonce, useElectronWebview]);

  const submitUrl = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    loadUrl(draftUrl);
  };

  const reload = (): void => {
    if (!activeUrl) return;
    setLoading(true);
    setPageError(null);
    if (!useElectronWebview) {
      iframeLoadedUrlRef.current = null;
      setIframeReloadNonce((n) => n + 1);
      return;
    }
    try {
      webviewRef.current?.reload();
    } catch {
      setInstanceNonce((n) => n + 1);
    }
  };

  const stop = (): void => {
    setLoading(false);
    if (useElectronWebview) {
      try {
        webviewRef.current?.stop();
      } catch {
        /* ignore */
      }
    }
  };

  const goBack = (): void => {
    if (!activeUrl) return;
    if (!useElectronWebview) {
      const prev = iframeBackStack.at(-1);
      if (!prev) return;
      setIframeBackStack((s) => s.slice(0, -1));
      setIframeForwardStack((s) => [activeUrl, ...s].slice(0, NAV_STACK_LIMIT));
      setActiveUrl(prev);
      setDraftUrl(formatAddressInput(prev));
      setLoading(true);
      // 回到与历史项相同的 URL 字符串时,iframe key 含 reloadNonce 才会变 → 重挂触发 onLoad,
      // 否则 loading 卡到超时误报失败(正确性评审)。
      setIframeReloadNonce((n) => n + 1);
      return;
    }
    try {
      if (webviewRef.current?.canGoBack()) webviewRef.current.goBack();
    } catch {
      /* ignore */
    }
  };

  const goForward = (): void => {
    if (!activeUrl) return;
    if (!useElectronWebview) {
      const next = iframeForwardStack[0];
      if (!next) return;
      setIframeForwardStack((s) => s.slice(1));
      setIframeBackStack((s) => [...s, activeUrl].slice(-NAV_STACK_LIMIT));
      setActiveUrl(next);
      setDraftUrl(formatAddressInput(next));
      setLoading(true);
      setIframeReloadNonce((n) => n + 1);
      return;
    }
    try {
      if (webviewRef.current?.canGoForward()) webviewRef.current.goForward();
    } catch {
      /* ignore */
    }
  };

  const openExternal = (): void => {
    if (!activeUrl) return;
    if (bridge?.openExternal) {
      void bridge.openExternal(activeUrl).catch(() => undefined);
    } else if (typeof window !== "undefined") {
      window.open(activeUrl, "_blank", "noopener,noreferrer");
    }
  };

  const clearData = (): void => {
    void bridge?.browserClearData?.().then(
      () => onToast?.(t("clearData.ok")),
      () => onToast?.(t("clearData.fail")),
    );
  };

  const { capture, capturing } = useBrowserCapture(bridge);
  const takeScreenshot = (): void => {
    void capture(webviewRef.current).then((result) => {
      if (result === "ok") onToast?.(t("screenshot.ok"));
      else if (result === "empty") onToast?.(t("screenshot.emptyImage"));
      else onToast?.(t("screenshot.fail"));
    });
  };

  // 页面元素标注(计划 U5)。preload 在页面内画高亮/编号徽标/评论框;宿主收集纯数据 + 批量发送。
  const annotation = useBrowserAnnotations({
    webviewRef: webviewRef as RefObject<AnnotatableWebview | null>,
    useElectronWebview,
    activeUrl,
    instanceNonce,
    onToast,
  });

  return (
    <div className={`pw-browser-pane${active ? " is-active" : ""}`}>
      <form className="pw-browser-bar" onSubmit={submitUrl}>
        <div className="pw-browser-nav">
          <button
            type="button"
            className="pw-icon-btn"
            onClick={goBack}
            disabled={!canNavigateBack}
            title={t("nav.back")}
            aria-label={t("nav.back")}
          >
            <Icon.Back size={15} />
          </button>
          <button
            type="button"
            className="pw-icon-btn"
            onClick={goForward}
            disabled={!canNavigateForward}
            title={t("nav.forward")}
            aria-label={t("nav.forward")}
          >
            <Icon.Fwd size={15} />
          </button>
          <button
            type="button"
            className={`pw-icon-btn ${loading ? "is-loading" : ""}`}
            onClick={loading ? stop : reload}
            disabled={!activeUrl}
            title={loading ? t("nav.stop") : t("nav.reload")}
            aria-label={loading ? t("nav.stop") : t("nav.reload")}
          >
            {loading ? <Icon.Stop size={14} /> : <Icon.Retry size={15} />}
          </button>
        </div>
        <div className="pw-browser-address">
          <Icon.Globe size={14} />
          <input
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder={t("address.placeholder")}
            spellCheck={false}
            aria-label={t("address.label")}
          />
        </div>
        <div className="pw-browser-actions">
          {/* 截图/标注仅 Electron <webview> 支持(iframe 无 capturePage / 无法注入 preload),Web 端不渲染 */}
          {useElectronWebview ? (
            <>
              {/* 截图/标注在错误态(pageError)下仍保留可用:用户可对错误页截图反馈、标注(用户要求)。
                 仅在无 URL / 加载中 / 截图中时禁用。 */}
              <button
                type="button"
                className="pw-icon-btn"
                onClick={takeScreenshot}
                disabled={!activeUrl || loading || capturing}
                title={t("nav.screenshot")}
                aria-label={t("nav.screenshot")}
              >
                <Icon.Camera size={15} />
              </button>
              <button
                type="button"
                className={`pw-icon-btn ${annotation.enabled ? "is-active" : ""}`}
                onClick={annotation.toggle}
                disabled={!activeUrl}
                title={t("nav.annotate")}
                aria-label={t("nav.annotate")}
                aria-pressed={annotation.enabled}
              >
                <Icon.Comment size={15} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="pw-icon-btn"
            onClick={openExternal}
            disabled={!activeUrl}
            title={t("nav.openExternal")}
            aria-label={t("nav.openExternal")}
          >
            <Icon.Share size={15} />
          </button>
          <button
            type="button"
            className="pw-icon-btn"
            onClick={clearData}
            title={t("nav.clearData")}
            aria-label={t("nav.clearData")}
          >
            <Icon.Trash size={15} />
          </button>
        </div>
      </form>

      {loadError ? <div className="pw-browser-error">{loadError}</div> : null}

      <div className="pw-browser-stage">
        {!activeUrl ? (
          <div className="pw-browser-empty">
            <Icon.Globe size={40} />
            <div className="pw-browser-empty-title">{t("empty.title")}</div>
            <div className="pw-browser-empty-sub">{t("empty.sub")}</div>
          </div>
        ) : useElectronWebview ? (
          // 用 createElement 渲染 <webview>:避开 JSX 内建元素类型缺失,且 ref 直挂。
          createElement("webview", {
            key: `webview:${instanceNonce}`,
            ref: webviewRef as unknown as React.Ref<HTMLElement>,
            src: activeUrl,
            partition: BROWSER_PARTITION,
            webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
            allowpopups: "false",
            className: "pw-browser-frame",
          })
        ) : (
          <iframe
            key={`iframe:${instanceNonce}:${activeUrl}:${iframeReloadNonce}`}
            src={activeUrl}
            title={pageTitle || t("empty.title")}
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => {
              iframeLoadedUrlRef.current = activeUrl;
              setLoading(false);
              setPageError(null);
            }}
            className="pw-browser-frame"
          />
        )}
        {pageError ? (
          <BrowserErrorState
            host={hostOf(pageError.url)}
            errorCode={pageError.code}
            errorDescription={pageError.description}
            onReload={reload}
            onOpenExternal={openExternal}
          />
        ) : null}
        {annotation.enabled ? (
          <BrowserAnnotator
            count={annotation.count}
            onSendChat={annotation.sendToChat}
            onSendTerminal={annotation.sendToTerminal}
          />
        ) : null}
      </div>
    </div>
  );
}
