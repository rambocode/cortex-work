// webview 加载失败的 errorCode → 错误原因/排查建议的 i18n key 映射(计划 KTD3)。
// 纯函数、零依赖(无 Electron / DOM),便于单测;渲染端 BrowserErrorState 按返回的 key
// 在 browser 命名空间下取文案。errorCode 取自 webview `did-fail-load` 的 Chromium
// net error code(负整数,见 net/base/net_error_list.h)。

export interface BrowserErrorInfo {
  /** browser.error.reason.* 的 key */
  reasonKey: string;
  /** browser.error.hint.* 的 key 列表(按展示顺序) */
  hintKeys: string[];
}

// host 为环回/私网时,本面板的主用途是预览 agent 起的本地 dev server,
// 故「连接被拒」优先给 dev-server 专属建议而非通用「检查网络」(避免无价值填充)。
function isLoopbackOrPrivateHost(host: string | undefined): boolean {
  if (!host) return false;
  // 去掉端口,取纯 hostname。
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  // RFC1918 私网段。
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

export function describeBrowserError(errorCode: number, host?: string): BrowserErrorInfo {
  switch (errorCode) {
    case -105: // ERR_NAME_NOT_RESOLVED
      return { reasonKey: "error.reason.dns", hintKeys: ["error.hint.checkUrl", "error.hint.checkNetwork"] };
    case -102: // ERR_CONNECTION_REFUSED
      return isLoopbackOrPrivateHost(host)
        ? { reasonKey: "error.reason.refusedDev", hintKeys: ["error.hint.devServer"] }
        : { reasonKey: "error.reason.refused", hintKeys: ["error.hint.checkNetwork", "error.hint.retryLater"] };
    case -7: // ERR_TIMED_OUT
    case -118: // ERR_CONNECTION_TIMED_OUT
      return { reasonKey: "error.reason.timeout", hintKeys: ["error.hint.checkNetwork", "error.hint.retryLater"] };
    case -106: // ERR_INTERNET_DISCONNECTED
      return { reasonKey: "error.reason.offline", hintKeys: ["error.hint.checkNetwork"] };
    case -200: // ERR_CERT_COMMON_NAME_INVALID
    case -201: // ERR_CERT_DATE_INVALID
    case -202: // ERR_CERT_AUTHORITY_INVALID
      return { reasonKey: "error.reason.cert", hintKeys: ["error.hint.checkProxy"] };
    default:
      return {
        reasonKey: "error.reason.unknown",
        hintKeys: ["error.hint.checkNetwork", "error.hint.checkProxy"],
      };
  }
}
