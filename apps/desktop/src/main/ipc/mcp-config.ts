// MCP 声明式注入(U2)。纯逻辑 + 基于 fs 的 apply,不 import electron(便于单测,同 session-trim.ts 模式)。
// 策略由 AgentDef.mcpInjection 能力位决定,公共管线(cli.ts)在 spawn 前调用本模块。
//
// 严格 gate(安全红线 RISK-2):**绝不覆盖用户自己的 .mcp.json**。app 自写的 .mcp.json 旁边放一个
// sentinel 标记文件(.mcp.json.cortex);判定:
//   - 存在 .mcp.json 且无标记 → 用户自有文件,一律不碰(不写、不删、不注入);
//   - 存在标记 → app 自写,可改写 / 清理。
// 关态语义(用户决定):总开关关时不注入不覆盖 —— claude 原生加载用户 cwd .mcp.json(若有)、
// codex 原生继承 ~/.codex 配置;app 只清理自己之前写的 stale。

import { existsSync, promises as fsp } from "fs";
import { join } from "path";
import type { McpServerConfig, McpSettings } from "./types";

const MCP_FILE = ".mcp.json";
const MCP_MARKER = ".mcp.json.cortex"; // app 自写标记;有它才允许接管/清理 .mcp.json

// claude 的 .mcp.json 内容:{ mcpServers: { <id>: {command,args,env} | {url,headers} } }。
export function buildClaudeMcpJson(servers: McpServerConfig[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.id] =
      s.transport === "stdio"
        ? { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) }
        : { url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

// codex 经 -c 注入(dotted path,值按 TOML 解析;实测 `codex exec -c mcp_servers.<id>.command="..."`)。
// 取代 M1 的 `-c mcp_servers={}` 清空。stdio 用 command/args/env;sse/http 用 url。
export function buildCodexMcpArgs(settings: McpSettings): string[] {
  if (!settings.enabled || settings.servers.length === 0) return [];
  const out: string[] = [];
  const push = (key: string, tomlValue: string) => out.push("-c", `${key}=${tomlValue}`);
  for (const s of settings.servers) {
    const base = `mcp_servers.${s.id}`;
    if (s.transport === "stdio") {
      if (s.command) push(`${base}.command`, JSON.stringify(s.command)); // TOML 基本字符串
      if (s.args?.length) push(`${base}.args`, JSON.stringify(s.args)); // TOML 字符串数组
      if (s.env && Object.keys(s.env).length) push(`${base}.env`, tomlInlineTable(s.env));
    } else if (s.url) {
      push(`${base}.url`, JSON.stringify(s.url));
    }
  }
  return out;
}

// 把 {K:"v"} 编码为 TOML 行内表 `{ K = "v" }`。
function tomlInlineTable(obj: Record<string, string>): string {
  const entries = Object.entries(obj).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return `{ ${entries.join(", ")} }`;
}

export type ClaudeMcpAction = "write" | "clean" | "skip";

// 纯决策(便于单测):给定开关/清单与 cwd 文件现状,决定对 .mcp.json 的动作。
export function decideClaudeMcpAction(input: {
  enabled: boolean;
  serverCount: number;
  hasMcpFile: boolean;
  hasMarker: boolean;
}): ClaudeMcpAction {
  const appManaged = input.hasMarker;
  const userOwned = input.hasMcpFile && !appManaged;
  if (userOwned) return "skip"; // 用户自有文件:一律不碰
  if (input.enabled && input.serverCount > 0) return "write"; // 注入(无用户文件)
  return appManaged ? "clean" : "skip"; // 关/空:清自写 stale,否则无事
}

// 对某 cwd 执行 claude MCP 注入/清理(严格 gate)。返回执行的动作,便于诊断与测试。
export async function applyClaudeMcp(cwd: string, settings: McpSettings): Promise<ClaudeMcpAction> {
  const filePath = join(cwd, MCP_FILE);
  const markerPath = join(cwd, MCP_MARKER);
  const action = decideClaudeMcpAction({
    enabled: settings.enabled,
    serverCount: settings.servers.length,
    hasMcpFile: existsSync(filePath),
    hasMarker: existsSync(markerPath),
  });
  if (action === "write") {
    await fsp.writeFile(filePath, buildClaudeMcpJson(settings.servers), "utf8");
    await fsp.writeFile(markerPath, "cortex-managed\n", "utf8"); // 标记 app 所有
  } else if (action === "clean") {
    await fsp.rm(filePath, { force: true });
    await fsp.rm(markerPath, { force: true });
  }
  return action;
}
