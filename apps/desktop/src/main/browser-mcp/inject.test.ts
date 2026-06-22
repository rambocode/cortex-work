import { afterEach, describe, expect, it } from "vitest";

import { BROWSER_MCP_SERVER_ID, buildBrowserMcpServerConfig } from "./inject";
import { startBrowserMcpServer, stopBrowserMcpServer } from "./server";

const ON: { enabled: boolean; cdpEnabled: boolean; approvedOrigins: string[] } = {
  enabled: true,
  cdpEnabled: false,
  approvedOrigins: [],
};

describe("浏览器控制 server 注入（U3）", () => {
  afterEach(() => stopBrowserMcpServer());

  it("总开关关 / 缺配置 → null", () => {
    expect(buildBrowserMcpServerConfig(undefined)).toBeNull();
    expect(buildBrowserMcpServerConfig({ ...ON, enabled: false })).toBeNull();
  });

  it("总开关开但 server 未起 → null", () => {
    expect(buildBrowserMcpServerConfig(ON)).toBeNull();
  });

  it("总开关开 + server 可用 → http server config,token 经 Authorization 头(不进 URL)", async () => {
    const { port, token } = await startBrowserMcpServer();
    const cfg = buildBrowserMcpServerConfig(ON);
    expect(cfg).not.toBeNull();
    expect(cfg!.id).toBe(BROWSER_MCP_SERVER_ID);
    expect(cfg!.transport).toBe("http");
    expect(cfg!.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(cfg!.url).not.toContain(token); // token 不进 URL
    expect(cfg!.headers).toEqual({ Authorization: `Bearer ${token}` });
  });
});
