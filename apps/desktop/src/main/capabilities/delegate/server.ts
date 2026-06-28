// 委派（delegate）MCP host：把「本轮被 @ 的协作者」暴露成主 agent 可调用的 ask_<id> 工具，
// 让主 agent 理解意图后**自主**用 function tool call 委派子任务，而非宿主硬编码管线串联。
//
// 架构（KTD/复用 createMcpHost）：
//   · 经 createMcpHost("cortex-delegate") 起独立 HTTP MCP host（独立 port/token），随主进程常驻。
//   · per-turn 动态工具集：ToolRegistrar 每个 HTTP 请求从 sessionStateMap.get(ctx.sessionId) 取
//     本轮 roles，动态 registerTool 每个 ask_<id>。主 agent 每轮 fresh spawn、同 sessionId 更新
//     state → 工具集随本轮 @mention 变化（用户决策：仅限被 @ 的协作者 / 每协作者一个工具）。
//   · handler 在主进程内执行：经 state.runSubAgent（由 cli.ts 注入）spawn 子 agent，await 同步
//     完成，子 agent 输出作为 tool_result 返回主 agent；过程经 state.pushEvent 实时推渲染端（roleId）。
//
// 防递归（核心安全不变量）：
//   子 agent 用 fresh sessionId（randomUUID）spawn 且**从不** registerDelegateSession →
//   ToolRegistrar 取不到 state → 不注册任何 ask_<id> → 子 agent 只有 ping → 无法再委派。
//   这同时天然满足「只有主 agent 能委派 / 仅限被 @ 的协作者」。
//
// 依赖方向（避免与 cli.ts 循环）：本模块**不** import cli.ts 的运行时原语；所有 spawn 能力经
//   DelegateSessionState 的回调（runSubAgent/pushEvent/bumpWatchdog/abort）由 cli.ts 在 cli:start
//   构造并 registerDelegateSession 注入。cli.ts 单向 import 本模块的 register/build/host 函数。

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle } from "../mcp-host/server";
import type { McpServerConfig, RoleConfig, CliStreamEvent } from "../../ipc/types";

// 工具名安全化（与 pi-providers.safeId 同源逻辑，内联以解除 electron 依赖、便于单测）：
// ask_<id> 须为合法 MCP 工具名（仅字母数字 - _）。
export function safeToolId(id: string): string {
  const s = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "role";
}

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（codex -c mcp_servers.<id>）。
export const DELEGATE_SERVER_ID = "cortex-delegate";

// 每协作者本轮调用次数上限：防主 agent 一轮内狂调同一 ask_<id>（R10 资源放大护栏）。
const MAX_CALLS_PER_ROLE = 3;

// 委派 MCP host 实例（独立 port/token，与 browser/doc-extract/media-gen 互不干扰）。
const delegateHost = createMcpHost(DELEGATE_SERVER_ID);

// 子 agent 一次执行的结果。
export interface SubAgentResult {
  text: string;
  ok: boolean;
  error?: string;
}

// ── per-session 运行时状态（由 cli.ts cli:start 构造并注册） ──────────────────────
//
// 与 media-gen 的 sessionStateMap 同构，但 state 含运行时回调（pushEvent/runSubAgent 等），
// 这些只有 cli:start 拿得到 event.sender / AbortController，故 register 由 cli.ts 单独调用，
// 不放进纯函数 buildDelegateMcpServerConfig。
export interface DelegateSessionState {
  sessionId: string;
  runId: string;
  // 本轮被 @ 的协作者 → 决定注册哪些 ask_<id>。
  roles: RoleConfig[];
  // handler 早退检查（主 agent 已取消则不再 spawn 子 agent）。
  signal: AbortSignal;
  // killAllDelegates / 主 agent 退出时取消所有在途子 agent（cli.ts 内部 = controller.abort()）。
  abort: () => void;
  // 把子 agent 事件推渲染端（cli.ts 内部 = sender.send("cli:event", {runId, sessionId, event})，带 isDestroyed 守卫）。
  pushEvent: (ev: CliStreamEvent) => void;
  // 喂主进程 inactivity 看门狗（cli.ts 的看门狗只看主 agent stdout，长子任务期间主 agent 静默会被误杀）。
  bumpWatchdog: () => void;
  // 每角色本轮调用计数（roleId → 次数），防主 agent 一轮内狂调同一协作者（R10）。
  callCounts: Map<string, number>;
  // cli.ts 注入：spawn 子 agent 执行 task。onEvent 实时推送（事件已带 roleId）；signal 由实现闭包捕获。
  runSubAgent: (role: RoleConfig, task: string, onEvent: (ev: CliStreamEvent) => void) => Promise<SubAgentResult>;
}

const sessionStateMap = new Map<string, DelegateSessionState>();

export function registerDelegateSession(state: DelegateSessionState): void {
  // 幂等：同 session 多轮 run 覆盖写（runId/sender/roles 每轮更新）；清理由 unregisterDelegateSession 负责。
  sessionStateMap.set(state.sessionId, state);
}

export function unregisterDelegateSession(sessionId: string): void {
  sessionStateMap.delete(sessionId);
}

// app 退出清理：取消所有在途委派（abort → 各 session 在途子 agent 被杀）。
export function killAllDelegates(): void {
  for (const state of sessionStateMap.values()) {
    try {
      state.abort();
    } catch {
      /* abort 回调异常不阻断其余清理 */
    }
  }
  sessionStateMap.clear();
}

// ── 工具结果构造 ──────────────────────────────────────────────────────────────
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ── 单个 ask_<id> 工具注册 ────────────────────────────────────────────────────
function registerAskTool(mcp: McpServer, role: RoleConfig, state: DelegateSessionState): void {
  const toolName = "ask_" + safeToolId(role.id);
  // description 带角色 persona，帮助主 agent 判断「这是谁、擅长什么、何时该委派给它」（R8）。
  const personaLine = role.systemPrompt ? `角色设定：${role.systemPrompt.slice(0, 240)}。` : "";
  mcp.registerTool(
    toolName,
    {
      description:
        `把一个子任务委派给协作者「${role.label}」（底层 agent：${role.agent}）。${personaLine}` +
        `传入要它独立完成的具体任务描述，它会执行并把结果返回给你，供你整合。`,
      inputSchema: { task: z.string().min(1).describe(`交给协作者「${role.label}」完成的具体任务描述（自然语言）`) },
    },
    async ({ task }: { task: string }): Promise<ToolResult> => {
      if (state.signal.aborted) return errorResult("已取消");
      // 调用次数护栏（R10）：超限拒绝，提示主 agent 整合已有结果或换协作者。
      const used = state.callCounts.get(role.id) ?? 0;
      if (used >= MAX_CALLS_PER_ROLE) {
        return errorResult(
          `协作者「${role.label}」本轮已被委派 ${used} 次（上限 ${MAX_CALLS_PER_ROLE}），请基于已有结果整合，或委派其他协作者。`,
        );
      }
      state.callCounts.set(role.id, used + 1);
      // 先发 init（带 roleId/stageLabel）插入 roleHeader，渲染端据此把该协作者的过程独立成段。
      state.pushEvent({ type: "init", sessionId: state.sessionId, roleId: role.id, stageLabel: role.label });
      // 子 agent 每个事件：转发渲染端（已带 roleId）+ 喂主进程看门狗（防长子任务误杀主 agent，R2）。
      const onEvent = (ev: CliStreamEvent) => {
        state.pushEvent(ev);
        state.bumpWatchdog();
      };
      const result = await state.runSubAgent(role, task, onEvent);
      if (!result.ok) {
        return errorResult(`协作者「${role.label}」执行失败：${result.error ?? "未知错误"}`);
      }
      return textResult(result.text || `（协作者「${role.label}」未产生文本输出）`);
    },
  );
}

// ── host 生命周期 ─────────────────────────────────────────────────────────────
//
// per-request McpServer 在每次 HTTP 请求新建，回调按 ctx.sessionId 取本 session 的 roles。
// 取不到 state（未注册 / 子 agent 的 fresh sessionId）→ 不注册任何 ask_<id>，只剩 ping（防递归）。
export function startDelegateHost(): Promise<McpHostHandle> {
  return delegateHost.start((mcp, ctx) => {
    const state = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
    if (!state) return;
    for (const role of state.roles) {
      registerAskTool(mcp, role, state);
    }
  });
}

export function stopDelegateHost(): void {
  delegateHost.stop();
}

export function getDelegateHostHandle(): McpHostHandle | null {
  return delegateHost.getHandle();
}

// ── 注入配置构建（纯函数；register 由 cli.ts 单独调用） ────────────────────────
//
// 与 media-gen 不同：本函数**不** registerDelegateSession（delegate state 含运行时回调，
// 只有 cli:start 能构造）。这里只产出 http 注入配置（url + Bearer + X-Cortex-Session）。
// host 未起 / 不可用 → 返回 null，注入侧据此不注入（避免给 agent 一个连不上的 url）。
export function buildDelegateMcpServerConfig(sessionId: string | undefined): McpServerConfig | null {
  if (!sessionId) return null;
  const handle = delegateHost.getHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;
  return {
    id: DELEGATE_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "X-Cortex-Session": sessionId,
    },
  };
}
