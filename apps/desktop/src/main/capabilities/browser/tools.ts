// 浏览器控制默认层工具(U5)。注册到常驻 MCP server,在主进程直驱面板 guest WebContents:
// navigate / screenshot / readDom / readConsole(只读)+ click / type(改动型,过会话归属仲裁)。
// click/type 用 executeJavaScript 合成事件(isTrusted=false):本地自测够用,且不会误触发
// OAuth / 表单提交等可信门控操作(更安全)。可信输入(sendInputEvent)留作 follow-up。
// 看门狗:readDom 结果经 sanitize 钳制大小,避免巨型返回拖久工具调用触发渲染端 stall 看门狗。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebContents } from "electron";
import { z } from "zod";

import { isAuthorizedFileUrl } from "../../browser/localHtml";
import { getPersistedState } from "../../ipc/store";
import { getLiveGuest, readConsoleBuffer } from "./guest-registry";
import { claimForMutation } from "./ownership";
import { registerCdpTools } from "./cdp";
import { asUntrustedPageContent } from "./sanitize";
import type { ToolContext } from "../mcp-host/server";
import { classifyTarget } from "./url-gate";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const LEVEL_NAME = ["verbose", "info", "warning", "error"];
const NOT_FOUND = "__CORTEX_NOT_FOUND__";
const OPEN_TIMEOUT_MS = 6000; // 请求开面板后等 guest 出现的上限

// 主进程提供的运行时能力(由 index.ts 注入)。
export interface BrowserToolDeps {
  // 请求渲染端打开内置浏览器面板并导航(面板未开时用)。
  openPanel: (url: string) => void;
}

// 轮询等 guest 出现:渲染端开面板 → webview 挂载 → web-contents-created 捕获,均异步。
async function waitForGuest(timeoutMs: number): Promise<WebContents | null> {
  const deadline = Date.now() + timeoutMs;
  let g = getLiveGuest();
  while (!g && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    g = getLiveGuest();
  }
  return g;
}

async function approvedOrigins(): Promise<string[]> {
  try {
    return (await getPersistedState()).generalSettings?.browserControl?.approvedOrigins ?? [];
  } catch {
    return [];
  }
}

// 导航授权范围(plan U5):每次工具调用即时读最新持久化值,改设置即对下一次导航生效。
async function navigationApproval(): Promise<"nonLocalOnly" | "all"> {
  try {
    return (await getPersistedState()).generalSettings?.browserControl?.navigationApproval ?? "nonLocalOnly";
  } catch {
    return "nonLocalOnly";
  }
}

export function registerBrowserTools(mcp: McpServer, ctx: ToolContext, deps: BrowserToolDeps): void {
  // navigate(改动型):过 URL 闸 + 归属;面板未开则请求渲染端打开并导航。
  mcp.registerTool(
    "browser_navigate",
    { description: "把内置浏览器导航到 URL(本地优先;非本地需用户预授权)。面板未开会自动打开。", inputSchema: { url: z.string() } },
    async ({ url }) => {
      const verdict = classifyTarget(url, await approvedOrigins(), isAuthorizedFileUrl, await navigationApproval());
      if (!verdict.allow) {
        if (verdict.reason === "non-local-unapproved")
          return text(`被拒:origin ${verdict.origin} 未授权。请用户在「设置 → 浏览器控制 → 待授权」授权后重试。`);
        return text(`被拒(${verdict.reason}):该 URL 不允许导航。`);
      }
      if (!claimForMutation(ctx.sessionId, Date.now())) return text("浏览器面板正被其它会话占用,稍后重试。");
      const guest = getLiveGuest();
      if (!guest) {
        // 面板未开:请求渲染端开面板并导航(requestBrowserUrl 同时开面板 + loadUrl),再等 guest 出现。
        deps.openPanel(url);
        const opened = await waitForGuest(OPEN_TIMEOUT_MS);
        if (!opened) return text("已请求打开内置浏览器面板;若应用窗口可见请稍候重试。");
        return text(`已打开浏览器面板并导航到 ${url}`);
      }
      await guest.loadURL(url);
      return text(`已导航到 ${url}`);
    },
  );

  // screenshot(只读)。
  mcp.registerTool("browser_screenshot", { description: "截取当前页面,返回 PNG 图像。", inputSchema: {} }, async () => {
    const guest = getLiveGuest();
    if (!guest) return text("无可控浏览器面板。");
    const img = await guest.capturePage();
    return { content: [{ type: "image" as const, data: img.toPNG().toString("base64"), mimeType: "image/png" }] };
  });

  // readDom(只读):只回文本(非裸 innerHTML),过不可信中和。
  mcp.registerTool(
    "browser_read_dom",
    { description: "读取页面文本(可选 CSS 选择器,缺省取 body)。", inputSchema: { selector: z.string().optional() } },
    async ({ selector }) => {
      const guest = getLiveGuest();
      if (!guest) return text("无可控浏览器面板。");
      const sel = selector ?? "body";
      const js = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? (el.innerText || el.textContent || "") : ${JSON.stringify(NOT_FOUND)}; })()`;
      const r = String(await guest.executeJavaScript(js));
      if (r === NOT_FOUND) return text(`未找到元素:${sel}`);
      return text(asUntrustedPageContent(`DOM ${sel}`, r));
    },
  );

  // readConsole(只读):读有界缓冲。
  mcp.registerTool("browser_read_console", { description: "读取页面控制台输出(最近若干条)。", inputSchema: {} }, async () => {
    const lines = readConsoleBuffer()
      .map((m) => `[${LEVEL_NAME[m.level] ?? String(m.level)}] ${m.message}`)
      .join("\n");
    return text(asUntrustedPageContent("控制台", lines || "(无控制台输出)"));
  });

  // click(改动型):合成事件。
  mcp.registerTool("browser_click", { description: "点击匹配 CSS 选择器的元素。", inputSchema: { selector: z.string() } }, async ({ selector }) => {
    const guest = getLiveGuest();
    if (!guest) return text("无可控浏览器面板。");
    if (!claimForMutation(ctx.sessionId, Date.now())) return text("浏览器面板正被其它会话占用,稍后重试。");
    const js = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return ${JSON.stringify(NOT_FOUND)}; el.scrollIntoView({block:"center"}); el.click(); return "ok"; })()`;
    const r = String(await guest.executeJavaScript(js));
    return text(r === NOT_FOUND ? `未找到元素:${selector}` : `已点击 ${selector}`);
  });

  // type(改动型):填值 + 派发 input/change(合成)。
  mcp.registerTool(
    "browser_type",
    { description: "向匹配选择器的输入元素填入文本(替换原值)。", inputSchema: { selector: z.string(), text: z.string() } },
    async ({ selector, text: value }) => {
      const guest = getLiveGuest();
      if (!guest) return text("无可控浏览器面板。");
      if (!claimForMutation(ctx.sessionId, Date.now())) return text("浏览器面板正被其它会话占用,稍后重试。");
      const js = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return ${JSON.stringify(NOT_FOUND)}; el.focus(); if ("value" in el) el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return "ok"; })()`;
      const r = String(await guest.executeJavaScript(js));
      return text(r === NOT_FOUND ? `未找到元素:${selector}` : `已向 ${selector} 输入文本`);
    },
  );

  // CDP 层工具(opt-in:网络脱敏 + 无障碍,U7)。
  registerCdpTools(mcp);
}
