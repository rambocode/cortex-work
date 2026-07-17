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

// 工具输出截断上限:防止超大输出(如 cat 大文件)撑爆 IPC 消息与渲染端内存。
const MAX_TOOL_OUTPUT = 8_000;

// 归一化 tool_result 的 content 为展示用文本:string 原样;content block 数组拼接其中的
// text 块;其余形态(对象/数字等)JSON 序列化兜底。超限截断。
function normalizeToolResultContent(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        const block = b as Record<string, unknown>;
        return block?.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    try {
      text = JSON.stringify(content);
    } catch {
      text = String(content);
    }
  }
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "…" : text;
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

// ── 已知忽略帧声明(盲区补点降噪,见 index.ts parseLineEvents)────────────────────
// dev 实测:每轮流式运行,stream_event 生命周期子帧 / system 信息性子类型 / 无 tool_use 的
// assistant / 无 tool_result 的 user 会把 parse 日志刷屏成「未映射的 claude 输出帧」,
// 淹没真正的协议漂移信号。以下清单为已评审的故意忽略;未列出的子类型保持告警。

// 顶层 type 一刀切忽略:assistant/user 帧仅当**未**解析出 tool 事件时才会走到盲区判定
// (解析出事件的帧不进此路径),此时即「无 tool_use 的 assistant(text 已由 delta 覆盖)」
// 与「无 tool_result 的 user(skill 注入等回灌)」,均为设计内忽略;rate_limit_event 为信息帧。
const IGNORED_FRAME_TYPES = new Set(["assistant", "user", "rate_limit_event"]);

// stream_event 里纯生命周期边界子帧:不携带需归一化的内容。
// (text_delta/thinking_delta/message_delta 会产事件,不在此列。)
const IGNORED_STREAM_EVENT_TYPES = new Set([
  "content_block_start",
  "content_block_stop",
  "message_start",
  "message_stop",
]);

// content_block_delta 中已知无需映射的增量:签名增量无展示价值;工具入参增量(input_json_delta)
// 是碎片 JSON,完整 input 由 assistant 帧的 tool_use 块承载。
const IGNORED_DELTA_TYPES = new Set(["signature_delta", "input_json_delta"]);

// system 信息性子类型:状态心跳 / 思考 token 计数 / hook 与 task 生命周期通知,均无归一化事件对应。
// (init 会产 init 事件,不进此路径。)
const IGNORED_SYSTEM_SUBTYPES = new Set([
  "status",
  "thinking_tokens",
  "hook_started",
  "hook_response",
  "hook_progress",
  "task_started",
  "task_notification",
]);

export const claudeDef: AgentDef = {
  id: "claude",
  // 能力位:claude 走 stream-json stdin;MCP 写 cwd .mcp.json(U2);续接支持 --continue+resume(U4);
  // 图片拼进 prompt 文本、appendSystemPrompt 用原生 flag(U5)。
  promptDelivery: "stdin-stream-json",
  ignoredFrameTypes: IGNORED_FRAME_TYPES,
  // 细粒度已知忽略:stream_event 与 system 下「部分子事件已适配、其余故意忽略」,不能按顶层
  // type 一刀切——否则未来新增子帧(新 delta 类型 / 新 system 子类型)的协议漂移会被一并消音。
  isIgnoredFrame(frame: Record<string, unknown>): boolean {
    if (frame.type === "stream_event") {
      const event = frame.event as Record<string, unknown> | undefined;
      if (typeof event?.type !== "string") return false;
      if (IGNORED_STREAM_EVENT_TYPES.has(event.type)) return true;
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        return typeof delta?.type === "string" && IGNORED_DELTA_TYPES.has(delta.type);
      }
      return false;
    }
    if (frame.type === "system") {
      return typeof frame.subtype === "string" && IGNORED_SYSTEM_SUBTYPES.has(frame.subtype);
    }
    return false;
  },
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
    // 访问范围 → claude --permission-mode / bypass 标志(print 模式靠启动标志事前约束):
    //   plan(只读文件)     → --permission-mode plan
    //   accept-edits(可写工作区) → --permission-mode acceptEdits
    //   full-auto(访问所有文件)  → --dangerously-skip-permissions
    //   sandbox(外部沙箱)   → 降级:claude 无原生沙箱,退化为 acceptEdits(可写工作区,最接近的「受限可写」)
    const mode = req.permissionMode ?? "full-auto";
    if (mode === "plan") args.push("--permission-mode", "plan");
    else if (mode === "accept-edits" || mode === "sandbox") args.push("--permission-mode", "acceptEdits");
    else args.push("--dangerously-skip-permissions");
    // 内置 MCP server(cortex-slides / delegate / 浏览器控制等)是产品自身能力面,acceptEdits 不
    // 覆盖 MCP 工具 → print 模式下调用卡在无人可批的权限请求(实测 slides 回合 claude 直接罢工
    // 求授权)。故对注入的内置 server 整体预授权(mcp__<id> 规则覆盖该 server 全部工具)。
    // plan 模式刻意不放行:内置工具含写操作,放行会破坏 plan 的只读承诺;bypass 本就全放行。
    if ((mode === "accept-edits" || mode === "sandbox") && req.builtinMcpServers?.length) {
      args.push("--allowed-tools", req.builtinMcpServers.map((id) => `mcp__${id}`).join(","));
    }
    // 执行/审批:claude -p 非交互,无中途审批回路。ask(询问后执行)在此无法兑现 → 降级为与 auto
    // 同行为(由 UI 标注降级映射),不改启动标志。
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
    // U3:原生 skill 目录发现。开启原生 skill 且主进程已建好桥接目录(cli.ts 的 cli:start handler 内
    // 由 buildClaudeSkillBridge 填充 skillsBridgeDir)时,追加 --add-dir 让 claude 自动加载该目录下的
    // .claude/skills/,由 claude 自身原生展开 /<name>。无桥接目录(无已启用 skill / 构建失败降级)时
    // 不追加,不阻断发送。claude 的 slash 展开发生在 CLI 输入层,buildArgs 无需处理 prompt 文本。
    if (req.useOwnSkills === true && req.skillsBridgeDir) args.push("--add-dir", req.skillsBridgeDir);
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
      // 一条 assistant 消息可含多个 tool_use 块(并行工具调用):逐块产出 start 事件,
      // 各带完整 input(运行过程详情视图展示)与 toolCallId(与 tool_result 配对)。
      const tools = content.filter(
        (b): b is Record<string, unknown> & { name: string } => b.type === "tool_use" && typeof b.name === "string",
      );
      if (tools.length === 0) return null;
      const events = tools.map<CliStreamEvent>((tool) => ({
        type: "tool",
        name: tool.name,
        detail: toolDetail(tool.input),
        input: tool.input,
        phase: "start",
        toolCallId: typeof tool.id === "string" ? tool.id : undefined,
      }));
      return events.length === 1 ? events[0]! : events;
    }

    // tool_result:claude 把工具执行结果作为 user 消息回灌。产出 phase:"end" 事件,靠
    // toolCallId(=tool_use_id)与 start 配对;name 在结果帧不可得,置空字符串由消费端配对补齐。
    // 渲染端 agentLog 折叠对 phase:"end" 有守卫(messages.ts/followup.ts),不会翻倍。
    if (obj.type === "user") {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];
      const results = content.filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
      if (results.length === 0) return null;
      const events = results.map<CliStreamEvent>((block) => ({
        type: "tool",
        name: "",
        phase: "end",
        toolCallId: block.tool_use_id as string,
        output: normalizeToolResultContent(block.content),
        isError: block.is_error === true,
      }));
      return events.length === 1 ? events[0]! : events;
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
