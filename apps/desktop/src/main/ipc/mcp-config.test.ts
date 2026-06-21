// mcp-config 单测:claude .mcp.json 内容 + codex -c 构造 + 严格 gate 决策 + apply(真实 tmp dir)。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyClaudeMcp,
  buildClaudeMcpJson,
  buildCodexMcpArgs,
  decideClaudeMcpAction,
} from "./mcp-config";
import type { McpServerConfig, McpSettings } from "./types";

const stdio: McpServerConfig = { id: "fs", transport: "stdio", command: "/bin/fs", args: ["--root", "/p"], env: { TOKEN: "x" } };
const http: McpServerConfig = { id: "web", transport: "http", url: "https://mcp.example/sse" };

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-mcp-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildClaudeMcpJson", () => {
  it("stdio + http 映射为 mcpServers 形状", () => {
    const json = JSON.parse(buildClaudeMcpJson([stdio, http]));
    expect(json.mcpServers.fs).toEqual({ command: "/bin/fs", args: ["--root", "/p"], env: { TOKEN: "x" } });
    expect(json.mcpServers.web).toEqual({ url: "https://mcp.example/sse" });
  });
});

describe("buildCodexMcpArgs", () => {
  it("关 / 空清单 → 无注入", () => {
    expect(buildCodexMcpArgs({ enabled: false, servers: [stdio] })).toEqual([]);
    expect(buildCodexMcpArgs({ enabled: true, servers: [] })).toEqual([]);
  });

  it("stdio → -c command/args/env(值为 TOML)", () => {
    const out = buildCodexMcpArgs({ enabled: true, servers: [stdio] });
    expect(out).toContain('mcp_servers.fs.command="/bin/fs"');
    expect(out).toContain('mcp_servers.fs.args=["--root","/p"]');
    expect(out).toContain('mcp_servers.fs.env={ TOKEN = "x" }');
    expect(out.filter((a) => a === "-c").length).toBe(3);
  });

  it("http → -c url", () => {
    expect(buildCodexMcpArgs({ enabled: true, servers: [http] })).toEqual(["-c", 'mcp_servers.web.url="https://mcp.example/sse"']);
  });
});

describe("decideClaudeMcpAction(严格 gate)", () => {
  it("用户自有 .mcp.json(无标记)→ skip,绝不碰", () => {
    expect(decideClaudeMcpAction({ enabled: true, serverCount: 1, hasMcpFile: true, hasMarker: false })).toBe("skip");
  });
  it("启用 + 有 server + 无文件 → write", () => {
    expect(decideClaudeMcpAction({ enabled: true, serverCount: 1, hasMcpFile: false, hasMarker: false })).toBe("write");
  });
  it("关 + app 自写(有标记)→ clean", () => {
    expect(decideClaudeMcpAction({ enabled: false, serverCount: 0, hasMcpFile: true, hasMarker: true })).toBe("clean");
  });
  it("关 + 无 app 文件 → skip(无事)", () => {
    expect(decideClaudeMcpAction({ enabled: false, serverCount: 0, hasMcpFile: false, hasMarker: false })).toBe("skip");
  });
});

describe("applyClaudeMcp(真实 fs)", () => {
  const on: McpSettings = { enabled: true, servers: [stdio] };

  it("启用无用户文件 → 写 .mcp.json + 标记", async () => {
    const cwd = tmp();
    expect(await applyClaudeMcp(cwd, on)).toBe("write");
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".mcp.json.cortex"))).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers.fs.command).toBe("/bin/fs");
  });

  it("用户自有 .mcp.json(无标记)→ skip,文件原样不动(安全红线)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ".mcp.json"), '{"mcpServers":{"mine":{"command":"x"}}}', "utf8");
    expect(await applyClaudeMcp(cwd, on)).toBe("skip");
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain('"mine"'); // 未被覆盖
    expect(existsSync(join(cwd, ".mcp.json.cortex"))).toBe(false);
  });

  it("关 + 之前 app 写过 → clean 两个文件;用户文件场景不受影响", async () => {
    const cwd = tmp();
    await applyClaudeMcp(cwd, on); // 先写
    expect(await applyClaudeMcp(cwd, { enabled: false, servers: [] })).toBe("clean");
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, ".mcp.json.cortex"))).toBe(false);
  });
});
