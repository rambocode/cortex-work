// 本地 dev 预览 URL 的归一化与 allow-list 判定。移植自参考仓库 Kun
// (src/shared/dev-preview-url.ts),纯 TS、无平台依赖,故同时被:
//   - 渲染端探测(devPreviewDetection.ts / DevPreviewCard)
//   - 主进程 webview 导航闸门(apps/desktop/src/main/browser/webviewGuards.ts)
// 引用 —— 单点真相,避免两端规则漂移(见计划 KTD3/KTD5)。
//
// 两档白名单刻意分离(见计划 KTD4):
//   - isAllowedDevPreviewHostname:card 展示用,本地 + 私网全集。
//   - isLoopbackOnly:auto_open 自动打开用,仅环回地址。auto_open 无需用户点击即
//     加载,是 SSRF 攻击面 —— 收紧到环回,剔除 169.254(云 metadata)/私网段/
//     host.docker.internal,防被污染的 agent 输出诱导面板代为请求内网。

export const DEFAULT_DEV_PREVIEW_URL = "http://127.0.0.1:5173/";

function stripIpv6Brackets(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

// 返回定长四元组,便于下游解构在严格 noUncheckedIndexedAccess 下不报 undefined。
function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

// 环回地址判定 —— auto_open 的唯一放行集(KTD4)。
export function isLoopbackOnly(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return true;
  }
  const octets = parseIpv4(host);
  if (!octets) return false;
  return octets[0] === 127;
}

// card 展示用的本地/私网全集(含 169.254、私网段、host.docker.internal)。
export function isAllowedDevPreviewHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "host.docker.internal" ||
    host.endsWith(".local") ||
    host === "::1"
  ) {
    return true;
  }

  const octets = parseIpv4(host);
  if (!octets) return false;

  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

// 把用户/探测得到的输入归一化为合法本地预览 URL;非本地/非法返回 null。
// - 纯端口号(如 "5173") → http://127.0.0.1:5173
// - 缺 scheme → 补 http://
// - 0.0.0.0 / :: 监听地址 → 归一为 127.0.0.1
export function normalizeDevPreviewUrlInput(input: string): string | null {
  let value = input.trim();
  if (!value) return null;

  if (/^\d{2,5}$/.test(value)) {
    value = `http://127.0.0.1:${value}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = stripIpv6Brackets(url.hostname);
  if (host === "0.0.0.0" || host === "::") {
    url.hostname = "127.0.0.1";
  }

  if (!isAllowedDevPreviewHostname(url.hostname)) return null;
  if (!url.pathname) url.pathname = "/";
  return url.toString();
}

export function isAllowedDevPreviewUrl(value: string): boolean {
  return normalizeDevPreviewUrlInput(value) !== null;
}

// 归一化后的 URL 是否为环回地址(供 auto_open 二次过滤)。
export function isLoopbackDevPreviewUrl(value: string): boolean {
  const normalized = normalizeDevPreviewUrlInput(value);
  if (!normalized) return false;
  try {
    return isLoopbackOnly(new URL(normalized).hostname);
  } catch {
    return false;
  }
}
