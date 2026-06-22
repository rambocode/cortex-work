// mcp-config 单测:claude .mcp.json 内容 + codex -c 构造 + 严格 gate(内容哈希)+ apply(真实 tmp dir)。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyClaudeMcp,
  buildClaudeMcpJson,
  buildCodexMcpArgs,
  decideClaudeMcpAction,
  isValidServerId,
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

describe("isValidServerId", () => {
  it("仅接受 TOML 裸键安全字符", () => {
    expect(isValidServerId("fs")).toBe(true);
    expect(isValidServerId("my-server_2")).toBe(true);
    for (const bad of ["a.b", "x=y", "a b", 'q"x', "", "a/b"]) expect(isValidServerId(bad)).toBe(false);
  });
});

describe("buildClaudeMcpJson", () => {
  it("stdio + http 映射;http 带 type 字段;跳过非法 id", () => {
    const json = JSON.parse(buildClaudeMcpJson([stdio, http, { id: "x.y", transport: "stdio", command: "z" }]));
    expect(json.mcpServers.fs).toEqual({ command: "/bin/fs", args: ["--root", "/p"], env: { TOKEN: "x" } });
    expect(json.mcpServers.web).toEqual({ type: "http", url: "https://mcp.example/sse" });
    expect(json.mcpServers["x.y"]).toBeUndefined(); // 非法 id 跳过
  });

  it("stdio 带 cwd + envPassthrough → cwd 写入,透传名从 process.env 解析并入 env", () => {
    process.env.__MCP_PASS_TEST = "pv";
    const json = JSON.parse(
      buildClaudeMcpJson([{ id: "fs", transport: "stdio", command: "/bin/fs", env: { A: "1" }, cwd: "~/code", envPassthrough: ["__MCP_PASS_TEST", "__MCP_MISSING"] }]),
    );
    expect(json.mcpServers.fs.cwd).toBe("~/code");
    expect(json.mcpServers.fs.env).toEqual({ A: "1", __MCP_PASS_TEST: "pv" }); // 缺失的透传名跳过
    delete process.env.__MCP_PASS_TEST;
  });
});

describe("buildCodexMcpArgs", () => {
  it("关 / 空清单 → 无注入", () => {
    expect(buildCodexMcpArgs({ enabled: false, servers: [stdio] })).toEqual([]);
    expect(buildCodexMcpArgs({ enabled: true, servers: [] })).toEqual([]);
  });

  it("stdio → -c command/args/env(值 TOML;env key 也转义)", () => {
    const out = buildCodexMcpArgs({ enabled: true, servers: [stdio] });
    expect(out).toContain('mcp_servers.fs.command="/bin/fs"');
    expect(out).toContain('mcp_servers.fs.args=["--root","/p"]');
    expect(out).toContain('mcp_servers.fs.env={ "TOKEN" = "x" }');
  });

  it("stdio cwd → -c mcp_servers.<id>.cwd", () => {
    const out = buildCodexMcpArgs({ enabled: true, servers: [{ id: "fs", transport: "stdio", command: "/bin/fs", cwd: "~/code" }] });
    expect(out).toContain('mcp_servers.fs.cwd="~/code"');
  });

  it("http → -c url;非法 id 跳过(不产生错位 dotted key)", () => {
    expect(buildCodexMcpArgs({ enabled: true, servers: [http] })).toEqual(["-c", 'mcp_servers.web.url="https://mcp.example/sse"']);
    expect(buildCodexMcpArgs({ enabled: true, servers: [{ id: "a.b", transport: "stdio", command: "z" }] })).toEqual([]);
  });

  it("http 带 headers → -c http_headers(浏览器控制 token 经此发)", () => {
    const out = buildCodexMcpArgs({
      enabled: true,
      servers: [{ id: "cortex-browser", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer tok" } }],
    });
    expect(out).toContain('mcp_servers.cortex-browser.url="http://127.0.0.1:9/mcp"');
    expect(out).toContain('mcp_servers.cortex-browser.http_headers={ "Authorization" = "Bearer tok" }');
  });
});

describe("decideClaudeMcpAction(严格 gate)", () => {
  it("用户自有/已改动(非 appManaged)→ skip", () => {
    expect(decideClaudeMcpAction({ enabled: true, serverCount: 1, hasMcpFile: true, appManaged: false })).toBe("skip");
  });
  it("启用 + 有 server + 无文件 → write", () => {
    expect(decideClaudeMcpAction({ enabled: true, serverCount: 1, hasMcpFile: false, appManaged: false })).toBe("write");
  });
  it("关 + app 所有 → clean", () => {
    expect(decideClaudeMcpAction({ enabled: false, serverCount: 0, hasMcpFile: true, appManaged: true })).toBe("clean");
  });
  it("关 + 无 app 文件 → skip", () => {
    expect(decideClaudeMcpAction({ enabled: false, serverCount: 0, hasMcpFile: false, appManaged: false })).toBe("skip");
  });
});

describe("applyClaudeMcp(真实 fs,内容哈希 gate)", () => {
  const on: McpSettings = { enabled: true, servers: [stdio] };

  it("启用无用户文件 → 写 .mcp.json + 哈希标记 + .gitignore", async () => {
    const cwd = tmp();
    expect(await applyClaudeMcp(cwd, on)).toBe("write");
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".mcp.json.cortex"))).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers.fs.command).toBe("/bin/fs");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain(".mcp.json");
  });

  it("用户自有 .mcp.json(无标记)→ skip,文件原样不动(安全红线)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ".mcp.json"), '{"mcpServers":{"mine":{"command":"x"}}}', "utf8");
    expect(await applyClaudeMcp(cwd, on)).toBe("skip");
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain('"mine"');
    expect(existsSync(join(cwd, ".mcp.json.cortex"))).toBe(false);
  });

  it("app 写过、用户随后改动(哈希不匹配)→ write 时 skip 不覆盖;disable 时不删除", async () => {
    const cwd = tmp();
    await applyClaudeMcp(cwd, on); // app 写
    // 用户编辑 .mcp.json(标记仍在,但内容哈希不再匹配)
    writeFileSync(join(cwd, ".mcp.json"), '{"mcpServers":{"mine":{"command":"y"}}}', "utf8");
    // 再次启用(servers 变化)→ 应识别为用户改动,skip 不覆盖
    expect(await applyClaudeMcp(cwd, { enabled: true, servers: [stdio, http] })).toBe("skip");
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain('"mine"');
    // 关闭 → 不删用户改动过的文件
    expect(await applyClaudeMcp(cwd, { enabled: false, servers: [] })).toBe("skip");
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
  });

  it("关 + 之前 app 写过且未改动 → clean 两个文件", async () => {
    const cwd = tmp();
    await applyClaudeMcp(cwd, on);
    expect(await applyClaudeMcp(cwd, { enabled: false, servers: [] })).toBe("clean");
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, ".mcp.json.cortex"))).toBe(false);
  });
});
