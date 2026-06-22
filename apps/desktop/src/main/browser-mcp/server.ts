// 浏览器控制 MCP server(U2):随主进程常驻的 Streamable HTTP MCP server。
// agent(claude/codex)经注入的 url(/mcp,带 Authorization: Bearer <token>)连入;
// tool handler 在主进程直接驱动 webview guest(U4/U5 注入实际工具,U2 仅 ping 占位)。
//
// 跨进程契约:server 端点形状(http /mcp + Bearer token + 无状态 Streamable HTTP)与注入侧
// (U3 buildClaudeMcpJson headers / buildCodexMcpArgs http_headers)必须一致。
// 鉴权:Authorization: Bearer <token>(crypto 随机 + 常量时间比较),叠加 Origin 校验
// (agent CLI 的 HTTP 客户端不带浏览器 Origin;带真实 Origin 的请求一律挡——防本地网页 DNS-rebinding)。
// 生命周期随主进程(index.ts whenReady 起、before-quit 停);listen 失败降级不崩(serverAvailable=false)。
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface BrowserMcpHandle {
  port: number;
  token: string;
  // listen 失败时 false:注入侧(U3)据此不注入,避免给 agent 一个连不上的 url。
  serverAvailable: boolean;
}

// 工具注册钩子:U5 经此注入实际浏览器工具;缺省仅 ping。
export type ToolRegistrar = (mcp: McpServer) => void;

let current: { http: http.Server; handle: BrowserMcpHandle } | null = null;

// 常量时间比较,避免 token 计时侧信道泄漏。
function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// agent CLI(claude/codex)的 MCP HTTP 客户端不带浏览器 Origin;网页/渲染端发的请求带真实 Origin。
// 仅放行无 Origin / "null",据此挡掉本地网页经 DNS-rebinding 触达 loopback server。
function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || origin === "null";
}

function makeServer(registerTools: ToolRegistrar): McpServer {
  const mcp = new McpServer({ name: "cortex-browser", version: "1.0.0" });
  // ping:连通性占位(U2);实际浏览器工具(navigate/screenshot/...)由 U5 经 registerTools 注入。
  mcp.registerTool("ping", { description: "连通性检查,返回 pong。", inputSchema: {} }, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  registerTools(mcp);
  return mcp;
}

// 起 server。已起则返回现有 handle(单例,随主进程常驻)。
export async function startBrowserMcpServer(registerTools: ToolRegistrar = () => {}): Promise<BrowserMcpHandle> {
  if (current) return current.handle;
  const token = randomBytes(32).toString("hex");
  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res, token, registerTools);
  });
  return await new Promise<BrowserMcpHandle>((resolve) => {
    httpServer.once("error", (err) => {
      // listen 失败(端口受限/网络沙箱)→ 降级,不崩主进程。
      console.error("[browser-mcp] server listen failed:", err);
      current = null;
      resolve({ port: 0, token, serverAvailable: false });
    });
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const handle: BrowserMcpHandle = { port, token, serverAvailable: true };
      current = { http: httpServer, handle };
      resolve(handle);
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  registerTools: ToolRegistrar,
): Promise<void> {
  if (!req.url || !req.url.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  if (!originAllowed(req.headers.origin)) {
    res.writeHead(403).end();
    return;
  }
  const auth = req.headers.authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!presented || !tokensEqual(presented, token)) {
    res.writeHead(401).end();
    return;
  }
  // 无状态:每请求新建 server + transport(sessionIdGenerator: undefined;spike 已证可行)。
  const mcp = makeServer(registerTools);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  try {
    await mcp.connect(transport);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        parsed = undefined;
      }
      void transport.handleRequest(req, res, parsed);
    });
  } catch (e) {
    console.error("[browser-mcp] request error:", e);
    if (!res.headersSent) res.writeHead(500).end();
  }
}

export function stopBrowserMcpServer(): void {
  if (!current) return;
  current.http.close();
  current = null;
}

// 注入侧(U3)读取当前 server 端点 + token。null = 未起 / 不可用。
export function getBrowserMcpHandle(): BrowserMcpHandle | null {
  return current?.handle ?? null;
}
