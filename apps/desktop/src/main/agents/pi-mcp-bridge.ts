// pi MCP 桥接的**配置归一化**层（纯函数，无 IO）。
//
// 背景:pi 核心不内置 MCP 协议;claude/codex 经 mcp-config.ts 原生注入(.mcp.json / -c)。
// pi 的 MCP 能力由 `agents/pi-mcp-inproc.ts` 在进程内直连（stdio spawn + http fetch），
// 本文件只负责把 `McpServerConfig`（用户配置 / 内置 capability server）归一成桥接消费的
// `BridgeServer` 形状：stdio 解析 env、http/sse 透传 url+headers、非法条目剔除。
//
// 历史：binary 路径时期这里还负责把桥接客户端渲染成 .js extension 落盘
// `userData/pi-extensions/` 供二进制 `-e` 加载（writeMcpBridgeExtension）。二进制删除后
// 渲染与落盘部分一并删除——`BridgeServer` 列表现在以结构化数据交给
// `createMcpInProcTools`（长驻会话在 gateway worker 侧、单发在 oneshot.ts 内）原生注册。

import type { McpServerConfig } from "../ipc/types";
import { effectiveEnv } from "../ipc/mcp-config";
import { isValidServerId } from "../ipc/mcp-config";

// 桥接消费的「桥接 server」形状:cortex 侧把 McpServerConfig(stdio 的 env 已解析为明确值)与
// 浏览器 server(url+headers)归一到此,经 open 参数（PiOpenRequest.bridgeServers）跨进程传递。
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
