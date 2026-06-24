// 随主进程常驻的 Streamable HTTP MCP server。agent(claude/codex)经注入的 url(/mcp,带
// Authorization: Bearer <token>)连入;tool handler 在主进程直接驱动能力(浏览器 guest / 文档抽取)。
//
// 多实例(KTD2/U5):浏览器控制与文档抽取**各起一个独立实例**(各自 port/token),不共用——
// 因为浏览器工具仅靠「是否注入」门控、不在调用时自检开关,若共用 host 并为文档抽取始终注入,
// 会在浏览器控制关闭时泄漏浏览器工具。createMcpHost() 是通用工厂;浏览器沿用默认单例实例
// (startMcpHost/stopMcpHost/getMcpHostHandle 行为不变),文档抽取经 createMcpHost 起自己的实例。
//
// 跨进程契约:server 端点形状(http /mcp + Bearer token + 无状态 Streamable HTTP)与注入侧
// (buildClaudeMcpJson headers / buildCodexMcpArgs http_headers / pi 桥接)必须一致。
// 鉴权:Authorization: Bearer <token>(crypto 随机 + 常量时间比较),叠加 Origin 校验
// (agent CLI 的 HTTP 客户端不带浏览器 Origin;带真实 Origin 的请求一律挡——防本地网页 DNS-rebinding)。
// 生命周期随主进程(index.ts whenReady 起、before-quit 停);listen 失败降级不崩(serverAvailable=false)。
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface McpHostHandle {
  port: number;
  token: string;
  // listen 失败时 false:注入侧据此不注入,避免给 agent 一个连不上的 url。
  serverAvailable: boolean;
}

// 工具注册钩子:经此注入实际工具(浏览器 / 文档抽取);缺省仅 ping。
// 每请求上下文:调用会话标识(经 X-Cortex-Session 头,供归属仲裁 / 会话隔离)。
export interface ToolContext {
  sessionId: string | null;
}
export type ToolRegistrar = (mcp: McpServer, ctx: ToolContext) => void;

export interface McpHost {
  // 起 server。已起则返回现有 handle(实例级单例,随主进程常驻)。
  start(registerTools?: ToolRegistrar): Promise<McpHostHandle>;
  stop(): void;
  // 注入侧读取当前 server 端点 + token。null = 未起 / 不可用。
  getHandle(): McpHostHandle | null;
}

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

// 通用工厂:每个能力起一个独立实例(独立 port/token/生命周期)。serverName = MCP server 名。
export function createMcpHost(serverName: string): McpHost {
  let current: { http: http.Server; handle: McpHostHandle } | null = null;

  function makeServer(registerTools: ToolRegistrar, ctx: ToolContext): McpServer {
    const mcp = new McpServer({ name: serverName, version: "1.0.0" });
    // ping:连通性占位;实际工具由 registerTools 注入。
    mcp.registerTool("ping", { description: "连通性检查,返回 pong。", inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }));
    registerTools(mcp, ctx);
    return mcp;
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
    // 调用会话标识(供归属仲裁 / 会话隔离):X-Cortex-Session 头由 inject 按 cli 会话 id 注入。
    const sidHeader = req.headers["x-cortex-session"];
    const sessionId = typeof sidHeader === "string" ? sidHeader : null;
    // 无状态:每请求新建 server + transport(sessionIdGenerator: undefined)。
    const mcp = makeServer(registerTools, { sessionId });
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
      console.error(`[mcp-host:${serverName}] request error:`, e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  async function start(registerTools: ToolRegistrar = () => {}): Promise<McpHostHandle> {
    if (current) return current.handle;
    const token = randomBytes(32).toString("hex");
    const httpServer = http.createServer((req, res) => {
      void handleRequest(req, res, token, registerTools);
    });
    return await new Promise<McpHostHandle>((resolve) => {
      httpServer.once("error", (err) => {
        // listen 失败(端口受限/网络沙箱)→ 降级,不崩主进程。
        console.error(`[mcp-host:${serverName}] server listen failed:`, err);
        current = null;
        resolve({ port: 0, token, serverAvailable: false });
      });
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const handle: McpHostHandle = { port, token, serverAvailable: true };
        current = { http: httpServer, handle };
        resolve(handle);
      });
    });
  }

  function stop(): void {
    if (!current) return;
    current.http.close();
    current = null;
  }

  function getHandle(): McpHostHandle | null {
    return current?.handle ?? null;
  }

  return { start, stop, getHandle };
}

// 默认实例 = 浏览器控制 host(行为与原先完全一致;名称 cortex-browser)。
const browserHost = createMcpHost("cortex-browser");
export const startMcpHost = browserHost.start;
export const stopMcpHost = browserHost.stop;
export const getMcpHostHandle = browserHost.getHandle;
