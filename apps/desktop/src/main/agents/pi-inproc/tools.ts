// in-process 引擎的工具集构造与工具白名单解析（对应 `buildRpcArgs()` 的 `--tools` 一行）。
//
// ── KTD3：`createCodingTools(cwd)` 只给 read/bash/edit/write 四个 ─────────────────────
// `grep` / `find` / `ls` **必须**用 `createGrepTool` / `createFindTool` / `createLsTool` 单独构造。
// 这条不是洁癖：`PI_PLAN_TOOL_WHITELIST`（plan 只读档）恰好依赖这三个，漏掉的表现是
// 「plan 档下这些工具不存在」而**不报错** —— 模型只会说「我没有这个工具」，看起来像模型犯蠢。
//
// ── 一个必须记住的事实（决定了下面两条路各自何时用）────────────────────────────────
// `createAgentSession()` 内部走的是 `createAllToolDefinitions(cwd)`，**七个内建工具全都注册**
// （已核 pi-coding-agent 0.82.1 `core/agent-session.js`），只是默认只激活
// `read/bash/edit/write` 四个。所以：
//   · 走 `createAgentSession({ tools: [...] })` 这条路时，白名单里写 grep/find/ls **是有效的**，
//     不需要我们自己拼工具数组；
//   · 只有需要 `baseToolsOverride` / 自建 Agent（护栏脚本、远端 BashOperations 等自定义运行时）
//     时才需要显式工具数组 —— 那条路正是 KTD3 的踩坑点，故 `createBuiltinTools()` 在此备好。
// 两条路共用同一份 `PI_BUILTIN_TOOL_NAMES`，避免两处漂移。

import { createLogger } from "../../log";
import type { PiCodingAgentModule } from "./runtime";
import type { PiOpenRequest } from "../../ipc/types";

const log = createLogger("pi-inproc-tools");

/**
 * pi 内建工具的全集（与 pi-coding-agent 0.82.1 `tools/index.ts` 的 `allToolNames` 逐字一致）。
 * 顺序按「四个 coding 工具 + 三个只读工具」排，与 KTD3 的分界对齐。
 */
export const PI_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type PiBuiltinToolName = (typeof PI_BUILTIN_TOOL_NAMES)[number];

/** `createCodingTools()` 覆盖到的那四个。列出来是为了让 KTD3 的缺口在代码里可见、可测。 */
export const PI_CODING_TOOL_NAMES: readonly PiBuiltinToolName[] = ["read", "bash", "edit", "write"];

/** `createCodingTools()` **不**覆盖、必须单独构造的三个（plan 只读档正好依赖它们）。 */
export const PI_EXTRA_BUILTIN_TOOL_NAMES: readonly PiBuiltinToolName[] = ["grep", "find", "ls"];

/**
 * 构造七个内建工具的完整数组。
 *
 * 只在需要显式工具数组的场景用（`baseToolsOverride` / 自建 Agent / 打包态护栏脚本）。
 * 走 `createAgentSession()` 的常规路径不需要调它 —— 见文件头说明。
 *
 * 这里刻意**不**用 `createReadOnlyTools()` 去补齐：它给的是 read/grep/find/ls（含重复的 read），
 * 拼起来会得到两个同名 read，`setActiveToolsByName` 之后哪个生效取决于数组顺序，是隐患。
 */
export function createBuiltinTools(mod: PiCodingAgentModule, cwd: string): unknown[] {
  return [
    ...mod.createCodingTools(cwd), // read / bash / edit / write
    mod.createGrepTool(cwd), // ↓ KTD3：这三个 createCodingTools 不给，必须单独造
    mod.createFindTool(cwd),
    mod.createLsTool(cwd),
  ];
}

/** 工具白名单解析结果。`dropped` 用于把「静默消失的工具」变成可观测信号。 */
export interface ResolvedToolWhitelist {
  /**
   * 传给 `createAgentSession({ tools })` / `setActiveToolsByName()` 的名单。
   * `undefined` = 不收窄（缺省全工具，对应 `buildRpcArgs` 不下发 `--tools`）。
   */
  tools?: string[];
  /**
   * 白名单里**不属于 pi 内建工具**的名字。它们不是错误：`PI_PLAN_TOOL_WHITELIST` 本来就并入了
   * browser_* / gui_* / 自动化 / 日历等 MCP 与能力工具，这些要等 U3 的 `customTools` 注册后才存在。
   * 记录下来是为了在「plan 档工具莫名不见」时能一眼看出是注册顺序问题还是名字写错。
   */
  nonBuiltin: string[];
}

/**
 * 把 `PiOpenRequest.toolWhitelist` 解析成 in-process 的工具名单。
 *
 * 语义与 `buildRpcArgs()` 的 `--tools a,b,c` 一致：
 *   · 有白名单 → 只启用列出的工具（accept-edits / full-auto 不收窄，靠审批而非工具集区分）；
 *   · 无白名单 → 返回 undefined，即 pi 默认（read/bash/edit/write + 扩展工具）。
 * 顺带去重并剔空，避免 renderer 传来重复项污染 `setActiveToolsByName` 的名单。
 */
export function resolveToolWhitelist(req: Pick<PiOpenRequest, "toolWhitelist">): ResolvedToolWhitelist {
  const raw = req.toolWhitelist;
  if (!raw?.length) return { nonBuiltin: [] };
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const name of raw) {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n || seen.has(n)) continue;
    seen.add(n);
    tools.push(n);
  }
  if (!tools.length) return { nonBuiltin: [] };
  const builtin = new Set<string>(PI_BUILTIN_TOOL_NAMES);
  return { tools, nonBuiltin: tools.filter((n) => !builtin.has(n)) };
}

/**
 * 运行时切工具集（`AgentSession.setActiveToolsByName`）。
 *
 * 这是 in-process 相对二进制路径的一个**用户可感知**收益：pi 无运行时改工具集的 RPC 命令，
 * 所以旧路径切「plan 只读档」必须重开会话（发送层按模式指纹判定）；in-process 后原地切即可，
 * 上下文不丢。切换在**下一轮 agent turn** 生效（pi 语义），本轮进行中的工具调用不受影响。
 *
 * pi 侧对不认识的名字是**静默忽略**（`setActiveToolsByName` 注释明写 "Unknown tool names are
 * ignored"）—— 这正是 KTD3 那类事故的静默面，所以此处把落差记成 warn。
 */
export function applyActiveTools(
  session: { getAllTools(): Array<{ name: string }>; setActiveToolsByName(names: string[]): void },
  names: string[] | undefined,
): { applied: string[]; missing: string[] } {
  const available = new Set(session.getAllTools().map((t) => t.name));
  const target = names ?? [...PI_CODING_TOOL_NAMES];
  const applied = target.filter((n) => available.has(n));
  const missing = target.filter((n) => !available.has(n));
  session.setActiveToolsByName(applied);
  if (missing.length) {
    // 不抛错：缺工具时让会话带着剩下的工具跑，比整会话失败更接近旧路径行为（--tools 也是静默过滤）。
    log.warn("pi 工具白名单中有未注册的工具（已跳过）", { missing });
  }
  return { applied, missing };
}
