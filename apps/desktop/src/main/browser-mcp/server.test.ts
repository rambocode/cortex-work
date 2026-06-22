import { afterEach, describe, expect, it } from "vitest";

import { startBrowserMcpServer, stopBrowserMcpServer } from "./server";

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

function postInit(port: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: INIT_BODY,
  });
}

describe("浏览器控制 MCP server（U2）", () => {
  afterEach(() => stopBrowserMcpServer());

  it("带正确 Bearer token 的 initialize 返回 200 + 合法 MCP 结果", async () => {
    const { port, token, serverAvailable } = await startBrowserMcpServer();
    expect(serverAvailable).toBe(true);
    expect(port).toBeGreaterThan(0);
    const res = await postInit(port, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("cortex-browser"); // serverInfo.name
    expect(text).toContain("protocolVersion");
  });

  it("缺 / 错 token → 401", async () => {
    const { port } = await startBrowserMcpServer();
    expect((await postInit(port, {})).status).toBe(401);
    expect((await postInit(port, { Authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("带浏览器 Origin → 403(挡 DNS-rebinding）", async () => {
    const { port, token } = await startBrowserMcpServer();
    const res = await postInit(port, { Authorization: `Bearer ${token}`, Origin: "https://evil.com" });
    expect(res.status).toBe(403);
  });

  it("非 /mcp 路径 → 404", async () => {
    const { port, token } = await startBrowserMcpServer();
    const res = await fetch(`http://127.0.0.1:${port}/other`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
