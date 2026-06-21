// Agent CLI adapter 注册表。每种 agent 提供「构造命令行」+「解析输出行」两个
// 纯函数，cli.ts 的 spawn/流式管线对所有 agent 通用。

import type { CliStartRequest, CliStreamEvent } from "../ipc/types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { piAdapter } from "./pi";

export interface AgentAdapter {
  // 返回可执行名与参数(可执行名不带路径，由 cli.ts 结合 PATH 解析),以及可选的 stdin 负载。
  // stdin 存在时(claude/codex):prompt 经 stdin 投递、不进 argv,绕开命令行长度上限(E2BIG/ENAMETOOLONG);
  // cli.ts 写入后立即 end() 发 EOF(cortex 每轮一次 spawn,单发即可)。stdin 省略时(pi):prompt 仍在 argv。
  buildArgs(req: CliStartRequest): { cmd: string; args: string[]; stdin?: string };
  // 解析一行 stdout，返回归一化事件；无法识别的行返回 null（忽略）。
  // 一行可携带多个归一化事件(如 claude/codex 的收尾行同时含 usage 与 result),此时返回数组。
  parseLine(line: string): CliStreamEvent | CliStreamEvent[] | null;
}

// 把 parseLine 的「单事件 | 数组 | null」三态归一为数组,供 spawn 管线统一迭代(cli.ts / ask.ts)。
export function parseLineEvents(adapter: AgentAdapter, line: string): CliStreamEvent[] {
  const r = adapter.parseLine(line);
  return Array.isArray(r) ? r : r ? [r] : [];
}

const ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
};

export function getAdapter(agent: string): AgentAdapter {
  const adapter = ADAPTERS[agent];
  if (!adapter) throw new Error(`未知 agent: ${agent}`);
  return adapter;
}
