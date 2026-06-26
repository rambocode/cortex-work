// codex CLI adapter。
// 命令形态（实测 codex-cli 0.142.x）：
//   codex exec --json --skip-git-repo-check
//              [-c sandbox_mode=read-only|workspace-write -c approval_policy=never | --dangerously-bypass-approvals-and-sandbox]
//              --cd <cwd> [--model m] <prompt>
//   codex exec resume --json --skip-git-repo-check
//              [-c sandbox_mode=… -c approval_policy=never | --dangerously-bypass-approvals-and-sandbox]
//              [--model m] <threadId> <prompt>
// 注:resume 子命令不接受 -s/--sandbox(仅顶层 exec 有);sandbox 统一走 -c sandbox_mode 两端通用。
// JSONL 每行一个事件：
//   {type:"thread.started",thread_id}                              → init
//   {type:"item.started",item:{type:"command_execution",command}}  → tool
//   {type:"item.completed",item:{type:"agent_message",text}}       → text
//   {type:"turn.completed"}                                        → result

import type { CliStartRequest, CliStreamEvent } from "../ipc/types";
import type { AgentDef } from "./index";

// appendSystemPrompt 以 <user_request> 包裹进 prompt。导出供 ws 路径(codex-ws-channel)复用,
// 保证 exec 与 app-server 两条 codex 路径的 prompt 拼装一致。
export function promptWithSkills(req: CliStartRequest): string {
  if (!req.appendSystemPrompt) return req.prompt;
  return `${req.appendSystemPrompt}\n\n<user_request>\n${req.prompt}\n</user_request>`;
}

function commandDetail(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  return command.length > 100 ? command.slice(0, 100) + "…" : command;
}

// codex item.type → 归一化 tool 名(R2:不再硬编码 "Shell")。把 codex 各类工具项映射到与 claude 工具名
// 同风格的显示名;未知类型回退为其原始 item.type(humanize),避免再出现「全部叫 Shell」。
const CODEX_TOOL_NAMES: Record<string, string> = {
  command_execution: "Shell",
  file_change: "Edit",
  patch_apply: "Edit",
  mcp_tool_call: "MCP",
  web_search: "WebSearch",
};
function codexToolName(itemType: string): string {
  return CODEX_TOOL_NAMES[itemType] ?? itemType;
}

// codex tool 项的 detail:command_execution 取命令;其余尽力取常见字段(path/查询),取不到则 undefined。
function codexToolDetail(item: Record<string, unknown>): string | undefined {
  if (item.type === "command_execution") return commandDetail(item.command);
  const candidate = item.path ?? item.query ?? item.tool ?? item.server;
  return typeof candidate === "string" ? commandDetail(candidate) : undefined;
}

// 哪些 codex item.type 视为「工具」(在 item.started 时产 tool 起始事件)。仅纳入已知工具类,
// 避免把 reasoning / agent_message 等误当工具。
const CODEX_TOOL_TYPES = new Set(Object.keys(CODEX_TOOL_NAMES));

// codex turn.completed.usage → 归一化 usage 事件。codex 无 cost 字段(仅 token);字段缺失/类型
// 异常一律降级为不产出(返回 null),不抛错。codex 磁盘 rollout 不带 per-event token 历史,
// 故这条流式 usage 是 codex 唯一的 token 来源(补充信号,见 KTD3)。
function mapCodexUsage(usage: unknown): CliStreamEvent | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cachedInputTokens = num(u.cached_input_tokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) return null;
  return { type: "usage", inputTokens, outputTokens, cachedInputTokens };
}

export const codexDef: AgentDef = {
  id: "codex",
  // 能力位:codex prompt 经 stdin 管道写完即 EOF;MCP 经 -c 注入(U2);续接 exec/exec resume(U4);
  // 图片用原生 --image、appendSystemPrompt 以 <user_request> 包裹进 prompt(U5)。
  promptDelivery: "stdin-eof",
  mcpInjection: "codex-c",
  sessionResume: "continue+resume",
  imageDelivery: "native-flag",
  appendSystemPrompt: "prompt-wrap",
  // 主交互会话(cli:start)走 app-server WebSocket 持久连接(见 ipc/codex-ws-channel.ts);
  // 轻量路径(oneshot/ask/automation/workflow-headless)不读 transport,仍用下方 buildArgs 走 `codex exec`。
  transport: "ws",
  buildArgs(req: CliStartRequest, mcpArgs?: string[]): { cmd: string; args: string[]; stdin: string } {
    const prompt = promptWithSkills(req);
    const common = ["--json", "--skip-git-repo-check"];
    // 运行模式 → sandbox + 审批策略。codex exec 不接受 --ask-for-approval(顶层 TUI 才有),
    // 审批走 -c approval_policy;不用 --full-auto(= workspace-write + on-failure,on-failure 在
    // 无人审批的 print 模式会升级审批而卡住)。
    // sandbox 必须经 -c sandbox_mode=<mode>(而非 -s/--sandbox flag):common 数组对 `exec` 与
    // `exec resume` 两分支通用,而 `codex exec resume` 子命令不接受 -s(实测 0.142.x:
    // `error: unexpected argument '-s' found`),仅接受 -c 配置覆盖。-c sandbox_mode 等价于 -s 且
    // 两端通吃,故续接非 full-auto 会话不再崩。
    //   plan        → sandbox_mode=read-only + approval_policy=never（只读+无网,提权命令直接被拒不挂起）
    //   accept-edits → sandbox_mode=workspace-write + approval_policy=never（自动写 cwd,默认不联网）
    //   full-auto/缺省 → --dangerously-bypass-approvals-and-sandbox（= danger-full-access 无审批,resume 也接受）
    // 访问范围 → codex sandbox_mode(approval_policy 始终 never,见下「执行/审批」):
    //   plan(只读文件)        → sandbox_mode=read-only
    //   accept-edits(可写工作区) → sandbox_mode=workspace-write
    //   sandbox(外部沙箱)      → sandbox_mode=workspace-write(codex 原生 OS 沙箱;外部沙箱 ≈ 可写工作区沙箱)
    //   full-auto(访问所有文件)  → --dangerously-bypass-approvals-and-sandbox(= danger-full-access,resume 也接受)
    // sandbox 统一经 -c sandbox_mode(而非 -s):common 对 exec 与 exec resume 通用,resume 不接受 -s。
    const mode = req.permissionMode ?? "full-auto";
    if (mode === "plan") common.push("-c", "sandbox_mode=read-only", "-c", "approval_policy=never");
    else if (mode === "accept-edits" || mode === "sandbox")
      common.push("-c", "sandbox_mode=workspace-write", "-c", "approval_policy=never");
    else common.push("--dangerously-bypass-approvals-and-sandbox");
    // 执行/审批:codex exec 非交互,approval_policy=on-request/on-failure 会在无人审批时挂起,
    // 故 ask(询问后执行)无法兑现 → 降级为 never(与 auto 同,由 UI 标注降级映射);不改上面标志。
    // MCP(U2):不再写死清空。关/无配置时不传 → codex 原生继承 ~/.codex 的 MCP;启用时公共管线经
    // mcpArgs 传入 `-c mcp_servers.<id>...`,放进 common(落在位置参数 threadId 之前)。
    if (mcpArgs?.length) common.push(...mcpArgs);
    if (req.model) common.push("--model", req.model);
    // 推理强度:codex 用 -c model_reasoning_effort=<low|medium|high>（与上面的 -c 并列,
    // resume 子命令同样兼容）。
    if (req.effort) common.push("-c", `model_reasoning_effort=${req.effort}`);
    // 图片:codex agent 有 consent 边界,拒绝把 prompt 里的路径转成视觉输入 → 必须走原生
    // --image flag(收文件路径)。放进 common → 落在所有位置参数(--cd/cwd / resumeSessionId /
    // prompt)之前,exec 与 exec resume 两分支通用。每轮新 spawn,故 -i 附到当轮消息成立。
    for (const img of req.images ?? []) common.push("--image", img.path);

    // prompt 经 stdin 投递(U4):codex exec 省略位置参数 [PROMPT] 时「instructions are read from stdin」
    // (--help 实测,且 argv 不得出现 `-` 哨兵否则 exit 2)。绕开命令行长度上限。resume 分支 threadId
    // 仍是位置参数,只去掉 prompt。
    // 续接(U4):continueSession → exec resume --last(最近会话,无需 id,--help 实测);
    // 否则按 id resume;再否则首轮 exec --cd。三者互斥,continue 优先。
    const args = req.continueSession
      ? ["exec", "resume", ...common, "--last"]
      : req.resumeSessionId
        ? ["exec", "resume", ...common, req.resumeSessionId]
        : ["exec", ...common, "--cd", req.cwd];
    return { cmd: "codex", args, stdin: prompt };
  },

  parseLine(line: string): CliStreamEvent | CliStreamEvent[] | null {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;

    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      return { type: "init", sessionId: obj.thread_id };
    }

    const item = obj.item as Record<string, unknown> | undefined;
    // 工具起始(R2):归一化 tool 名(不再硬编码 "Shell"),标注 phase:"start" + toolCallId(item.id)。
    // 只在 item.started 产起始事件,不产 end(避免重复 tool 事件污染渲染端 agentLog 折叠)。
    if (obj.type === "item.started" && typeof item?.type === "string" && CODEX_TOOL_TYPES.has(item.type)) {
      return {
        type: "tool",
        name: codexToolName(item.type),
        detail: codexToolDetail(item),
        phase: "start",
        toolCallId: typeof item.id === "string" ? item.id : undefined,
      };
    }

    if (item?.type === "agent_message" && obj.type === "item.completed" && typeof item.text === "string") {
      return { type: "text", delta: item.text };
    }

    if (obj.type === "turn.completed") {
      // 一行同时透出 usage(若有)与 result:usage 在前,供消费端先记账再收尾。
      const usage = mapCodexUsage(obj.usage);
      return usage ? [usage, { type: "result", ok: true }] : { type: "result", ok: true };
    }

    if (obj.type === "turn.failed" || obj.type === "item.failed") {
      return {
        type: "result",
        ok: false,
        error: typeof obj.error === "string" ? obj.error : String(obj.type),
      };
    }

    return null;
  },
};
