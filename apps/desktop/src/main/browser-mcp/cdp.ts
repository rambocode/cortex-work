// CDP 层(U7,opt-in):网络观测 + 无障碍树。经 webContents.debugger attach guest,Network 域缓冲请求
// (敏感头脱敏),Accessibility 取全树。所有 sendCommand try-catch 兜底(DevTools 抢占致 detach 不崩);
// 仅 cdpEnabled 时 attach,否则 detach。CDP = Codex「完整 CDP·风险升高」对应面(R6/R7/R15)。
import type { WebContents } from "electron";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getPersistedState } from "../ipc/store";
import { getLiveGuest } from "./guest-registry";
import { asUntrustedPageContent } from "./sanitize";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// ── 敏感头脱敏(纯函数,可测)──────────────────────────────────────────────
// 防 Cookie / Authorization 等凭证经网络观测工具结果外泄给 agent。
const REDACT = new Set(["set-cookie", "cookie", "authorization", "proxy-authorization"]);
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = REDACT.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

// ── 网络缓冲 ────────────────────────────────────────────────────────────
interface NetEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
}
const NET_MAX = 200;
let netBuf: NetEntry[] = [];
let attachedTo: WebContents | null = null;

export function readNetwork(): NetEntry[] {
  return [...netBuf];
}

// 仅供测试重置。
export function __resetCdpState(): void {
  netBuf = [];
  attachedTo = null;
}

// 处理 CDP Network 事件(纯逻辑,可测):requestWillBeSent 建条目、responseReceived 补状态/响应头。
export function ingestCdpEvent(method: string, params: Record<string, unknown>): void {
  if (method === "Network.requestWillBeSent") {
    const req = params.request as { url?: string; method?: string; headers?: Record<string, string> } | undefined;
    if (req?.url) {
      netBuf.push({
        requestId: String(params.requestId),
        url: req.url,
        method: req.method ?? "GET",
        requestHeaders: redactHeaders(req.headers),
      });
      if (netBuf.length > NET_MAX) netBuf.shift();
    }
  } else if (method === "Network.responseReceived") {
    const resp = params.response as { status?: number; headers?: Record<string, string> } | undefined;
    const e = netBuf.find((x) => x.requestId === String(params.requestId));
    if (e && resp) {
      e.status = resp.status;
      e.responseHeaders = redactHeaders(resp.headers);
    }
  }
}

// ── attach / detach(运行时,debugger)──────────────────────────────────────
function isAttached(wc: WebContents): boolean {
  return attachedTo === wc && !wc.isDestroyed() && wc.debugger.isAttached();
}

// attach + Network.enable。已 attach → true;DevTools 占用等失败 → false。
export function attachCdp(wc: WebContents): boolean {
  if (isAttached(wc)) return true;
  try {
    wc.debugger.attach("1.3");
  } catch {
    return false; // 多为 DevTools 已占用调试器
  }
  attachedTo = wc;
  netBuf = [];
  wc.debugger.on("detach", () => {
    if (attachedTo === wc) attachedTo = null; // DevTools 抢占/手动 detach → 标记不可用
  });
  wc.debugger.on("message", (_e, m, p) => {
    try {
      ingestCdpEvent(m, (p ?? {}) as Record<string, unknown>);
    } catch {
      /* 忽略畸形事件 */
    }
  });
  void wc.debugger.sendCommand("Network.enable").catch(() => {});
  return true;
}

export function detachCdp(): void {
  const wc = attachedTo;
  attachedTo = null;
  netBuf = [];
  if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
    try {
      wc.debugger.detach();
    } catch {
      /* 忽略 */
    }
  }
}

async function cdpEnabled(): Promise<boolean> {
  try {
    return (await getPersistedState()).generalSettings?.browserControl?.cdpEnabled === true;
  } catch {
    return false;
  }
}

// 确保 CDP 就绪:cdpEnabled 才 attach;关则 detach。返回就绪与否的提示文本(null = 就绪)。
async function ensureCdp(): Promise<string | null> {
  if (!(await cdpEnabled())) {
    detachCdp();
    return "需先在「设置 → 浏览器控制」开启「完整 CDP」(风险升高)。";
  }
  const guest = getLiveGuest();
  if (!guest) return "无可控浏览器面板。";
  if (!attachCdp(guest)) return "无法 attach CDP(可能 DevTools 正占用调试器,关闭后重试)。";
  return null;
}

// 注册 CDP 工具(由 registerBrowserTools 调用,与默认层工具同 server)。
export function registerCdpTools(mcp: McpServer): void {
  mcp.registerTool(
    "browser_network",
    { description: "观测页面网络请求(需开启完整 CDP;敏感头已脱敏)。", inputSchema: {} },
    async () => {
      const blocked = await ensureCdp();
      if (blocked) return text(blocked);
      const lines = readNetwork()
        .map((e) => `${e.method} ${e.status ?? "-"} ${e.url}`)
        .join("\n");
      return text(asUntrustedPageContent("网络", lines || "(暂无捕获;导航或刷新页面后再试)"));
    },
  );

  mcp.registerTool(
    "browser_accessibility",
    { description: "读取页面无障碍树(需开启完整 CDP)。", inputSchema: {} },
    async () => {
      const blocked = await ensureCdp();
      if (blocked) return text(blocked);
      const guest = getLiveGuest();
      if (!guest) return text("无可控浏览器面板。");
      try {
        await guest.debugger.sendCommand("Accessibility.enable");
        const res = (await guest.debugger.sendCommand("Accessibility.getFullAXTree")) as { nodes?: unknown[] };
        return text(asUntrustedPageContent("无障碍树", JSON.stringify(res.nodes ?? [])));
      } catch (e) {
        return text(`读取无障碍树失败(${String(e)})。`);
      }
    },
  );
}
