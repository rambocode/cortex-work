// pi 产物 / REPL 沙箱的 srcdoc 组装与消息协议（纯函数,jsdom 可测的核心;参考 pi-web-ui 的
// SandboxedIframe 思路,React 组件层见 SandboxedIframe.tsx）。
//
// 【安全模型】这里生成的 HTML 只能进 `sandbox="allow-scripts allow-modals"` 的 iframe:
// srcdoc + 无 allow-same-origin = opaque origin,拿不到 parent DOM / preload bridge / 任何存储。
// runtime 与宿主只经 postMessage 通信,消息一律带 sandboxId,宿主经 parsePiSandboxMessage
// 单点校验(来源 iframe + id 双验),防止页面里其它 iframe 或第三方脚本伪造。

/** 沙箱 → 宿主的消息类型标记（所有帧共用,便于宿主快速过滤无关 message 事件）。 */
export const PI_SANDBOX_MSG = "pi-sandbox";

/** 单条 console 输出。level 归并为三档,args 已在沙箱内序列化为字符串。 */
export interface PiSandboxConsoleEntry {
  level: "log" | "warn" | "error";
  text: string;
}

/** 归一化后的沙箱消息（parsePiSandboxMessage 的产物）。 */
export type PiSandboxMessage =
  | { kind: "console"; entry: PiSandboxConsoleEntry }
  | { kind: "open-external"; url: string }
  | { kind: "error"; message: string; stack?: string }
  // 仅 repl 模式:执行完成,returnValue 为最后表达式值的序列化文本（undefined 时缺省）。
  | { kind: "done"; ok: boolean; returnValue?: string };

/** 组装参数。 */
export interface BuildSandboxSrcdocOptions {
  /** html = 持续展示产物;repl = 一次性执行收结果。 */
  mode: "html" | "repl";
  /** html 模式 = 完整 HTML 文档;repl 模式 = 待执行 JS 源码。 */
  code: string;
  /** 会话内唯一沙箱 id,宿主校验消息归属。 */
  sandboxId: string;
  /** 是否放行 https 外联(CDN 脚本/图片/接口)。默认 true——产物常引 Tailwind/Chart.js CDN。 */
  allowNetwork?: boolean;
}

/** console 输出条数上限（沙箱内计数,超限静默丢弃,防死循环 log 刷爆宿主）。 */
const MAX_CONSOLE_ENTRIES = 500;
/** 单条 console 文本上限。 */
const MAX_CONSOLE_TEXT = 4_000;

/**
 * `</script>` 转义:用户代码/产物内容会被内联进 <script> 标签,不转义会提前闭合标签、
 * 把剩余内容变成可注入的裸 HTML（上游同款处理）。
 */
export function escapeScriptContent(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

/**
 * CSP meta 标签。默认全禁,按需放行:
 * - 'unsafe-inline' 是 srcdoc 产物的刚需(内联 <script>/<style> 是它唯一的代码形态);
 * - allowNetwork 追加 https:(含 connect-src fetch),不放行 http:——明文外联无正当场景。
 * 沙箱本身(opaque origin)已隔离特权,CSP 是第二道闸,收窄外泄面。
 */
function cspMeta(allowNetwork: boolean): string {
  const net = allowNetwork ? " https:" : "";
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${net}`,
    `style-src 'unsafe-inline'${net}`,
    `img-src data: blob:${net}`,
    `font-src data:${net}`,
    allowNetwork ? "connect-src https:" : "connect-src 'none'",
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${directives}">`;
}

/**
 * 注入沙箱的 runtime 脚本:console 代理、错误上报、导航拦截(链接/表单/window.open →
 * open-external 交宿主经系统浏览器打开,沙箱无 allow-popups/top-navigation,不拦会被静默吞)。
 * 以字符串模板生成(不能引用宿主作用域的任何变量)。
 */
function runtimeScript(sandboxId: string): string {
  return `<script>
(function () {
  var SID = ${JSON.stringify(sandboxId)};
  var MAX_N = ${MAX_CONSOLE_ENTRIES};
  var MAX_T = ${MAX_CONSOLE_TEXT};
  var count = 0;
  function post(msg) { try { parent.postMessage(Object.assign({ type: ${JSON.stringify(PI_SANDBOX_MSG)}, sandboxId: SID }, msg), "*"); } catch (e) {}
  }
  function fmt(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === "string") parts.push(a);
      else { try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); } }
    }
    var s = parts.join(" ");
    return s.length > MAX_T ? s.slice(0, MAX_T) + "…" : s;
  }
  ["log", "info", "debug", "warn", "error"].forEach(function (m) {
    var orig = console[m];
    console[m] = function () {
      if (count++ < MAX_N) post({ kind: "console", entry: { level: m === "warn" ? "warn" : m === "error" ? "error" : "log", text: fmt(arguments) } });
      if (orig) orig.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (e) { post({ kind: "error", message: String(e.message || e.error || "error"), stack: e.error && e.error.stack }); });
  window.addEventListener("unhandledrejection", function (e) { var r = e.reason; post({ kind: "error", message: String((r && r.message) || r || "unhandled rejection"), stack: r && r.stack }); });
  // 导航拦截:沙箱内点链接/提交表单/window.open 一律转宿主 open-external(系统浏览器)。
  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el.tagName !== "A") el = el.parentElement;
    if (el && el.href && /^https?:/i.test(el.href)) { e.preventDefault(); post({ kind: "open-external", url: el.href }); }
  }, true);
  document.addEventListener("submit", function (e) { e.preventDefault(); }, true);
  window.open = function (url) { if (url && /^https?:/i.test(String(url))) post({ kind: "open-external", url: String(url) }); return null; };
})();
</script>`;
}

/** repl 模式的执行包壳:用户代码套 async 函数,最后表达式值与错误都经 done 帧回宿主。 */
function replBody(userCode: string): string {
  return `<script>
(async function () {
  function post(msg) { try { parent.postMessage(Object.assign({ type: ${JSON.stringify(PI_SANDBOX_MSG)}, sandboxId: window.__PI_SANDBOX_ID }, msg), "*"); } catch (e) {} }
  try {
    var __result = await (async function () {
${escapeScriptContent(userCode)}
    })();
    var rv;
    if (__result !== undefined) { try { rv = JSON.stringify(__result); } catch (e) { rv = String(__result); } }
    post({ kind: "done", ok: true, returnValue: rv });
  } catch (err) {
    post({ kind: "error", message: String((err && err.message) || err), stack: err && err.stack });
    post({ kind: "done", ok: false });
  }
})();
</script>`;
}

/**
 * 组装沙箱 srcdoc。
 * - html 模式:把 runtime <script> 注入产物文档的 <head>（无 head 则 <html> 后,再无则整体前置——
 *   参考实现的三级回退）,产物本体原样保留。
 * - repl 模式:生成包壳文档,runtime + 用户代码顺序注入。
 */
export function buildSandboxSrcdoc(options: BuildSandboxSrcdocOptions): string {
  const { mode, code, sandboxId } = options;
  const allowNetwork = options.allowNetwork !== false;
  const injected = cspMeta(allowNetwork) + runtimeScript(sandboxId);

  if (mode === "repl") {
    // __PI_SANDBOX_ID 挂 window:repl 包壳与 runtime 分属两个 <script>,共享 id 走全局。
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${injected}<script>window.__PI_SANDBOX_ID=${JSON.stringify(sandboxId)};</script></head><body>${replBody(code)}</body></html>`;
  }

  const headMatch = /<head[^>]*>/i.exec(code);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return code.slice(0, at) + injected + code.slice(at);
  }
  const htmlMatch = /<html[^>]*>/i.exec(code);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return code.slice(0, at) + injected + code.slice(at);
  }
  return injected + code;
}

/**
 * 宿主侧消息校验单点:类型标记 + sandboxId 双验,形状不符返回 null。
 * 调用方还须校验 event.source === iframe.contentWindow（组件层职责,这里只管数据形状）。
 */
export function parsePiSandboxMessage(data: unknown, expectedSandboxId: string): PiSandboxMessage | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.type !== PI_SANDBOX_MSG || o.sandboxId !== expectedSandboxId) return null;
  switch (o.kind) {
    case "console": {
      const entry = o.entry as Record<string, unknown> | undefined;
      if (!entry || typeof entry.text !== "string") return null;
      const level = entry.level === "warn" || entry.level === "error" ? entry.level : "log";
      return { kind: "console", entry: { level, text: entry.text } };
    }
    case "open-external":
      // 只认 http(s):沙箱内容不可信,file:/javascript: 等协议一律拒绝。
      return typeof o.url === "string" && /^https?:\/\//i.test(o.url) ? { kind: "open-external", url: o.url } : null;
    case "error":
      return typeof o.message === "string"
        ? { kind: "error", message: o.message, ...(typeof o.stack === "string" ? { stack: o.stack } : {}) }
        : null;
    case "done":
      return {
        kind: "done",
        ok: o.ok === true,
        ...(typeof o.returnValue === "string" ? { returnValue: o.returnValue } : {}),
      };
    default:
      return null;
  }
}
