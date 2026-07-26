// MCP 声明式注入(U2)。纯逻辑 + 基于 fs 的 apply,不 import electron(便于单测,同 session-trim.ts 模式)。
// 策略由 AgentDef.mcpInjection 能力位决定,公共管线(cli.ts)在 spawn 前调用本模块。
//
// 严格 gate(安全红线 RISK-2):**绝不覆盖/删除用户自己的 .mcp.json**。app 自写 .mcp.json 时,在旁边
// 写一个标记文件 .mcp.json.cortex,内容 = 所写 .mcp.json 的内容哈希。判定「app 所有」要求:标记存在
// **且**当前 .mcp.json 的内容哈希与标记记录一致 —— 即文件自 app 写入后未被用户改动。一旦用户编辑过
// (哈希不匹配)或无标记,均视为用户文件,一律不碰(不写、不删、不注入)。写入用 `wx`/原子方式并在
// 删除前复核哈希,关闭 existsSync→write 之间的 TOCTOU 窗口。
//
// 密钥安全:写入的 .mcp.json 可能含 env/headers 明文且落在用户项目目录(常是 git 仓库),故写入时同步
// 确保 cwd/.gitignore 含 .mcp.json 与标记,避免误提交。

import { createHash } from "crypto";
import { existsSync, promises as fsp } from "fs";
import { join } from "path";
import type { McpServerConfig, McpSettings } from "./types";

const MCP_FILE = ".mcp.json";
const MCP_MARKER = ".mcp.json.cortex"; // 内容 = app 所写 .mcp.json 的哈希
const GITIGNORE = ".gitignore";

// 轻量路径(oneshot 标题/日报、ask 追问、automation)给 codex 的「清空 MCP」mcpArgs:沿用 M1 的
// clean-slate,避免快任务加载用户 ~/.codex 的重 MCP server 拖慢/卡住。仅主会话按总开关注入。
// claude/pi 的 buildArgs 忽略 mcpArgs,传入无副作用。
export const CODEX_MCP_CLEAR: string[] = ["-c", "mcp_servers={}"];

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// server id 校验:用作 codex dotted TOML key 段与 claude/codex 的 server 名,必须是 TOML 裸键安全字符,
// 否则会错位或破坏解析(安全/健壮性)。非法 id 一律跳过注入。
export function isValidServerId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

// 有效 env = 显式 env 叠加「环境变量传递」(envPassthrough)从宿主 process.env 解析的值。
// 透传名缺失于宿主则跳过。结果写入的 .mcp.json 已被 ensureGitignore 加入忽略,故解析值落盘可接受。
// 导出复用:pi MCP 桥接(pi-mcp-bridge)也按同样规则解析 stdio server 的 env 后烘焙进扩展。
export function effectiveEnv(s: McpServerConfig): Record<string, string> | undefined {
  const env: Record<string, string> = { ...(s.env ?? {}) };
  for (const name of s.envPassthrough ?? []) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return Object.keys(env).length ? env : undefined;
}

// claude 的 .mcp.json 内容:{ mcpServers: { <id>: {command,args,env,cwd} | {type,url,headers} } }。
// 非法 id 跳过。sse/http 带 type 字段(claude 远程 server 需要),否则会被误判为 stdio。
export function buildClaudeMcpJson(servers: McpServerConfig[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    if (!isValidServerId(s.id)) continue;
    if (s.transport === "stdio") {
      const env = effectiveEnv(s);
      mcpServers[s.id] = {
        command: s.command,
        ...(s.args ? { args: s.args } : {}),
        ...(env ? { env } : {}),
        ...(s.cwd ? { cwd: s.cwd } : {}),
      };
    } else {
      mcpServers[s.id] = { type: s.transport, url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

// codex 经 -c 注入(dotted path,值按 TOML 解析;实测 `codex exec -c mcp_servers.<id>.command="..."`)。
// 取代 M1 的 `-c mcp_servers={}` 清空。非法 id 跳过。stdio 用 command/args/env;sse/http 用 url + http_headers(鉴权头)。
//
// builtinIds:内置 server(cortex-slides / design-delegate / 浏览器控制等)的 id 清单,会额外拿到
// `default_tools_approval_mode="approve"` 预授权。**必须有**:codex 0.145 对 MCP 工具调用有一道
// 独立于 shell 的审批闸(core/src/mcp_tool_call.rs 的 mcp_tool_call_approval),而 `codex exec` 是
// 非交互的 —— 没人应答就判成 `user cancelled MCP tool call`,内置工具一次都调不成(用户实测:
// 演示文稿里 get_deck_state 被取消,改不动任何东西)。approval_policy=never 管的是 shell 审批,
// 不覆盖这条路径。claude 侧的对等物是 buildArgs 的 `--allowed-tools mcp__<id>`。
// 取值枚举经 codex 自身校验确认为 auto | prompt | writes | approve。
// 只预授权内置 server:用户自配的第三方 MCP 仍按用户自己的 codex 配置走,不替他放行。
export function buildCodexMcpArgs(settings: McpSettings, builtinIds: readonly string[] = []): string[] {
  if (!settings.enabled || settings.servers.length === 0) return [];
  const builtin = new Set(builtinIds);
  const out: string[] = [];
  const push = (key: string, tomlValue: string) => out.push("-c", `${key}=${tomlValue}`);
  for (const s of settings.servers) {
    if (!isValidServerId(s.id)) continue;
    const base = `mcp_servers.${s.id}`;
    if (builtin.has(s.id)) push(`${base}.default_tools_approval_mode`, '"approve"');
    if (s.transport === "stdio") {
      if (s.command) push(`${base}.command`, JSON.stringify(s.command)); // TOML 基本字符串
      if (s.args?.length) push(`${base}.args`, JSON.stringify(s.args)); // TOML 字符串数组
      const env = effectiveEnv(s);
      if (env) push(`${base}.env`, tomlInlineTable(env));
      if (s.cwd) push(`${base}.cwd`, JSON.stringify(s.cwd));
    } else if (s.url) {
      push(`${base}.url`, JSON.stringify(s.url));
      // http/sse 鉴权头:codex streamable-http 原生支持 mcp_servers.<id>.http_headers(spike 已证)。
      // 浏览器控制 server 的 Bearer token 经此发,与 claude 的 headers 对齐(不进 URL)。
      if (s.headers && Object.keys(s.headers).length) push(`${base}.http_headers`, tomlInlineTable(s.headers));
    }
  }
  return out;
}

// 把 {K:"v"} 编码为 TOML 行内表 `{ "K" = "v" }`。键也用 JSON.stringify 转义(env 名含特殊字符时仍合法)。
function tomlInlineTable(obj: Record<string, string>): string {
  const entries = Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return `{ ${entries.join(", ")} }`;
}

export type ClaudeMcpAction = "write" | "clean" | "skip";

// 纯决策(便于单测)。appManaged = 标记存在且文件内容哈希与标记一致(自 app 写入后未被用户改动)。
export function decideClaudeMcpAction(input: {
  enabled: boolean;
  serverCount: number;
  hasMcpFile: boolean;
  appManaged: boolean;
}): ClaudeMcpAction {
  const userOwned = input.hasMcpFile && !input.appManaged; // 无标记 或 内容已被用户改动
  if (userOwned) return "skip"; // 用户自有/已改动文件:一律不碰
  if (input.enabled && input.serverCount > 0) return "write"; // 注入(无用户文件)
  return input.appManaged ? "clean" : "skip"; // 关/空:清自写 stale,否则无事
}

// 判定某 cwd 的 .mcp.json 是否「app 所有且未被改动」:标记存在 + 当前文件哈希 == 标记记录哈希。
async function isAppManaged(filePath: string, markerPath: string): Promise<boolean> {
  if (!existsSync(markerPath) || !existsSync(filePath)) return false;
  try {
    const [recorded, current] = await Promise.all([fsp.readFile(markerPath, "utf8"), fsp.readFile(filePath, "utf8")]);
    return recorded.trim() === sha256(current);
  } catch {
    return false;
  }
}

// 写入时确保 cwd/.gitignore 含 .mcp.json 与标记(避免把含密钥的注入文件误提交)。best-effort。
async function ensureGitignore(cwd: string): Promise<void> {
  const path = join(cwd, GITIGNORE);
  try {
    let content = existsSync(path) ? await fsp.readFile(path, "utf8") : "";
    const lines = new Set(content.split("\n").map((l) => l.trim()));
    const want = [MCP_FILE, MCP_MARKER].filter((e) => !lines.has(e));
    if (want.length === 0) return;
    if (content && !content.endsWith("\n")) content += "\n";
    content += `# Cortex Desktop MCP(自动注入,勿提交)\n${want.join("\n")}\n`;
    await fsp.writeFile(path, content, "utf8");
  } catch {
    /* .gitignore 写失败不阻断 */
  }
}

// 对某 cwd 执行 claude MCP 注入/清理(严格 gate + 原子/防 TOCTOU)。返回执行的动作,便于诊断与测试。
export async function applyClaudeMcp(cwd: string, settings: McpSettings): Promise<ClaudeMcpAction> {
  const filePath = join(cwd, MCP_FILE);
  const markerPath = join(cwd, MCP_MARKER);
  const appManaged = await isAppManaged(filePath, markerPath);
  const validServers = settings.servers.filter((s) => isValidServerId(s.id));
  const action = decideClaudeMcpAction({
    enabled: settings.enabled,
    serverCount: validServers.length,
    hasMcpFile: existsSync(filePath),
    appManaged,
  });
  if (action === "write") {
    const content = buildClaudeMcpJson(validServers);
    // 'wx' 排他写:若 write 决策基于「文件不存在」,但写入瞬间已被他人创建 → EEXIST,改判用户文件 → 放弃。
    try {
      await fsp.writeFile(filePath, content, { encoding: "utf8", flag: appManaged ? "w" : "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return "skip"; // TOCTOU:窗口内出现用户文件,不覆盖
      throw e;
    }
    await fsp.writeFile(markerPath, sha256(content) + "\n", "utf8"); // 记录内容哈希
    await ensureGitignore(cwd);
  } else if (action === "clean") {
    // 删除前再复核 app 所有(标记+哈希),避免删到窗口内被改动/替换的文件。
    if (await isAppManaged(filePath, markerPath)) {
      await fsp.rm(filePath, { force: true });
    }
    await fsp.rm(markerPath, { force: true });
  }
  return action;
}
