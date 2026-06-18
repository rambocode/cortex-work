// codex CLI adapter。
// 命令形态（实测 codex-cli 0.139.x）：
//   codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
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

export const codexAdapter: AgentAdapter = {
  buildArgs(req: CliStartRequest): { cmd: string; args: string[] } {
    const prompt = promptWithSkills(req);
    const common = [
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      // 纯净启动:TOML 覆盖清空 MCP 服务,只保留全局指令(~/.codex/AGENTS.md)。
      "-c",
      "mcp_servers={}",
    ];
    if (req.model) common.push("--model", req.model);
    // 推理强度:codex 用 -c model_reasoning_effort=<low|medium|high>（与上面的 -c 并列,
    // resume 子命令同样兼容）。
    if (req.effort) common.push("-c", `model_reasoning_effort=${req.effort}`);
    // 图片:codex agent 有 consent 边界,拒绝把 prompt 里的路径转成视觉输入 → 必须走原生
    // --image flag(收文件路径)。放进 common → 落在所有位置参数(--cd/cwd / resumeSessionId /
    // prompt)之前,exec 与 exec resume 两分支通用。每轮新 spawn,故 -i 附到当轮消息成立。
    for (const img of req.images ?? []) common.push("--image", img.path);

    const args = req.resumeSessionId
      ? ["exec", "resume", ...common, req.resumeSessionId, prompt]
      : ["exec", ...common, "--cd", req.cwd, prompt];
    return { cmd: "codex", args };
  },

  parseLine(line: string): CliStreamEvent | null {
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
      return { type: "result", ok: true };
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
