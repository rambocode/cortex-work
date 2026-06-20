// claude code CLI adapter。
// 命令形态（实测 claude 2.1.x）：
//   claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
//          [--permission-mode plan|acceptEdits | --dangerously-skip-permissions]
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

// 图片:claude Read 工具原生支持看图(--dangerously-skip-permissions 下可读任意绝对路径)。
// 官方推荐「绝对路径 + 显式读取指令」;图片引用置于用户文本之前(视觉效果更好,降低误读)。
function buildClaudePrompt(req: CliStartRequest): string {
  if (!req.images?.length) return req.prompt;
  const paths = req.images.map((i) => i.path).join("\n");
  return `用户上传了以下图片,请先用 Read 工具逐一查看,再回应:\n${paths}\n\n${req.prompt}`;
}

export const claudeAdapter: AgentAdapter = {
  buildArgs(req: CliStartRequest) {
    const args = [
      "-p",
      buildClaudePrompt(req),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // 纯净启动:清空 MCP 服务(strict 模式下只认这里传入的空配置),
      // 启动更快、行为可预期;全局指令(~/.claude/CLAUDE.md)仍然生效。
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ];
    // 运行模式 → 权限标志。print(-p)模式无人审批回路,靠启动标志事前约束工具能力:
    //   plan        → --permission-mode plan（只读+出计划,-p 下不 hang;尝试写操作会被拒而非挂起）
    //   accept-edits → --permission-mode acceptEdits（自动批准工作目录内编辑;非编辑 Bash 受限即中止）
    //   full-auto/缺省 → --dangerously-skip-permissions（≡ bypassPermissions;本机交互场景,
    //                  与用户终端使用习惯一致,保留现用标志最小化回归）
    const mode = req.permissionMode ?? "full-auto";
    if (mode === "plan") args.push("--permission-mode", "plan");
    else if (mode === "accept-edits") args.push("--permission-mode", "acceptEdits");
    else args.push("--dangerously-skip-permissions");
    if (req.model) args.push("--model", req.model);
    // 推理强度（claude 2.1.x 支持 --effort low|medium|high,-p 模式生效;不支持的
    // 模型自身回退）。
    if (req.effort) args.push("--effort", req.effort);
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
