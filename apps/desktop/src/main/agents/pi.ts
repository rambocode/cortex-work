// pi（@earendil-works/pi-coding-agent）内置兜底 agent 的 CLI adapter。
// 命令形态（实测 0.79.2,pi 已 bun 编译成自包含二进制,由 cli.ts 经 spawn 执行）：
//   <pi 二进制> --mode json -p --no-extensions
//             [--no-skills] [--skill p] [--tools read,grep,find,ls (plan 只读)]
//             [--model m] [--session id] [--append-system-prompt s] <prompt>
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
import { safeId } from "./pi-providers";
import { PI_PLAN_TOOL_WHITELIST, type CliStartRequest, type CliStreamEvent } from "../ipc/types";
import type { AgentDef } from "./index";

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

function safeDelegateToolId(id: string): string {
  const s = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "role";
}

function planToolWhitelist(req: CliStartRequest): string[] {
  const delegateTools = (req.delegateRoles ?? []).map((role) => `ask_${safeDelegateToolId(role.id)}`);
  return [...PI_PLAN_TOOL_WHITELIST, ...delegateTools];
}

// agent_start/turn_start/turn_end/agent_end/message_start:已评审过、故意忽略的帧(见文件头
// 注释第 15/150-151 行),不是 parseLineEvents 盲区补点想告警的"新协议漂移",故声明进
// ignoredFrameTypes,让盲区补点跳过它们,不刷屏。
const IGNORED_FRAME_TYPES = new Set(["agent_start", "turn_start", "turn_end", "agent_end", "message_start"]);

export const piDef: AgentDef = {
  id: "pi",
  // 能力位:pi 是自包含二进制,prompt 走 argv 位置参数;不注入 MCP(走自身扩展);续接用 --session;
  // 无图片处理;appendSystemPrompt 原生 flag。
  promptDelivery: "argv",
  ignoredFrameTypes: IGNORED_FRAME_TYPES,
  mcpInjection: "none",
  sessionResume: "resume-only",
  imageDelivery: "none",
  appendSystemPrompt: "native-flag",
  buildArgs(req: CliStartRequest): { cmd: string; args: string[] } {
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-extensions",
    ];
    // 插件管理:--no-skills 随 useOwnSkills gate,与 claude adapter 的 --disable-slash-commands 对齐。
    //   · useOwnSkills!==true(缺省/关闭）→ 加 --no-skills 关掉 pi 原生自动发现(会话级一键关);
    //   · useOwnSkills===true → 省略 --no-skills,放开 pi 自身原生 skill 发现(~/.pi/agent/skills、
    //     ~/.agents/skills、项目 .pi/skills / .agents/skills),让 pi 用「各自原生目录」,与
    //     claude/codex 放开各自 CLI 原生发现的行为一致(修复三端不一致:此前 pi 恒关原生、只被
    //     强喂系统配置目录路径,claude/codex 却已放开原生 → 表现为「pi 用系统配置、claude/codex 用自带」)。
    // 无论开关,Cortex 已启用集合仍逐个 --skill 附加注入（实测 --no-skills 与显式 --skill 共存;
    // 开启原生时二者并存 = 原生发现 + Cortex 桥接,与 claude「原生 + --add-dir 桥接」混合模型同构）。
    if (req.useOwnSkills !== true) args.push("--no-skills");
    for (const p of req.skillPaths ?? []) args.push("--skill", p);
    // 运行模式 plan 档:只读工具白名单（pi 官方钦定 read-only 配方,物理上无 write/edit/bash）。
    // json 单发(ask 追问/oneshot)无 UI,审批 hook 失效,故只有 plan 的工具白名单有意义;
    // accept-edits/full-auto 在单发模式等价(不收窄工具)。RPC 长驻路径走 buildRpcArgs 的 toolWhitelist。
    if (req.permissionMode === "plan") args.push("--tools", planToolWhitelist(req).join(","));
    // 自定义供应商 + 委派桥接:cli.ts 已生成 extension 文件,这里多 `-e` 显式加载 + `-a` 整批信任
    //（实测 --no-extensions 与多个显式 -e 共存,-a 只加一次,仿 pi-rpc.ts buildRpcArgs）。
    //   · piExtensionPath = provider extension（apiKey 端点）
    //   · extraExtensionPaths = 委派单发的 delegate 桥接（挂 ask_<id> 工具）等
    const exts = [req.piExtensionPath, ...(req.extraExtensionPaths ?? [])].filter((p): p is string => !!p);
    if (exts.length) {
      for (const p of exts) args.push("-e", p);
      args.push("-a");
      // provider 名必须用 safeId（与 pi-providers.registerProvider 注册名同源,id 含空格/大写时才选得中）。
      if (req.provider) args.push("--provider", safeId(req.provider.id));
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
