// pi MCP 桥接的配置归一化纯函数单测。binary 引擎删除后渲染/落盘（render*/write*）用例
// 一并移除——桥接客户端行为由 pi-mcp-inproc.test.ts 覆盖。
import { describe, expect, it } from "vitest";

import { collectBridgeServers, mcpServerToBridge } from "./pi-mcp-bridge";
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
