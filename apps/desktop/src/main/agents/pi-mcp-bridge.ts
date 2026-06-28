// pi 通用 MCP 桥接扩展(系统默认集成,用户无需自行安装第三方扩展)。
//
// 背景:pi 核心不内置 MCP 协议;claude/codex 经 mcp-config.ts 原生注入(.mcp.json / -c)。
// 为让 pi 也能用「内置浏览器控制 server」**以及用户在设置里配的任意 MCP server**,cortex 自写一个
// pi 扩展,把每个 MCP server 的工具异步发现并代理注册成 pi 工具(参考社区 pi-mcp-adapter 的能力,
// 但完全 cortex 自有:零第三方依赖、随会话生成、无版本错配、无 225M 安装)。
//
// 关键可行性(pi 0.79.2 docs/extensions.md 已证):extension 的 default factory 可为 async,且 pi
// 会在 startup(session_start / 工具快照)**之前 await 它**。故可在 factory 内异步「连 server →
// tools/list → registerTool」,startup 前全部就绪。`parameters` 用普通 JSON Schema 即可(无需 typebox,
// 与 pi-extensions.ts 同款,spike 已证)。运行时只用 node 内置(node:child_process)+ 全局 fetch。
//
// 传输支持:stdio(换行分帧 JSON-RPC,本地 server 主流)与 streamable-http(fetch + JSON/SSE 响应,
// 内置浏览器 server 与远程 server)。legacy `sse` 传输按 streamable 尽力而为(纯 GET-SSE 旧端点可能不通,
// 已在运行时打 warn)。单个 server 接入失败只跳过该 server,不影响其它 server 与 pi 启动。
//
// 安全:鉴权头(浏览器 server 的 Bearer/X-Cortex-Session)与 stdio 的 env(含透传解析值)烘焙进生成的
// .js,落 userData/pi-extensions(mode 0600),与 mcp-config.ts 写 .mcp.json(gitignored)的密钥落盘同源。

import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { McpServerConfig } from "../ipc/types";
import { effectiveEnv } from "../ipc/mcp-config";
import { isValidServerId } from "../ipc/mcp-config";

// 生成扩展消费的「桥接 server」形状:cortex 侧把 McpServerConfig(stdio 的 env 已解析为明确值)与
// 浏览器 server(url+headers)归一到此,JSON.stringify 烘焙进生成的扩展。
export interface BridgeServer {
  id: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

// 把一个 McpServerConfig 归一为 BridgeServer(stdio 解析 env;非法 id 跳过)。url/headers 直接透传
// (浏览器 server 经 buildBrowserMcpServerConfig 已是 http+url+headers,亦走此函数)。
export function mcpServerToBridge(s: McpServerConfig): BridgeServer | null {
  if (!isValidServerId(s.id)) return null;
  if (s.transport === "stdio") {
    if (!s.command) return null; // stdio 无命令不可启动
    const env = effectiveEnv(s);
    return {
      id: s.id,
      transport: "stdio",
      command: s.command,
      ...(s.args?.length ? { args: s.args } : {}),
      ...(env ? { env } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
    };
  }
  // sse/http:无 url 不可连。
  if (!s.url) return null;
  return {
    id: s.id,
    transport: s.transport,
    url: s.url,
    ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}),
  };
}

// 汇总要桥接的 server 列表:用户已启用的 MCP server(总开关开时)+ 浏览器 server(可用时)。
// 浏览器 server 已是 McpServerConfig 形状(http),与用户 server 同走 mcpServerToBridge。
export function collectBridgeServers(
  userServers: McpServerConfig[],
  browserServer: McpServerConfig | null,
): BridgeServer[] {
  const out: BridgeServer[] = [];
  for (const s of userServers) {
    const b = mcpServerToBridge(s);
    if (b) out.push(b);
  }
  if (browserServer) {
    const b = mcpServerToBridge(browserServer);
    if (b) out.push(b);
  }
  return out;
}

// 生成扩展的运行时主体(无 import / 无 SERVERS 声明 / 无 default export——这三者由 render 拼接补上,
// 因 ESM import 必须置顶,不能被 `const SERVERS` 前置)。极简 MCP 客户端 + 异步发现注册。
const MCP_BRIDGE_RUNTIME = String.raw`
// ── 极简 MCP 客户端:仅 initialize / notifications/initialized / tools/list / tools/call ──
const MCP_TIMEOUT_MS = 20000;

// stdio 传输:spawn 子进程,换行分帧 JSON-RPC(MCP stdio 规范:一行一条消息,无内嵌换行)。
function makeStdioClient(server) {
  const child = spawn(server.command, server.args || [], {
    env: Object.assign({}, process.env, server.env || {}),
    cwd: server.cwd || undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  if (child.stderr) child.stderr.resume(); // 消费 stderr,防管道胀满阻塞子进程
  if (child.stdin) child.stdin.on("error", () => {}); // 子进程已死写 stdin 的 EPIPE 兜底
  const pending = new Map();
  let buf = "";
  let nextId = 0;
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg && msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error((msg.error && msg.error.message) || "MCP error"));
        else p.resolve(msg.result);
      }
    }
  });
  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error("MCP 超时: " + method));
      }, MCP_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }) + "\n"); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  function notify(method, params) {
    try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: method, params: params }) + "\n"); }
    catch (e) { /* 通知失败不阻断 */ }
  }
  return { request: request, notify: notify, close: () => { try { child.kill(); } catch (e) {} } };
}

// 从 SSE 文本里取出 id 匹配的 JSON-RPC 响应(无 id 的消息作兜底)。
function parseSseForId(text, id) {
  let fallback = null;
  const blocks = text.split("\n\n");
  for (let i = 0; i < blocks.length; i++) {
    const dataLines = blocks[i].split("\n")
      .filter((l) => l.indexOf("data:") === 0)
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    let msg;
    try { msg = JSON.parse(dataLines.join("\n")); } catch (e) { continue; }
    if (msg && msg.id === id) return msg;
    if (msg && msg.id == null && !fallback) fallback = msg;
  }
  return fallback;
}

// 一次 HTTP POST。**刻意用 node:http/https 而非全局 fetch**:pi 跑在 Electron utilityProcess 里,
// 其全局 fetch(undici)在该宿主可能不可用/抛 "fetch failed"(实测 undici 版本错配会崩);
// node:http 在 Electron 里铁打不动。返回 { status, headers, body }(body 已读全;响应带 content-length)。
function httpPostRaw(urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: Object.assign({}, headers, { "content-length": Buffer.byteLength(bodyStr) }),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      },
    );
    const timer = setTimeout(() => { req.destroy(new Error("MCP HTTP 超时")); }, MCP_TIMEOUT_MS);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.on("close", () => clearTimeout(timer));
    req.write(bodyStr);
    req.end();
  });
}

// streamable-http 传输:每条 JSON-RPC 一次 POST。Accept 须同时含 application/json 与 text/event-stream
// (SDK StreamableHTTPServerTransport 据此判定,缺则 406)。捕获并回送 mcp-session-id(远程有状态 server)。
function makeHttpClient(server) {
  let sessionId = null;
  let nextId = 0;
  async function rpc(method, params, isNotify) {
    const id = isNotify ? undefined : ++nextId;
    const headers = Object.assign(
      { "content-type": "application/json", "accept": "application/json, text/event-stream" },
      server.headers || {},
      sessionId ? { "mcp-session-id": sessionId } : {},
    );
    const envelope = { jsonrpc: "2.0", method: method };
    if (id != null) envelope.id = id;
    if (params !== undefined) envelope.params = params;
    const res = await httpPostRaw(server.url, headers, JSON.stringify(envelope));
    const sid = res.headers["mcp-session-id"];
    if (sid) sessionId = Array.isArray(sid) ? sid[0] : sid;
    if (isNotify) return undefined;
    if (res.status !== 200 && res.status !== 202) throw new Error("MCP HTTP " + res.status);
    const ct = String(res.headers["content-type"] || "");
    let payload;
    if (ct.indexOf("text/event-stream") >= 0) payload = parseSseForId(res.body, id);
    else payload = res.body ? JSON.parse(res.body) : undefined;
    if (!payload) throw new Error("MCP 无响应: " + method);
    if (payload.error) throw new Error((payload.error && payload.error.message) || "MCP error");
    return payload.result;
  }
  return {
    request: (m, p) => rpc(m, p, false),
    notify: (m, p) => rpc(m, p, true),
    close: () => {},
  };
}

// 主入口:逐个 server 连接 → 握手 → tools/list → 注册为 pi 工具(execute 时 tools/call 代理)。
async function __mcpBridgeMain(pi, servers) {
  const registered = new Set();
  const clients = [];
  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    let client = null;
    try {
      client = server.transport === "stdio" ? makeStdioClient(server) : makeHttpClient(server);
      await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cortex-pi-bridge", version: "1.0.0" },
      });
      client.notify("notifications/initialized", {});
      const list = await client.request("tools/list", {});
      const tools = list && Array.isArray(list.tools) ? list.tools : [];
      clients.push(client);
      for (let j = 0; j < tools.length; j++) {
        const t = tools[j];
        if (!t || typeof t.name !== "string") continue;
        // 跨 server 重名去重:先到先得(浏览器 server 末位注入,故用户 server 优先)。
        if (registered.has(t.name)) continue;
        registered.add(t.name);
        const toolName = t.name;
        const callClient = client;
        const schema = t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {} };
        pi.registerTool({
          name: toolName,
          description: typeof t.description === "string" ? t.description : "",
          parameters: schema,
          async execute(_toolCallId, params) {
            try {
              const r = await callClient.request("tools/call", { name: toolName, arguments: params || {} });
              const content = r && Array.isArray(r.content) ? r.content : [{ type: "text", text: JSON.stringify(r) }];
              return { content: content, isError: !!(r && r.isError) };
            } catch (e) {
              return { content: [{ type: "text", text: "MCP 工具调用失败: " + String((e && e.message) || e) }], isError: true };
            }
          },
        });
      }
    } catch (e) {
      // 单 server 失败不影响其它 server 与 pi 启动(fail-soft)。
      if (client && client.close) { try { client.close(); } catch (e2) {} }
      try { console.warn("[cortex-mcp-bridge] server " + (server && server.id) + " 接入失败: " + String((e && e.message) || e)); } catch (e3) {}
    }
  }
  // 会话结束清理 stdio 子进程(best-effort;子进程本随 pi 退出而亡,显式关更干净)。
  if (pi && typeof pi.on === "function") {
    pi.on("session_shutdown", () => {
      for (let k = 0; k < clients.length; k++) { try { clients[k].close(); } catch (e) {} }
    });
  }
}
`;

// 渲染生成的扩展源码(纯函数,便于单测)。import 置顶 → SERVERS 烘焙 → 运行时主体 → async default。
export function renderMcpBridgeExtension(servers: BridgeServer[]): string {
  return [
    "// 由 Cortex Desktop 自动生成(pi MCP 桥接),请勿手改。",
    'import { spawn } from "node:child_process";',
    'import http from "node:http";',
    'import https from "node:https";',
    `const SERVERS = ${JSON.stringify(servers)};`,
    MCP_BRIDGE_RUNTIME,
    "export default async function (pi) { await __mcpBridgeMain(pi, SERVERS); }",
    "",
  ].join("\n");
}

// 落盘扩展文件,返回绝对路径。fileName 缺省固定名(RPC 桥接每次 open 覆盖重写);委派单发传
// per-session 名(delegate-bridge-<sid>.js)避免并发 pi 互相覆盖(R3)。token/session 每会话刷新烘焙进文件。
export function writeMcpBridgeExtension(servers: BridgeServer[], fileName = "mcp-bridge.js"): string {
  const dir = join(app.getPath("userData"), "pi-extensions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, renderMcpBridgeExtension(servers), { mode: 0o600 });
  return file;
}
