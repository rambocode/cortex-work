// 从 agent 会话消息中探测「本地 dev 预览 URL」。移植自参考仓库 Kun
// (src/renderer/src/lib/dev-preview-detection.ts),但**输入层按 cortex 真实
// 消息模型重写**(见计划 KTD3):
//   - Kun 的 ChatBlock 有 summary/detail/meta.command —— cortex 没有。
//   - cortex 的 agentLog = { title, items: {ic, text: RichText}[] };正文 = text: RichText。
//   - dev-server 的 stdout 不进消息流(适配器只归一化工具入参且截断 80/100 字符),
//     故 DEV_SERVER_OUTPUT_RE 主要靠 agent 在正文里复述 URL 时命中,命中率预期偏低。
//
// 两种模式(KTD4):
//   - card:    探测到本地/私网 URL → 展「打开预览」卡片,需用户点击才加载。
//   - auto_open:输出明确像 dev server 时自动打开,**仅环回地址**(isLoopbackDevPreviewUrl
//              二次过滤),防被污染输出诱导自动请求内网(SSRF)。

import type { Message, RichText } from "../types";
import {
  isLoopbackDevPreviewUrl,
  normalizeDevPreviewUrlInput,
} from "./devPreviewUrl";

const MAX_DETECTED_URLS = 4;
const NEARBY_URL_CONTEXT_CHARS = 120;

const LOCAL_URL_CANDIDATE_RE =
  /\b(?:https?:\/\/)?(?:localhost|(?:[\w-]+\.)?localhost|host\.docker\.internal|[\w.-]+\.local|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/gi;
const DEV_SERVER_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)|vite(?:\s|$)|next\s+dev|nuxt\s+dev|astro\s+dev|remix\s+dev|webpack(?:-dev-server|\s+serve)|react-scripts\s+start|storybook(?:\s+dev)?|svelte-kit\s+dev)\b/i;
const DEV_SERVER_OUTPUT_RE =
  /\b(?:vite v?\d|local:\s*https?:\/\/|network:\s*https?:\/\/|ready in \d+(?:\.\d+)?\s*(?:ms|s)|ready on\s+https?:\/\/|started server|server started|compiled successfully|webpack compiled|app running at|serving at|listening on\s+https?:\/\/)\b/i;
const DEV_PREVIEW_ACTION_RE =
  /\b(?:open|visit|browse|view|check(?:\s+it)?\s+out|go\s+to)\b|(?:打开|访问|前往|查看)/i;
const DEV_PREVIEW_STATUS_RE =
  /\b(?:served|serving|running|started|available|reachable|live\s+at|running\s+at|available\s+at|listening\s+on|app\s+running\s+at|serving\s+at)\b|(?:运行在|启动于|已启动|可访问|可预览|本地服务)/i;
const NON_PREVIEW_CONTEXT_RE =
  /\b(?:runtime|runtime:request|health check|bearer token|sse|threads?)\b|\/(?:health|v\d+\/|metrics|readyz?|livez?)(?:\b|\/|\?)/i;

type DevPreviewExtractionMode = "card" | "auto_open";

// RichText(string | {kind:"rich",parts}) → 纯文本。
function flattenRichText(text: RichText): string {
  if (typeof text === "string") return text;
  return text.parts.map((p) => p.v).join("");
}

// 把一条消息归一为可扫描文本。cortex 的探测真实数据源(KTD3):
//   - text 正文(主信号)
//   - agentLog 的 title + items[].text(工具入参,次信号)
// 其余 kind(day/diff/approve/typing/reasoning)对 dev 预览无意义,返回空串。
function textFromMessage(message: Message): string {
  if (message.kind === "text") return flattenRichText(message.text);
  if (message.kind === "agentLog") {
    return [message.title, ...message.items.map((it) => flattenRichText(it.text))]
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function trimUrlCandidate(candidate: string): string {
  return candidate.replace(/[`),.;]+$/g, "");
}

function surroundingUrlContext(text: string, matchIndex: number, matchLength: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, matchIndex - 1));
  const lineEnd = text.indexOf("\n", matchIndex + matchLength);
  const nearestLine = text.slice(
    lineStart === -1 ? 0 : lineStart + 1,
    lineEnd === -1 ? text.length : lineEnd,
  );
  if (nearestLine.length <= NEARBY_URL_CONTEXT_CHARS * 2) return nearestLine;

  const start = Math.max(0, matchIndex - NEARBY_URL_CONTEXT_CHARS);
  const end = Math.min(text.length, matchIndex + matchLength + NEARBY_URL_CONTEXT_CHARS);
  return text.slice(start, end);
}

function contextCanShowPreview(text: string): boolean {
  return DEV_PREVIEW_ACTION_RE.test(text) || DEV_PREVIEW_STATUS_RE.test(text);
}

// 一条消息是否有资格"广告"dev 预览。正文消息要么像 dev server 输出、要么上下文
// 含"打开/运行在"类措辞;agentLog 要么命令像起 dev server、要么输出像 dev server。
function messageCanAdvertise(
  message: Message,
  text: string,
  mode: DevPreviewExtractionMode,
): boolean {
  const outputLooksLikeDevServer = DEV_SERVER_OUTPUT_RE.test(text);

  if (message.kind === "text") {
    if (mode === "auto_open") return outputLooksLikeDevServer;
    if (outputLooksLikeDevServer) return true;
    if (NON_PREVIEW_CONTEXT_RE.test(text)) return false;
    return contextCanShowPreview(text);
  }

  if (message.kind === "agentLog") {
    const commandLooksLikeDevServer = DEV_SERVER_COMMAND_RE.test(text);
    if (mode === "auto_open") return outputLooksLikeDevServer;
    if (!commandLooksLikeDevServer && !outputLooksLikeDevServer) return false;
    if (NON_PREVIEW_CONTEXT_RE.test(text) && !outputLooksLikeDevServer && !commandLooksLikeDevServer) {
      return false;
    }
    return true;
  }

  return false;
}

function urlCanShowPreview(
  text: string,
  matchIndex: number,
  matchLength: number,
  outputLooksLikeDevServer: boolean,
): boolean {
  if (outputLooksLikeDevServer) return true;
  const context = surroundingUrlContext(text, matchIndex, matchLength);
  if (NON_PREVIEW_CONTEXT_RE.test(context)) return false;
  return contextCanShowPreview(context);
}

// 端点过滤:把 /health /metrics /readyz /v1 等明显非页面端点排除,避免误把健康检查
// 当预览(Kun 同款)。
function urlLooksLikePagePreview(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    if (/^\/(?:health|metrics|readyz?|livez?|v\d+)(?:\/|$)/.test(pathname)) return false;
    if (/\/(?:health|metrics|readyz?|livez?)(?:\/|$)/.test(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function collect(messages: Message[], mode: DevPreviewExtractionMode): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  // 从最新消息往回扫,优先拿最近的 URL。
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const text = textFromMessage(message);
    if (!text) continue;
    if (!messageCanAdvertise(message, text, mode)) continue;
    const outputLooksLikeDevServer = DEV_SERVER_OUTPUT_RE.test(text);

    for (const match of text.matchAll(LOCAL_URL_CANDIDATE_RE)) {
      if (
        message.kind === "text" &&
        !urlCanShowPreview(text, match.index ?? 0, match[0].length, outputLooksLikeDevServer)
      ) {
        continue;
      }
      const normalized = normalizeDevPreviewUrlInput(trimUrlCandidate(match[0]));
      if (!normalized || !urlLooksLikePagePreview(normalized) || seen.has(normalized)) continue;
      // auto_open 仅环回(KTD4):剔除 169.254/私网段等,防自动 SSRF。
      if (mode === "auto_open" && !isLoopbackDevPreviewUrl(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
      if (urls.length >= MAX_DETECTED_URLS) return urls;
    }
  }

  return urls;
}

// card 模式:全本地/私网集,需用户点击才加载。
export function extractDetectedDevPreviewUrls(messages: Message[]): string[] {
  return collect(messages, "card");
}

// auto_open 模式:仅环回地址 + dev server 输出特征,会被自动打开。
export function extractAutoOpenDevPreviewUrls(messages: Message[]): string[] {
  return collect(messages, "auto_open");
}

function sliceLatestTurn(messages: Message[]): Message[] {
  // 只看最近一条 user(text 且 who 含 "me"/作者为用户)之后的消息。cortex 用 who 区分
  // 作者,用户消息 who === "me"(见 messages.ts)。
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.kind === "text" && "who" in m && m.who === "me") {
      return messages.slice(i + 1);
    }
  }
  return messages;
}

export function extractLatestTurnDevPreviewUrls(messages: Message[]): string[] {
  return extractDetectedDevPreviewUrls(sliceLatestTurn(messages));
}

export function extractLatestTurnAutoOpenDevPreviewUrls(messages: Message[]): string[] {
  return extractAutoOpenDevPreviewUrls(sliceLatestTurn(messages));
}

export function formatDevPreviewUrlLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── 本地 HTML 文件预览探测 ──────────────────────────────────────────────────
// agent 常把产物写成本地 .html(如 `open /Users/.../foo.html`)并提示「用浏览器打开」。探测其中
// 的**绝对**本地 .html 路径,供「预览网页」卡片用 file:// 内嵌打开(路径授权与 file:// 放行在
// 主进程,见 apps/desktop/src/main/browser/localHtml.ts)。

// 绝对路径(/ 或 ~/ 开头)结尾 .html/.htm。不匹配裸文件名(无路径无法授权解析)。
const LOCAL_HTML_PATH_RE = /(?:~|\.{0,2})\/[^\s'"<>()\][`]+\.html?\b/gi;

function isAbsoluteOrHomePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~/");
}

// 从一段纯文本里抽绝对/家目录的 .html 路径(去重)。供 markdown 内联预览(chatMarkdown 的
// fenced 代码块)与下方按消息探测复用。
export function findLocalHtmlPathsInText(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LOCAL_HTML_PATH_RE)) {
    const raw = match[0].replace(/[`),.;]+$/g, "");
    // 只收绝对/家目录路径;相对路径(./、../)无法可靠解析授权,跳过。
    if (!isAbsoluteOrHomePath(raw) || seen.has(raw)) continue;
    seen.add(raw);
    paths.push(raw);
  }
  return paths;
}

export function extractDetectedLocalHtmlPaths(messages: Message[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const text = textFromMessage(message);
    if (!text) continue;
    for (const raw of findLocalHtmlPathsInText(text)) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      paths.push(raw);
      if (paths.length >= MAX_DETECTED_URLS) return paths;
    }
  }
  return paths;
}

export function extractLatestTurnLocalHtmlPaths(messages: Message[]): string[] {
  return extractDetectedLocalHtmlPaths(sliceLatestTurn(messages));
}

// 本地 HTML 路径标签:取文件名(basename)。
export function formatLocalHtmlLabel(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path;
  const parts = clean.split("/");
  return parts[parts.length - 1] || path;
}
