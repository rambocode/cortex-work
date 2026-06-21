// Agent CLI 声明式适配注册表(M2)。每个 agent 是一个声明式 `AgentDef`:两个纯函数
// (buildArgs 构造命令 / parseLine 解析输出)+ 一组**能力位**。
// 能力位当前的消费情况(避免误读):
//   - mcpInjection 由公共管线(cli.ts)真正消费 —— spawn 前按它 + 全局开关决定 MCP 注入方式(U2)。
//   - 其余位(promptDelivery / sessionResume / imageDelivery / appendSystemPrompt)目前是**声明式文档**:
//     如实描述各 adapter 在自己 buildArgs 内的处理策略,管线尚未据此分流(分支仍内联在 adapter)。
//     后续可按需把对应分流上提到公共管线;在此之前它们是 def 的「策略说明」,不是已生效的管线开关。
// 能力位取值:
//   promptDelivery   stdin-stream-json(claude)/ stdin-eof(codex)/ argv(pi)
//   mcpInjection     claude-mcp-json(写 cwd .mcp.json)/ codex-c(-c 注入)/ none  ← 管线消费
//   sessionResume    continue+resume / resume-only / none
//   imageDelivery    native-flag(--image)/ prompt-text(拼进文本)/ none
//   appendSystemPrompt native-flag(原生 flag)/ prompt-wrap(<user_request> 包裹)/ none

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
  // ── 能力位(声明式)。mcpInjection 由公共管线消费;其余位描述各 adapter 自身策略(见文件头注释)──
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
