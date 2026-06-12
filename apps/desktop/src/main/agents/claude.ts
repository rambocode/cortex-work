// claude code CLI adapter。
// 命令形态（实测 claude 2.1.x）：
//   claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
//          [--model m] [--resume sessionId] [--append-system-prompt s]
// stream-json 每行一个 JSON：
//   {type:"system",subtype:"init",session_id}                          → init
//   {type:"stream_event",event:{type:"content_block_delta",
//     delta:{type:"text_delta",text}}}                                 → text 增量
//   {type:"assistant",message:{content:[{type:"tool_use",name,input}]}} → tool 步骤
//   {type:"result",subtype:"success"|..., result|error}                → 收尾
// 文本统一从 stream_event 增量取；assistant 完整消息只取 tool_use（避免重复）。

import type { CliStartRequest, CliStreamEvent } from "../ipc/types";
import type { AgentAdapter } from "./index";

function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const candidate = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url ?? obj.description;
  if (typeof candidate !== "string") return undefined;
  return candidate.length > 80 ? candidate.slice(0, 80) + "…" : candidate;
}

export const claudeAdapter: AgentAdapter = {
  buildArgs(req: CliStartRequest) {
    const args = [
      "-p",
      req.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // 个人工作区是本机交互场景，与用户终端使用习惯一致；
      // 否则 print 模式下工具调用会因无人审批而被拒。
      "--dangerously-skip-permissions",
      // 纯净启动:清空 MCP 服务(strict 模式下只认这里传入的空配置),
      // 启动更快、行为可预期;全局指令(~/.claude/CLAUDE.md)仍然生效。
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ];
    if (req.model) args.push("--model", req.model);
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
    // skills 默认禁用,仅当用户在 composer 显式打开(useOwnSkills === true)时才加载。
    if (req.useOwnSkills !== true) args.push("--disable-slash-commands");
    return { cmd: "claude", args };
  },

  parseLine(line: string): CliStreamEvent | null {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;

    if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
      return { type: "init", sessionId: obj.session_id };
    }

    if (obj.type === "stream_event") {
      const event = obj.event as Record<string, unknown> | undefined;
      if (event?.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return { type: "text", delta: delta.text };
        }
      }
      return null;
    }

    if (obj.type === "assistant") {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];
      const tool = content.find((b) => b.type === "tool_use");
      if (tool && typeof tool.name === "string") {
        return { type: "tool", name: tool.name, detail: toolDetail(tool.input) };
      }
      return null;
    }

    if (obj.type === "result") {
      const ok = obj.subtype === "success" && !obj.is_error;
      return {
        type: "result",
        ok,
        text: typeof obj.result === "string" ? obj.result : undefined,
        error: ok ? undefined : (typeof obj.result === "string" ? obj.result : String(obj.subtype ?? "error")),
      };
    }

    return null;
  },
};
