// doc-extract MCP 注入配置 + extract_document 工具安全闸门单测。
// 不起真实 http server / 不 fork worker(那些在 U5 集成 / U6 打包验证覆盖);
// 这里验证:host 未起时不注入;工具对范围外路径优雅拒绝(不抛、不读任意文件)。
import { describe, expect, it, vi } from "vitest";

// mcp.ts 经 ipc/doc → electron(ipcMain),paths → electron(app);须 mock。
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "/app" },
}));

import { buildDocExtractMcpServerConfig, registerDocExtractTools } from "./mcp";
import type { ToolContext } from "../mcp-host/server";

describe("buildDocExtractMcpServerConfig", () => {
  it("host 未起 → 返回 null(不注入连不上的 url)", () => {
    expect(buildDocExtractMcpServerConfig("sess1")).toBeNull();
  });
});

describe("extract_document 安全闸门", () => {
  // 捕获注册的工具 handler。
  type ToolHandler = (args: { path: string }) => Promise<{ content: { text: string }[] }>;
  function captureHandler(ctx: ToolContext): ToolHandler {
    let handler: ToolHandler | undefined;
    const fakeMcp = {
      registerTool: (_name: string, _schema: unknown, h: ToolHandler) => {
        handler = h;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDocExtractTools(fakeMcp as any, ctx);
    if (!handler) throw new Error("未注册 extract_document");
    return handler;
  }

  it("范围外绝对路径 → 优雅拒绝(不抛,提示不在本会话范围)", async () => {
    const handler = captureHandler({ sessionId: `doctest-${Math.floor(Date.now() / 1)}` });
    const res = await handler({ path: "/etc/passwd" });
    expect(res.content[0].text).toMatch(/无法读取|范围内/);
  });

  it("无 sessionId 仍限根 chat-docs:范围外路径被拒", async () => {
    const handler = captureHandler({ sessionId: null });
    const res = await handler({ path: "/etc/hosts" });
    expect(res.content[0].text).toMatch(/无法读取|范围内/);
  });
});
