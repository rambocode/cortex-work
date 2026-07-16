// cortex-slides MCP host:独立实例(独立 port/token),只服务 Slides Workspace 回合。
// 复用 createMcpHost 通用工厂;工具集按请求头 X-Cortex-Session 查会话状态注册 ——
// 未注册的会话(普通聊天/写作/普通 Design)只拿到 ping,天然不泄漏 slides 工具。
// 注入配置形状与 design-delegate 一致(http /mcp + Bearer token + X-Cortex-Session)。
import { createMcpHost, type McpHostHandle } from "../mcp-host/server";
import type { McpServerConfig } from "../../ipc/types";
import { getSlidesSession } from "./session";
import { registerSlidesTools } from "./tools";

// 注入用 server id(= MCP server 名)。须为 TOML 裸键安全(codex -c mcp_servers.<id>)。
export const SLIDES_SERVER_ID = "cortex-slides";

const slidesHost = createMcpHost(SLIDES_SERVER_ID);
let hostStartPromise: Promise<McpHostHandle> | null = null;

export function startSlidesHost(): Promise<McpHostHandle> {
  if (slidesHost.getHandle()) return slidesHost.start();
  if (hostStartPromise) return hostStartPromise;
  hostStartPromise = slidesHost.start((mcp, ctx) => {
    const state = getSlidesSession(ctx.sessionId);
    // 无 state = 非 slides 回合(或子 agent 的 fresh sessionId)→ 不注册任何 slides 工具。
    if (!state) return;
    registerSlidesTools(mcp, state);
  });
  hostStartPromise.finally(() => {
    hostStartPromise = null;
  });
  return hostStartPromise;
}

export function stopSlidesHost(): void {
  hostStartPromise = null;
  slidesHost.stop();
}

export function getSlidesHostHandle(): McpHostHandle | null {
  return slidesHost.getHandle();
}

// 注入配置构建(纯函数)。host 未起/不可用 → null(注入侧据此不注入)。
export function buildSlidesMcpServerConfig(sessionId: string | undefined): McpServerConfig | null {
  if (!sessionId) return null;
  const handle = slidesHost.getHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;
  return {
    id: SLIDES_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "X-Cortex-Session": sessionId,
    },
  };
}

export async function ensureSlidesMcpServerConfig(sessionId: string | undefined): Promise<McpServerConfig | null> {
  if (!sessionId) return null;
  let cfg = buildSlidesMcpServerConfig(sessionId);
  if (cfg) return cfg;
  const handle = await startSlidesHost();
  if (!handle.serverAvailable) return null;
  cfg = buildSlidesMcpServerConfig(sessionId);
  return cfg;
}
