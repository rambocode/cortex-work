// 浏览器控制 server 注入(U3):据总开关 + server 可用性,构造内置浏览器 MCP server 的注入配置。
// 复用现有 MCP 注入接线(buildClaudeMcpJson / buildCodexMcpArgs),由 cli.ts 在主会话注入分流前
// 并入 mcp.servers。鉴权:token 经 Authorization 头(claude headers / codex http_headers),
// **不进 URL**(避免泄进日志/进程参数)。
import type { BrowserControlSettings, McpServerConfig } from "../../ipc/types";
import { getMcpHostHandle } from "../mcp-host/server";

// 注入用的 server id(= MCP server 名)。须为 TOML 裸键安全(见 mcp-config.isValidServerId)。
export const BROWSER_MCP_SERVER_ID = "cortex-browser";

// 总开关关 / server 未起或不可用 → null(不注入,避免给 agent 一个连不上的 url)。
// sessionId(cli 会话)经 X-Cortex-Session 头注入,供 server 归属仲裁(U5/KTD9)。
export function buildBrowserMcpServerConfig(
  bc: BrowserControlSettings | undefined,
  sessionId?: string,
): McpServerConfig | null {
  if (!bc?.enabled) return null;
  const handle = getMcpHostHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;
  return {
    id: BROWSER_MCP_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      ...(sessionId ? { "X-Cortex-Session": sessionId } : {}),
    },
  };
}
