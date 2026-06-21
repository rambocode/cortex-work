// 右栏内嵌浏览器面板。移植自参考仓库 Kun(DevBrowserPanel),但:
//   - 内容承载:Electron 用 <webview>(渲染进程 DOM,为未来「页面标注 → 发给 agent →
//     可视化编辑」铺路,见计划 KTD1);Web 端回退 <iframe>。靠 navigator.userAgent +
//     bridge 是否可用做环境探测,**不 import 任何 Electron 模块**(契合 views 平台无关边界)。
//   - 地址栏放宽 allow-list:支持任意 https 公网站点(Kun 只服务本地预览)。安全靠主进程
//     webviewGuards 三道闸门兜底(见 apps/desktop/src/main/browser/webviewGuards.ts)。
//   - 外链/清除数据走注入的 DesktopBridge(openExternal / browserClearData),不碰 window。
//
// webview 的导航/历史/状态全在渲染端用 webview 元素 API + 事件处理(计划 KTD5),
// 主进程不参与(除安全闸门),故无 bounds-sync IPC。

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { normalizeDevPreviewUrlInput } from "@cortex-work/core/personal/devPreviewUrl";
import { BrowserErrorState } from "./BrowserErrorState";

// 跨进程契约:须与主进程 webviewGuards.ts 的 BROWSER_PARTITION 一致(主进程会强制覆盖,
// 此处声明仅为正确性 + 可读性)。
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

// 从 URL 取 host(含端口);取不到时回退原串。错误页展示与 errorCode→建议映射都用 host。
function hostOf(url: string): string {
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

export function BrowserView({ onToast }: { onToast?: (text: string) => void }) {
  const { t } = useTranslation("browser");
  const bridge = useDesktopBridge();
  // 监听「在浏览器打开」请求(卡片点击 / auto_open)。nonce 变化即(重新)加载。
  const browserUrlRequest = usePersonalStore((s) => s.browserUrlRequest);

  const useElectronWebview = canUseElectronWebviewEnvironment({
    bridgeAvailable: typeof bridge?.openExternal === "function",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
  });

  const webviewRef = useRef<WebviewTag | null>(null);
  const iframeLoadedUrlRef = useRef<string | null>(null);
  // 从 0 起,而非挂载时的 nonce:面板常是被本次请求打开的(挂载时 browserUrlRequest.nonce 已是
  // 新值),若用它初始化会把「触发打开的那次请求」误判为已消费 → 首次点击空白、需再点一次。
  // 从 0 起则挂载即消费当前 pending 请求(修首次点击空白)。
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

  // 消费 browserUrlRequest(卡片/auto_open)。
  useEffect(() => {
    if (!browserUrlRequest) return;
    if (browserUrlRequest.nonce === lastRequestNonceRef.current) return;
    lastRequestNonceRef.current = browserUrlRequest.nonce;
    loadUrl(browserUrlRequest.url);
  }, [browserUrlRequest, loadUrl]);

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
    const onStart = (): void => {
      setLoading(true);
      setPageError(null);
    };
    const onStop = (): void => {
      setLoading(false);
      syncNav();
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
      // 捕获 errorCode + validatedURL(比 activeUrl 准),供整页错误态映射中文原因(计划 KTD3)。
      setPageError({
        code: fail.errorCode,
        description: fail.errorDescription || null,
        url: fail.validatedURL || activeUrl,
      });
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
  }, [activeUrl, instanceNonce, useElectronWebview]);

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

  return (
    <div className="pw-browser">
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
      </div>
    </div>
  );
}
