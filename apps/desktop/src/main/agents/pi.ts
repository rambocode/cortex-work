// pi（@earendil-works/pi-coding-agent）内置兜底 agent 的 CLI adapter。
// 命令形态（实测 0.79.2,pi 已 bun 编译成自包含二进制,由 cli.ts 经 spawn 执行）：
//   <pi 二进制> --mode json -p --no-extensions
//             [--no-skills] [--model m] [--session id] [--append-system-prompt s] <prompt>
//   · adapter 产出 cmd=pi 二进制路径（resolvePiBinary）+ args；cli.ts 对三种 agent 统一 spawn。
//   · -p 是非交互布尔 flag,prompt 不是它的值,而是命令行最后一个位置参数。
//   · --no-extensions 纯净启动；--no-skills 默认禁用 skills（useOwnSkills=true 时省略,
//     与 claude adapter 对齐）；pi 原生支持 --append-system-prompt。
// --mode json 输出 JSONL,每行一个事件：
//   {type:"session",id}                                              → init
//   {type:"message_update",assistantMessageEvent:{type:"text_delta",delta}} → text 增量
//   {type:"tool_execution_start",toolName,args}                      → tool 步骤
//   {type:"message_end",message:{role:"assistant",stopReason,...}}   → 收尾(result)
//   另有 agent_start/turn_start/turn_end/agent_end/message_start 等,一律忽略。
// ⚠️ 陷阱：provider 失败时进程仍 exit 0,错误只体现在 message_end 的 stopReason:"error"
//    + errorMessage/diagnostics 上。故 result 由最后一条 assistant message_end 发出,
//    agent_end 不发,避免覆盖掉这条错误结果。

import { resolvePiBinary } from "./pi-locate";
import type { CliStartRequest, CliStreamEvent } from "../ipc/types";
import type { AgentAdapter } from "./index";

function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const candidate = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url;
  if (typeof candidate !== "string") return undefined;
  return candidate.length > 80 ? candidate.slice(0, 80) + "…" : candidate;
}

// 拼接 message_end 里 assistant content 的 text 块为完整文本。
function joinText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text || undefined;
}

// diagnostics 最后一项里的错误信息（provider_transport_failure 等）。
function diagnosticsError(diagnostics: unknown): string | undefined {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return undefined;
  const last = diagnostics[diagnostics.length - 1] as Record<string, unknown> | undefined;
  const err = last?.error as Record<string, unknown> | undefined;
  return typeof err?.message === "string" ? err.message : undefined;
}

export const piAdapter: AgentAdapter = {
  buildArgs(req: CliStartRequest): { cmd: string; args: string[] } {
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-extensions",
    ];
    // skills 默认禁用,仅当用户显式打开(useOwnSkills === true)时才加载。
    if (req.useOwnSkills !== true) args.push("--no-skills");
    // 自定义供应商:cli.ts 已生成 extension 文件,这里用 -e 显式加载 + -a 信任
    //（实测 --no-extensions 与显式 -e 可共存）；provider id 即 pi provider 名。
    if (req.piExtensionPath) {
      args.push("-e", req.piExtensionPath, "-a");
      if (req.provider) args.push("--provider", req.provider.id);
    }
    if (req.model) args.push("--model", req.model);
    if (req.resumeSessionId) args.push("--session", req.resumeSessionId);
    if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
    // prompt 是位置参数,必须在最后。
    args.push(req.prompt);
    // cmd 是 pi 二进制路径,cli.ts 直接 spawn 它（独立 CLI 进程,不弹 macOS Dock）。
    return { cmd: resolvePiBinary(), args };
  },

  parseLine(line: string): CliStreamEvent | null {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;

    if (obj.type === "session" && typeof obj.id === "string") {
      return { type: "init", sessionId: obj.id };
    }

    if (obj.type === "message_update") {
      const ev = obj.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        return { type: "text", delta: ev.delta };
      }
      return null;
    }

    if (obj.type === "tool_execution_start" && typeof obj.toolName === "string") {
      return { type: "tool", name: obj.toolName, detail: toolDetail(obj.args) };
    }

    if (obj.type === "message_end") {
      const message = obj.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") return null;
      const stopReason = message.stopReason;
      if (stopReason === "stop" || stopReason === "length") {
        return { type: "result", ok: true, text: joinText(message.content) };
      }
      if (stopReason === "error" || stopReason === "aborted") {
        const error =
          (typeof message.errorMessage === "string" ? message.errorMessage : undefined) ??
          diagnosticsError(message.diagnostics) ??
          String(stopReason);
        return { type: "result", ok: false, error };
      }
      // stopReason:"toolUse" —— 中间轮,后续还有 message_end 收尾,这里不发 result。
      return null;
    }

    // agent_end 与其他事件均忽略：result 已由最后一条 assistant message_end 发出,
    // 若 agent_end 也发会覆盖前面的错误结果。
    return null;
  },
};
