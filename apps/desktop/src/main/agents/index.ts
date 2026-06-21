// Agent CLI 声明式适配注册表(M2)。每个 agent 是一个声明式 `AgentDef`:两个纯函数
// (buildArgs 构造命令 / parseLine 解析输出)+ 一组**能力位**,公共管线(cli.ts/ask/oneshot/
// automation)按能力位决定 stdin 投递 / MCP 注入 / 会话续接 / 图片 / 系统提示的处理方式,从而
// 对所有 agent 通用、新增 agent 只改其 def。
// 能力位语义(M2 逐单元消费):
//   promptDelivery   投递模式:stdin-stream-json(claude)/ stdin-eof(codex)/ argv(pi)
//   mcpInjection     MCP 注入策略(U2):claude-mcp-json(写 cwd .mcp.json)/ codex-c(-c 注入)/ none
//   sessionResume    续接能力(U4):continue+resume / resume-only / none
//   imageDelivery    图片投递(U5):native-flag(--image)/ prompt-text(拼进文本)/ none
//   appendSystemPrompt 追加系统提示(U5):native-flag(原生 flag)/ prompt-wrap(<user_request> 包裹)/ none

import type { AgentKind, CliStartRequest, CliStreamEvent } from "../ipc/types";
import { claudeDef } from "./claude";
import { codexDef } from "./codex";
import { piDef } from "./pi";

export type PromptDelivery = "stdin-stream-json" | "stdin-eof" | "argv";
export type McpInjection = "claude-mcp-json" | "codex-c" | "none";
export type SessionResume = "continue+resume" | "resume-only" | "none";
export type ImageDelivery = "native-flag" | "prompt-text" | "none";
export type AppendSystemPrompt = "native-flag" | "prompt-wrap" | "none";

export interface AgentDef {
  id: AgentKind;
  // ── 能力位(声明式):公共管线据此分流,adapter 不再各写各的 ──
  promptDelivery: PromptDelivery;
  mcpInjection: McpInjection;
  sessionResume: SessionResume;
  imageDelivery: ImageDelivery;
  appendSystemPrompt: AppendSystemPrompt;
  // ── 两个纯函数 ──
  // 返回可执行名与参数(可执行名不带路径，由 cli.ts 结合 PATH 解析),以及可选的 stdin 负载。
  // stdin 存在时(claude/codex):prompt 经 stdin 投递、不进 argv,绕开命令行长度上限(E2BIG/ENAMETOOLONG);
  // cli.ts 写入后立即 end() 发 EOF。stdin 省略时(pi):prompt 仍在 argv。
  // mcpArgs(U2):公共管线为 mcpInjection:"codex-c" 的 def 预算好的 `-c` 注入参数,def 负责放到正确位置
  //(codex 放进 common,落在位置参数之前);其它 def(claude 文件注入 / pi 不注入)忽略。
  buildArgs(req: CliStartRequest, mcpArgs?: string[]): { cmd: string; args: string[]; stdin?: string };
  // 解析一行 stdout，返回归一化事件；无法识别的行返回 null(忽略)。一行可携带多个事件
  // (如 claude/codex 收尾行同时含 usage 与 result),此时返回数组。
  parseLine(line: string): CliStreamEvent | CliStreamEvent[] | null;
}

// 把 parseLine 的「单事件 | 数组 | null」三态归一为数组,供 spawn 管线统一迭代(cli.ts / ask.ts)。
export function parseLineEvents(def: AgentDef, line: string): CliStreamEvent[] {
  const r = def.parseLine(line);
  return Array.isArray(r) ? r : r ? [r] : [];
}

const AGENT_DEFS: Record<string, AgentDef> = {
  claude: claudeDef,
  codex: codexDef,
  pi: piDef,
};

export function getAgentDef(agent: string): AgentDef {
  const def = AGENT_DEFS[agent];
  if (!def) throw new Error(`未知 agent: ${agent}`);
  return def;
}
