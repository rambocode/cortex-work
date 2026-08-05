// 文档抽取 MCP:独立 host 实例 + extract_document 工具 + 三端注入配置。
// agent 在需要时调用 extract_document(path),按需把用户附带的文档抽成文本(省 context)。
//
// 安全(KTD9):
//  - 会话隔离 —— 仅允许读「本会话」chat-docs 子目录下的文件(X-Cortex-Session 头 → chatDocsDir(sid))。
//  - 限根 + 拒符号链接 + 扩展名 allowlist 走 assertDocPath(不用 fs.assertOpenable 的任意文件兜底)。
//  - 重解析在独立 worker 进程(runner),带超时 + 堆上限。

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle, type ToolContext } from "../mcp-host/server";
import type { McpServerConfig } from "../../ipc/types";
import { chatDocsRoot, chatDocsDir } from "../../paths";
import { assertDocPath } from "../../ipc/doc";
import { runExtraction } from "./runner";

// 注入用 server id(= MCP server 名)。须为 TOML 裸键安全(见 mcp-config.isValidServerId)。
export const DOC_EXTRACT_SERVER_ID = "cortex-docs";

// 独立于浏览器控制的 host 实例(各自 port/token)。
const docHost = createMcpHost(DOC_EXTRACT_SERVER_ID);

// 会话隔离:有 sessionId → 限定到该会话子目录;无则退到 chat-docs 总根(仍杜绝任意文件读取,
// 但跨会话——正常注入路径都带 X-Cortex-Session,故一般走前者)。chatDocsDir 内含 SAFE_ID 校验。
function scopedRoot(sessionId: string | null): string {
  return sessionId ? chatDocsDir(sessionId) : chatDocsRoot();
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerDocExtractTools(mcp: McpServer, ctx: ToolContext): void {
  mcp.registerTool(
    "extract_document",
    {
      description:
        "读取用户在本次聊天中附带的文档(PDF / Word / Excel / PPT 新旧格式 / OpenDocument / RTF / EPUB / 纯文本)的内容,二进制文档转为 Markdown 返回。" +
        "path 取自用户消息附件的 files[].path。仅能读取本会话的附件;扫描件/图片型 PDF 可能无文本。",
      inputSchema: { path: z.string().describe("文档绝对路径(来自消息附件 files[].path)") },
    },
    async ({ path }: { path: string }) => {
      let real: string;
      try {
        real = await assertDocPath(scopedRoot(ctx.sessionId), path);
      } catch (e) {
        return text(`无法读取该文档(路径不在本会话附件范围内): ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const r = await runExtraction(real);
        if (r.empty) return text(r.note ?? "(文档无可抽取文本)");
        return text(r.truncated ? `${r.text}\n\n[内容过长已截断]` : r.text);
      } catch (e) {
        return text(`文档抽取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

// 起/停 doc-extract host(index.ts 在 whenReady / quit 调用)。
export function startDocExtractHost(): Promise<McpHostHandle> {
  return docHost.start(registerDocExtractTools);
}
export function stopDocExtractHost(): void {
  docHost.stop();
}

// 注入配置:host 可用即注入(文档抽取 v1 无开关,常驻可用)。token 经 Authorization 头,不进 URL。
// sessionId(cli 会话)经 X-Cortex-Session 头注入,供工具做会话隔离(KTD9)。
export function buildDocExtractMcpServerConfig(sessionId?: string): McpServerConfig | null {
  const handle = docHost.getHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;
  return {
    id: DOC_EXTRACT_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      ...(sessionId ? { "X-Cortex-Session": sessionId } : {}),
    },
  };
}
