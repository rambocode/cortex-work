// pi MCP 桥接扩展的渲染/归一纯函数单测。electron(app.getPath) + fs 全 mock(同 pi-extensions.test.ts)。
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "/userData" } }));
vi.mock("fs", () => ({ writeFileSync: h.writeFileSync, mkdirSync: h.mkdirSync }));

import {
  collectBridgeServers,
  mcpServerToBridge,
  renderMcpBridgeExtension,
  writeMcpBridgeExtension,
  type BridgeServer,
} from "./pi-mcp-bridge";
import type { McpServerConfig } from "../ipc/types";

describe("mcpServerToBridge", () => {
  it("stdio:带 command/args/cwd + envPassthrough 解析为明确 env", () => {
    process.env.__BRIDGE_TEST = "v1";
    const s: McpServerConfig = {
      id: "fs",
      transport: "stdio",
      command: "/bin/fs",
      args: ["--root", "/"],
      env: { A: "1" },
      cwd: "/code",
      envPassthrough: ["__BRIDGE_TEST", "__BRIDGE_MISSING"],
    };
    const b = mcpServerToBridge(s);
    expect(b).toEqual({
      id: "fs",
      transport: "stdio",
      command: "/bin/fs",
      args: ["--root", "/"],
      env: { A: "1", __BRIDGE_TEST: "v1" }, // 缺失的透传名跳过
      cwd: "/code",
    });
    delete process.env.__BRIDGE_TEST;
  });

  it("http:透传 url + headers", () => {
    const s: McpServerConfig = {
      id: "cortex-browser",
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "Bearer t" },
    };
    expect(mcpServerToBridge(s)).toEqual({
      id: "cortex-browser",
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("非法 id / stdio 无 command / url 缺失 → null", () => {
    expect(mcpServerToBridge({ id: "bad id", transport: "stdio", command: "/x" })).toBeNull();
    expect(mcpServerToBridge({ id: "fs", transport: "stdio" })).toBeNull();
    expect(mcpServerToBridge({ id: "remote", transport: "http" })).toBeNull();
  });
});

describe("collectBridgeServers", () => {
  it("汇总用户 server + 浏览器 server,过滤非法项,浏览器末位", () => {
    const users: McpServerConfig[] = [
      { id: "fs", transport: "stdio", command: "/bin/fs" },
      { id: "bad id", transport: "stdio", command: "/x" }, // 非法 id 过滤
    ];
    const browser: McpServerConfig = { id: "cortex-browser", transport: "http", url: "http://127.0.0.1:1/mcp" };
    const out = collectBridgeServers(users, browser);
    expect(out.map((s) => s.id)).toEqual(["fs", "cortex-browser"]);
  });

  it("无浏览器 server(null)→ 仅用户 server", () => {
    const out = collectBridgeServers([{ id: "fs", transport: "stdio", command: "/bin/fs" }], null);
    expect(out.map((s) => s.id)).toEqual(["fs"]);
  });
});

describe("renderMcpBridgeExtension", () => {
  const servers: BridgeServer[] = [{ id: "cortex-browser", transport: "http", url: "http://127.0.0.1:1/mcp" }];

  it("结构:置顶 import + 烘焙 SERVERS + async default + 关键运行时", () => {
    const src = renderMcpBridgeExtension(servers);
    // ESM import 必须置顶(在 SERVERS 之前)。
    expect(src.indexOf('import { spawn } from "node:child_process";')).toBeLessThan(src.indexOf("const SERVERS ="));
    // http 客户端走 node:http/https(非全局 fetch——pi 的 Electron utilityProcess 里 undici fetch 可能不可用)。
    expect(src).toContain('import http from "node:http";');
    expect(src).toContain('import https from "node:https";');
    expect(src).not.toContain("await fetch(");
    expect(src).toContain(`const SERVERS = ${JSON.stringify(servers)};`);
    expect(src).toContain("export default async function (pi)");
    // 两种传输 + MCP 握手 + 工具注册关键标记。
    expect(src).toContain("makeStdioClient");
    expect(src).toContain("makeHttpClient");
    expect(src).toContain('"initialize"');
    expect(src).toContain("notifications/initialized");
    expect(src).toContain('"tools/list"');
    expect(src).toContain('"tools/call"');
    expect(src).toContain("pi.registerTool");
    // Accept 头须同时含 json 与 event-stream(否则 SDK streamable transport 406)。
    expect(src).toContain("application/json, text/event-stream");
  });

  it("生成源码语法有效(去掉 ESM 专属行后可被 vm 编译)", () => {
    const src = renderMcpBridgeExtension(servers);
    const body = src
      .split("\n")
      .filter((l) => !l.startsWith("import ") && !l.startsWith("export default"))
      .join("\n");
    // 仅编译不执行,做模板语法校验(vm.Script 比 new Function 更干净且不触发 no-new-func)。
    expect(() => new Script(body)).not.toThrow();
  });
});

describe("writeMcpBridgeExtension", () => {
  it("落盘 0600 到 userData/pi-extensions/mcp-bridge.js 并返回路径", () => {
    h.writeFileSync.mockClear();
    const file = writeMcpBridgeExtension([{ id: "x", transport: "http", url: "http://h/mcp" }]);
    expect(file).toBe("/userData/pi-extensions/mcp-bridge.js");
    expect(h.writeFileSync).toHaveBeenCalledWith(file, expect.stringContaining("const SERVERS ="), { mode: 0o600 });
  });
});
