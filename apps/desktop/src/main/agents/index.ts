// Agent CLI adapter 注册表。每种 agent 提供「构造命令行」+「解析输出行」两个
// 纯函数，cli.ts 的 spawn/流式管线对所有 agent 通用。

import type { CliStartRequest, CliStreamEvent } from "../ipc/types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { piAdapter } from "./pi";

export interface AgentAdapter {
  // 返回可执行名与参数。可执行名不带路径，由 cli.ts 结合 PATH 解析。
  buildArgs(req: CliStartRequest): { cmd: string; args: string[] };
  // 解析一行 stdout，返回归一化事件；无法识别的行返回 null（忽略）。
  parseLine(line: string): CliStreamEvent | null;
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
