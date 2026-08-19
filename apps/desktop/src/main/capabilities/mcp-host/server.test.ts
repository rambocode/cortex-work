import { afterEach, describe, expect, it } from "vitest";

import { __setSseKeepaliveIntervalForTest, createMcpHost, startMcpHost, stopMcpHost } from "./server";

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
  afterEach(() => stopMcpHost());

  it("带正确 Bearer token 的 initialize 返回 200 + 合法 MCP 结果", async () => {
    const { port, token, serverAvailable } = await startMcpHost();
    expect(serverAvailable).toBe(true);
    expect(port).toBeGreaterThan(0);
    const res = await postInit(port, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("cortex-browser"); // serverInfo.name
    expect(text).toContain("protocolVersion");
  });

  it("缺 / 错 token → 401", async () => {
    const { port } = await startMcpHost();
    expect((await postInit(port, {})).status).toBe(401);
    expect((await postInit(port, { Authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("带浏览器 Origin → 403(挡 DNS-rebinding）", async () => {
    const { port, token } = await startMcpHost();
    const res = await postInit(port, { Authorization: `Bearer ${token}`, Origin: "https://evil.com" });
    expect(res.status).toBe(403);
  });

  it("非 /mcp 路径 → 404", async () => {
    const { port, token } = await startMcpHost();
    const res = await fetch(`http://127.0.0.1:${port}/other`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  // 「5 分钟被取消」回归护栏:长 tool call 的 SSE 响应在工具完成前没有任何字节,undici 默认
  // bodyTimeout=300s 会掐流。host 须周期写 SSE 注释帧喂空闲计时器,且注释帧不破坏结果解析。
  it("慢 tool call 期间 SSE 流持续输出 keepalive 注释帧,结果帧不受影响", async () => {
    __setSseKeepaliveIntervalForTest(50);
    const host = createMcpHost("keepalive-test");
    try {
      const { port, token } = await host.start((mcp) => {
        mcp.registerTool("slow", { description: "睡 400ms 再返回", inputSchema: {} }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { content: [{ type: "text" as const, text: "slow-done" }] };
        });
      });
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "slow", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      // 工具睡 400ms、心跳 50ms:流上必须出现注释帧,证明空闲期有字节喂给客户端计时器。
      expect(text).toContain(": keepalive");
      // 注释帧不撕裂事件框架:最终 tool 结果仍完整可解析。
      expect(text).toContain("slow-done");
    } finally {
      host.stop();
      __setSseKeepaliveIntervalForTest(15_000);
    }
  });
});
