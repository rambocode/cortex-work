// codex CLI adapter。
// 命令形态（实测 codex-cli 0.139.x）：
//   codex exec --json --skip-git-repo-check
//              [-s read-only|workspace-write -c approval_policy=never | --dangerously-bypass-approvals-and-sandbox]
//              --cd <cwd> [--model m] <prompt>
//   codex exec resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
//              [--model m] <threadId> <prompt>
// JSONL 每行一个事件：
//   {type:"thread.started",thread_id}                              → init
//   {type:"item.started",item:{type:"command_execution",command}}  → tool
//   {type:"item.completed",item:{type:"agent_message",text}}       → text
//   {type:"turn.completed"}                                        → result

import type { CliStartRequest, CliStreamEvent } from "../ipc/types";
import type { AgentAdapter } from "./index";

function promptWithSkills(req: CliStartRequest): string {
  if (!req.appendSystemPrompt) return req.prompt;
  return `${req.appendSystemPrompt}\n\n<user_request>\n${req.prompt}\n</user_request>`;
}

function commandDetail(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  return command.length > 100 ? command.slice(0, 100) + "…" : command;
}

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

export const codexAdapter: AgentAdapter = {
  buildArgs(req: CliStartRequest): { cmd: string; args: string[]; stdin: string } {
    const prompt = promptWithSkills(req);
    const common = ["--json", "--skip-git-repo-check"];
    // 运行模式 → sandbox + 审批策略。codex exec 不接受 --ask-for-approval(顶层 TUI 才有),
    // 审批走 -c approval_policy;不用 --full-auto(= workspace-write + on-failure,on-failure 在
    // 无人审批的 print 模式会升级审批而卡住)。
    //   plan        → -s read-only -c approval_policy=never（只读+无网,提权命令直接被拒不挂起）
    //   accept-edits → -s workspace-write -c approval_policy=never（自动写 cwd,默认不联网）
    //   full-auto/缺省 → --dangerously-bypass-approvals-and-sandbox（= danger-full-access 无审批,现用）
    const mode = req.permissionMode ?? "full-auto";
    if (mode === "plan") common.push("-s", "read-only", "-c", "approval_policy=never");
    else if (mode === "accept-edits") common.push("-s", "workspace-write", "-c", "approval_policy=never");
    else common.push("--dangerously-bypass-approvals-and-sandbox");
    // 纯净启动:TOML 覆盖清空 MCP 服务,只保留全局指令(~/.codex/AGENTS.md)。
    common.push("-c", "mcp_servers={}");
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
    const args = req.resumeSessionId
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
    if (item?.type === "command_execution" && obj.type === "item.started") {
      return { type: "tool", name: "Shell", detail: commandDetail(item.command) };
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
