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
import type { AgentDef } from "./index";

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

// claude result 帧的 usage + total_cost_usd → 归一化 usage 事件。claude 提供 cost,故带 costUsd;
// 缓存命中是 cache_read_input_tokens。字段缺失/类型异常一律降级为不产出(返回 null),不抛错。
// 流式 usage 为补充信号,持久权威仍在 usage.ts 磁盘路径(KTD3)。
function mapClaudeUsage(obj: Record<string, unknown>): CliStreamEvent | null {
  const usage = obj.usage as Record<string, unknown> | undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const inputTokens = num(usage?.input_tokens);
  const outputTokens = num(usage?.output_tokens);
  const cachedInputTokens = num(usage?.cache_read_input_tokens);
  const costUsd = num(obj.total_cost_usd);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    costUsd === undefined
  )
    return null;
  return { type: "usage", inputTokens, outputTokens, cachedInputTokens, costUsd };
}

// prompt 经 stdin 投递(U4):claude -p --input-format stream-json 从 stdin 读取一行 user message JSONL。
// 实测(claude 2.1.x):写入该信封 + EOF(关 stdin)即触发处理并退出,绕开 argv 长度上限。
// 图片说明文本已由 buildClaudePrompt 拼入 text。
function buildClaudeStdin(req: CliStartRequest): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: buildClaudePrompt(req) }] },
  });
}

export const claudeDef: AgentDef = {
  id: "claude",
  // 能力位:claude 走 stream-json stdin;MCP 写 cwd .mcp.json(U2);续接支持 --continue+resume(U4);
  // 图片拼进 prompt 文本、appendSystemPrompt 用原生 flag(U5)。
  promptDelivery: "stdin-stream-json",
  mcpInjection: "claude-mcp-json",
  sessionResume: "continue+resume",
  imageDelivery: "prompt-text",
  appendSystemPrompt: "native-flag",
  buildArgs(req: CliStartRequest) {
    const args = [
      "-p",
      // prompt 不再进 argv:经 stdin 以 stream-json 投递(U4,绕开命令行长度上限)。
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // MCP(U2):不再写死清空。claude 原生加载 cwd 的 .mcp.json —— 启用时由 mcp-config.applyClaudeMcp
      // 写入 app .mcp.json(严格 gate),关闭/无配置时不写,用户自有 .mcp.json 原样被 claude 加载。
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
    // 目录授权(KTD4/KTD5):额外可写目录经 claude 原生 --add-dir 逐个追加(claude code 支持)。
    // plan 档由 core clampByMode 保证 writableExtraDirs 为空;full-auto 已全开,--add-dir 实质 no-op。
    for (const dir of req.writableExtraDirs ?? []) args.push("--add-dir", dir);
    if (req.model) args.push("--model", req.model);
    // 推理强度（claude 2.1.x 支持 --effort low|medium|high,-p 模式生效;不支持的
    // 模型自身回退）。
    if (req.effort) args.push("--effort", req.effort);
    // 续接(U4):continueSession 续接最近会话(--continue);否则按 id resume。两者互斥,continue 优先。
    if (req.continueSession) args.push("--continue");
    else if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
    // skills 默认禁用,仅当用户在 composer 显式打开(useOwnSkills === true)时才加载。
    if (req.useOwnSkills !== true) args.push("--disable-slash-commands");
    return { cmd: "claude", args, stdin: buildClaudeStdin(req) };
  },

  parseLine(line: string): CliStreamEvent | CliStreamEvent[] | null {
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
        // 思考增量(R2):reasoning 模型的 thinking_delta 不再丢弃,归一化为 thinking 事件
        //(消费端当前忽略,与 usage 一致——M1「采集、展示延后」)。
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          return { type: "thinking", delta: delta.thinking };
        }
      }
      // 轮边界(R2 / R1 的 turn 信号):message_delta 携带本轮 stop_reason(end_turn / tool_use /
      // max_tokens…),归一化为 turn 事件。stop_reason==="tool_use" = 本轮要调工具、未干净结束。
      if (event?.type === "message_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === "string") {
          return { type: "turn", stopReason: delta.stop_reason };
        }
      }
      return null;
    }

    if (obj.type === "assistant") {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];
      const tool = content.find((b) => b.type === "tool_use");
      if (tool && typeof tool.name === "string") {
        // R2:标注 phase:"start" 与 toolCallId(承载能力);只产起始事件,不产 end(避免重复 tool 事件
        // 污染渲染端 agentLog 折叠)。
        return {
          type: "tool",
          name: tool.name,
          detail: toolDetail(tool.input),
          phase: "start",
          toolCallId: typeof tool.id === "string" ? tool.id : undefined,
        };
      }
      return null;
    }

    if (obj.type === "result") {
      const ok = obj.subtype === "success" && !obj.is_error;
      const result: CliStreamEvent = {
        type: "result",
        ok,
        text: typeof obj.result === "string" ? obj.result : undefined,
        error: ok ? undefined : (typeof obj.result === "string" ? obj.result : String(obj.subtype ?? "error")),
      };
      // 一行同时透出 usage(若有)与 result:usage 在前,供消费端先记账再收尾。
      const usage = mapClaudeUsage(obj);
      return usage ? [usage, result] : result;
    }

    return null;
  },
};
