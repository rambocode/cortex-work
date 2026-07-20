import { describe, expect, it } from "vitest";

import type { McpSettings } from "../../ipc/types";
import {
  AGENT_BROWSER_MCP_SERVER_ID,
  buildAgentBrowserMcpServerConfig,
  migrateLegacyAgentBrowserMcp,
} from "./inject";

describe("内置 agent-browser MCP", () => {
  it("默认启用并使用内置绝对路径、全部工具和会话隔离", () => {
    const cfg = buildAgentBrowserMcpServerConfig(undefined, "sess:1/unsafe", "/app/resources/agent-browser");

    expect(cfg).toEqual({
      id: AGENT_BROWSER_MCP_SERVER_ID,
      label: "Agent Browser（内置）",
      transport: "stdio",
      command: "/app/resources/agent-browser",
      args: ["mcp", "--tools", "all"],
      env: {
        AGENT_BROWSER_SESSION: "cortex-sess_1_unsafe",
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
      },
    });
  });

  it("关闭或内置二进制不可用时不注入", () => {
    expect(buildAgentBrowserMcpServerConfig({ enabled: false }, "s1", "/bin/agent-browser")).toBeNull();
    expect(buildAgentBrowserMcpServerConfig({ enabled: true }, "s1", null)).toBeNull();
  });

  it("移除完全匹配的旧全局配置，保留其它 server", () => {
    const mcp: McpSettings = {
      enabled: true,
      servers: [
        { id: "agent-browser", transport: "stdio", command: "agent-browser", args: ["mcp"] },
        { id: "fs", transport: "stdio", command: "/bin/fs" },
      ],
    };

    expect(migrateLegacyAgentBrowserMcp(mcp)).toEqual({
      enabled: true,
      servers: [{ id: "fs", transport: "stdio", command: "/bin/fs" }],
    });
  });

  it("同名自定义配置改为无冲突 id，迁移幂等", () => {
    const mcp: McpSettings = {
      enabled: true,
      servers: [
        { id: "agent-browser", label: "远程浏览器", transport: "stdio", command: "custom-browser", args: ["serve"] },
        { id: "agent-browser-user", transport: "http", url: "https://example.test/mcp" },
      ],
    };

    const once = migrateLegacyAgentBrowserMcp(mcp);
    expect(once.servers[0]).toMatchObject({ id: "agent-browser-user-2", label: "远程浏览器" });
    expect(migrateLegacyAgentBrowserMcp(once)).toEqual(once);
  });
});
