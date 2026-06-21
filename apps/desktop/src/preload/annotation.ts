// 受控「页面元素标注」preload(计划 U4/KTD1)。运行在 webview 的**隔离世界**(contextIsolation
// + sandbox 均为 true,由 webviewGuards.hardenWebviewPreferences 强制),与不可信页面主世界隔离。
//
// 安全约束(KTD1/KTD6):
//   - 只读 DOM(selector / rect / textContent),绝不向页面授予任何能力,不经 contextBridge 暴露
//     任何东西到页面主世界,只用 ipcRenderer 与宿主点对点通信(annotation:* 专用 channel)。
//   - DOM 读取本身不可信:页面可 monkey-patch getBoundingClientRect / elementFromPoint 或污染
//     Node.prototype。故在 preload init 期(页面脚本运行前)**缓存原生方法引用**并用 .call() 调用。
//   - 回传宿主的 payload 仍按不可信处理(宿主侧 annotationPayload 做剥离/围栏,见 KTD2)。
//
// 架构(采用计划 Open Question 的「页面内徽标」方案):高亮框 + 编号徽标 + 评论输入框都由本 preload
// 画进页面 DOM(挂在 shadow root 内,隔离页面 CSS),随元素**原生滚动**,无需向宿主流式回传坐标。
// 宿主只收每条标注的纯数据(annotation:added)用于批量组装,并显示「发送到 Chat/终端」条。

import { ipcRenderer } from "electron";

// init 期缓存原生方法(抗页面后续 monkey-patch / 原型污染)。
const nativeGetRect = Element.prototype.getBoundingClientRect;
const nativeElementFromPoint = Document.prototype.elementFromPoint;
const rectOf = (el: Element): DOMRect => nativeGetRect.call(el);
const elAt = (x: number, y: number): Element | null => nativeElementFromPoint.call(document, x, y);

interface TrackedAnnotation {
  id: string;
  n: number;
  el: Element;
  selector: string;
  tag: string;
  text: string;
  comment: string;
}

let enabled = false;
let seq = 0;
const tracked: TrackedAnnotation[] = [];

// ── shadow root 容器:把标注 UI 与页面样式隔离 ───────────────────────────────
let shadowHost: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let highlightBox: HTMLDivElement | null = null;
let rafId = 0;

function ensureShadow(): ShadowRoot {
  if (shadow) return shadow;
  shadowHost = document.createElement("div");
  shadowHost.setAttribute("data-cortex-annotate", "");
  shadowHost.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  shadow = shadowHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .hl{position:fixed;border:2px solid #7c5cff;border-radius:4px;background:rgba(124,92,255,.12);
        pointer-events:none;transition:all .03s linear;box-shadow:0 0 0 1px rgba(255,255,255,.6);}
    .badge{position:fixed;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#7c5cff;
        color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center;pointer-events:auto;
        cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.3);}
    .pop{position:fixed;width:240px;background:#fff;border:1px solid #e3e3e6;border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.18);padding:8px;pointer-events:auto;font:13px system-ui,sans-serif;}
    .pop input{width:100%;box-sizing:border-box;border:1px solid #e3e3e6;border-radius:6px;padding:6px 8px;
        font:13px system-ui,sans-serif;outline:none;}
    .pop input:focus{border-color:#7c5cff;}
    .pop .row{display:flex;gap:6px;justify-content:flex-end;margin-top:8px;}
    .pop button{border:1px solid #e3e3e6;background:#f5f5f7;border-radius:6px;padding:4px 12px;
        font:12px system-ui,sans-serif;cursor:pointer;}
    .pop button.primary{background:#7c5cff;border-color:#7c5cff;color:#fff;}
  `;
  shadow.appendChild(style);
  document.documentElement.appendChild(shadowHost);
  return shadow;
}

function teardownShadow(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  highlightBox = null;
  if (shadowHost && shadowHost.parentNode) shadowHost.parentNode.removeChild(shadowHost);
  shadowHost = null;
  shadow = null;
}

// 生成稳健 selector:id 优先 → data-* → 结构路径(nth-of-type),最多 5 层。
function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    const dataAttr = Array.from(node.attributes).find((a) => a.name.startsWith("data-") && a.value);
    if (dataAttr) {
      parts.unshift(`${part}[${dataAttr.name}="${CSS.escape(dataAttr.value)}"]`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function textOf(el: Element): string {
  const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

// 每帧重定位高亮框与所有编号徽标(随页面滚动/布局变化跟随,纯页面内,无需回传宿主)。
function tick(): void {
  if (!enabled || !shadow) return;
  for (const a of tracked) {
    const badge = shadow.getElementById(`b-${a.id}`) as HTMLDivElement | null;
    if (!badge) continue;
    if (!a.el.isConnected) {
      badge.style.display = "none"; // 元素已从 DOM 移除(SPA 导航等)→ 隐藏徽标,数据仍在宿主列表
      continue;
    }
    const r = rectOf(a.el);
    badge.style.display = "";
    badge.style.left = `${r.left - 6}px`;
    badge.style.top = `${r.top - 6}px`;
  }
  rafId = requestAnimationFrame(tick);
}

let hovered: Element | null = null;
function onMove(e: MouseEvent): void {
  if (!enabled || !shadow) return;
  const el = elAt(e.clientX, e.clientY);
  if (!el || el === hovered) return;
  // 跳过自己的 shadow host。
  if (shadowHost && (el === shadowHost || shadowHost.contains(el))) return;
  hovered = el;
  if (!highlightBox) {
    highlightBox = document.createElement("div");
    highlightBox.className = "hl";
    shadow.appendChild(highlightBox);
  }
  const r = rectOf(el);
  highlightBox.style.left = `${r.left}px`;
  highlightBox.style.top = `${r.top}px`;
  highlightBox.style.width = `${r.width}px`;
  highlightBox.style.height = `${r.height}px`;
}

function onClick(e: MouseEvent): void {
  if (!enabled || !shadow) return;
  // 跳过 shadow 内部(徽标/弹框)点击。
  const target = e.target as Node;
  if (shadowHost && (target === shadowHost || shadowHost.contains(target))) return;
  const el = elAt(e.clientX, e.clientY);
  if (!el) return;
  // 拦截页面自身的链接/按钮导航。
  e.preventDefault();
  e.stopPropagation();
  openPopup(el, e.clientX, e.clientY);
}

let popup: HTMLDivElement | null = null;
function closePopup(): void {
  if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
  popup = null;
}

function openPopup(el: Element, x: number, y: number): void {
  if (!shadow) return;
  closePopup();
  const selector = cssPath(el);
  const tag = el.tagName.toLowerCase();
  const text = textOf(el);
  popup = document.createElement("div");
  popup.className = "pop";
  popup.style.left = `${Math.min(x, window.innerWidth - 252)}px`;
  popup.style.top = `${Math.min(y + 8, window.innerHeight - 90)}px`;
  const input = document.createElement("input");
  input.placeholder = "添加评论…"; // 文案由宿主语言决定时可改 ipc 下发;此处页面内简体兜底
  const row = document.createElement("div");
  row.className = "row";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  const ok = document.createElement("button");
  ok.className = "primary";
  ok.textContent = "添加";
  row.append(cancel, ok);
  popup.append(input, row);
  shadow.appendChild(popup);
  input.focus();

  const commit = (): void => {
    const comment = input.value.trim();
    if (!comment) {
      input.focus();
      return; // 空评论不入队(计划 KTD5)
    }
    const id = `a${++seq}`;
    const n = tracked.length + 1;
    tracked.push({ id, n, el, selector, tag, text, comment });
    drawBadge(id, n, el);
    closePopup();
    // 回传宿主纯数据(url 由宿主用 webview.getURL() 盖戳,不在此发,见 KTD2)。
    ipcRenderer.sendToHost("annotation:added", { id, n, selector, tag, text, comment });
  };
  ok.addEventListener("click", commit);
  cancel.addEventListener("click", closePopup);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") commit();
    else if (ev.key === "Escape") closePopup();
  });
}

function drawBadge(id: string, n: number, el: Element): void {
  if (!shadow) return;
  const badge = document.createElement("div");
  badge.id = `b-${id}`;
  badge.className = "badge";
  badge.textContent = String(n);
  badge.title = "点击删除此标注";
  const r = rectOf(el);
  badge.style.left = `${r.left - 6}px`;
  badge.style.top = `${r.top - 6}px`;
  badge.addEventListener("click", (ev) => {
    ev.stopPropagation();
    removeAnnotation(id);
  });
  shadow.appendChild(badge);
}

function removeAnnotation(id: string): void {
  const idx = tracked.findIndex((a) => a.id === id);
  if (idx < 0) return;
  tracked.splice(idx, 1);
  if (shadow) {
    const badge = shadow.getElementById(`b-${id}`);
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    // 重排编号 1..N。
    tracked.forEach((a, i) => {
      a.n = i + 1;
      const b = shadow!.getElementById(`b-${a.id}`);
      if (b) b.textContent = String(a.n);
    });
  }
  ipcRenderer.sendToHost("annotation:removed", { id, ids: tracked.map((a) => a.id), order: tracked.map((a) => a.n) });
}

function enable(): void {
  if (enabled) return;
  enabled = true;
  ensureShadow();
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  rafId = requestAnimationFrame(tick);
}

function disable(): void {
  if (!enabled) return;
  enabled = false;
  document.removeEventListener("mousemove", onMove, true);
  document.removeEventListener("click", onClick, true);
  closePopup();
  hovered = null;
  tracked.length = 0;
  seq = 0;
  teardownShadow();
}

// 宿主 → preload 控制(经 webview.send → 隔离世界 ipcRenderer.on)。
ipcRenderer.on("annotation:enable", enable);
ipcRenderer.on("annotation:disable", disable);
// 整页导航后宿主会重建,这里只保证旧状态被清掉。
window.addEventListener("beforeunload", disable);
