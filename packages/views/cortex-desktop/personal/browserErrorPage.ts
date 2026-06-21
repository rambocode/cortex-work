// 构造「在 webview 内部渲染自定义错误页」的注入脚本(计划 U2 增强 / 用户要求 B)。
// 站点加载失败时,host 用 webview.executeJavaScript(本脚本) 把错误 UI 写进失败页(chrome-error)
// 的 DOM —— 这样 capturePage 截到的是这张自定义错误页、标注 preload 也能作用于其元素
// (宿主浮层做不到,因 capturePage/preload 只作用于 webview 内部)。
//
// 安全:所有动态值(host/url/文案)经 JSON.stringify 进脚本字面量、并以 textContent 写入(非
// innerHTML),杜绝 HTML/JS 注入。reload 走 location.reload()(重试原始 URL),open 走
// window.open(url)(被主进程 setWindowOpenHandler 拦成系统浏览器外溢)。

export interface ErrorPageParams {
  title: string;
  reason: string;
  hints: string[];
  codeLabel: string;
  code: string | null;
  reloadLabel: string;
  openLabel: string;
  url: string;
}

const ACCENT = "#7c5cff"; // 品牌强调色(webview 内读不到 host CSS 变量,固定值)

export function buildErrorPageScript(params: ErrorPageParams): string {
  // 整段以 IIFE + try/catch 包裹;p 由 JSON.stringify 安全注入。
  return `(function(){try{
  var p = ${JSON.stringify(params)};
  var ACCENT = ${JSON.stringify(ACCENT)};
  var d = document;
  if (!d.body) return;
  d.body.innerHTML = "";
  d.body.style.cssText = "margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:system-ui,-apple-system,sans-serif;";
  var box = d.createElement("div");
  box.style.cssText = "text-align:center;max-width:460px;padding:0 24px;color:#6b7280;";
  var icon = d.createElement("div");
  icon.style.cssText = "font-size:40px;line-height:1;color:" + ACCENT + ";";
  icon.textContent = "\\u25C9";
  var title = d.createElement("div");
  title.textContent = p.title;
  title.style.cssText = "font-size:17px;font-weight:600;color:#111827;margin-top:16px;";
  var reason = d.createElement("div");
  reason.textContent = p.reason;
  reason.style.cssText = "font-size:13px;margin-top:8px;color:#4b5563;";
  var hints = d.createElement("ul");
  hints.style.cssText = "text-align:left;font-size:12px;line-height:1.75;margin:14px 0 0;padding:0 0 0 18px;color:#6b7280;";
  (p.hints || []).forEach(function (h) { var li = d.createElement("li"); li.textContent = h; hints.appendChild(li); });
  var actions = d.createElement("div");
  actions.style.cssText = "margin-top:22px;display:flex;gap:10px;justify-content:center;";
  var reload = d.createElement("button");
  reload.textContent = p.reloadLabel;
  reload.style.cssText = "padding:6px 16px;border-radius:7px;border:1px solid " + ACCENT + ";background:" + ACCENT + ";color:#fff;cursor:pointer;font-size:12.5px;";
  reload.onclick = function () { location.reload(); };
  var open = d.createElement("button");
  open.textContent = p.openLabel;
  open.style.cssText = "padding:6px 16px;border-radius:7px;border:1px solid #d1d5db;background:#f3f4f6;color:#374151;cursor:pointer;font-size:12.5px;";
  open.onclick = function () { window.open(p.url, "_blank"); };
  actions.appendChild(reload);
  actions.appendChild(open);
  box.appendChild(icon);
  box.appendChild(title);
  box.appendChild(reason);
  box.appendChild(hints);
  if (p.code) {
    var code = d.createElement("div");
    code.textContent = p.codeLabel + ": " + p.code;
    code.style.cssText = "font-size:11px;color:#9ca3af;margin-top:14px;font-family:ui-monospace,monospace;";
    box.appendChild(code);
  }
  box.appendChild(actions);
  d.body.appendChild(box);
  return true;
} catch (e) { return false; }})();`;
}
