// 委派（delegate）MCP host：把「本轮被 @ 的协作者」暴露成主 agent 可调用的 MCP 工具，
// 让主 agent 理解意图后**自主**用 function tool call 委派子任务，而非宿主硬编码管线串联。
//
// 架构（KTD/复用 createMcpHost）：
//   · 经 createMcpHost("cortex-delegate") 起独立 HTTP MCP host（独立 port/token），随主进程常驻。
//   · per-turn 动态工具集：ToolRegistrar 每个 HTTP 请求从 sessionStateMap.get(ctx.sessionId) 取
//     本轮 roles，动态 registerTool 每个 ask_<id>。主 agent 每轮 fresh spawn、同 sessionId 更新
//     state → 工具集随本轮 @mention 变化（用户决策：仅限被 @ 的协作者 / 每协作者一个工具）。
//   · handler 在主进程内执行：经 state.runSubAgent（由 cli.ts / pi-delegate.ts 注入）启动子 agent，await 同步
//     完成，子 agent 输出作为 tool_result 返回主 agent；过程经 state.pushEvent 实时推渲染端（roleId）。
//
// 防递归（核心安全不变量）：
//   子 agent 用 fresh sessionId（randomUUID）spawn 且**从不** registerDelegateSession →
//   ToolRegistrar 取不到 state → 不注册任何 ask_<id> → 子 agent 只有 ping → 无法再委派。
//   这同时天然满足「只有主 agent 能委派 / 仅限被 @ 的协作者」。
//
// 依赖方向（避免与 cli.ts 循环）：本模块**不** import cli.ts 的运行时原语；所有 spawn 能力经
//   DelegateSessionState 的回调（runSubAgent/pushEvent/bumpWatchdog/abort）由 cli.ts（CLI 单发）或
//   pi-delegate.ts（Pi gateway 长驻会话）在各自入口构造并 registerDelegateSession 注入；本模块不反向
//   import 任一 IPC 入口，依赖仍保持单向。

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle } from "../mcp-host/server";
import type { McpServerConfig, RoleConfig, CliStreamEvent } from "../../ipc/types";
import { recordAgentTrace } from "../../ipc/agent-trace";

// 工具名安全化（与 pi-providers.safeId 同源逻辑，内联以解除 electron 依赖、便于单测）：
// ask_<id> 须为合法 MCP 工具名（仅字母数字 - _）。
export function safeToolId(id: string): string {
  const s = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "role";
}

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（codex -c mcp_servers.<id>）。
export const DELEGATE_SERVER_ID = "cortex-delegate";
/** Repository Explorer 与 Kun 保持一致的一等工具名。 */
export const EXPLORE_AGENT_TOOL_NAME = "explore_agent";

const DEFAULT_MAX_PARALLEL = 256;
const DEFAULT_MAX_CHILD_RUNS = 25;
const MAX_PARALLEL_LIMIT = 256;
const MAX_CHILD_RUNS_LIMIT = 10_000;

// 委派 MCP host 实例（独立 port/token，与 browser/doc-extract/media-gen 互不干扰）。
const delegateHost = createMcpHost(DELEGATE_SERVER_ID);
let delegateHostStartPromise: Promise<McpHostHandle> | null = null;

// 子 agent 一次执行的结果。
export interface SubAgentResult {
  text: string;
  ok: boolean;
  error?: string;
}

// ── per-session 运行时状态（由 cli.ts / pi-delegate.ts 构造并注册） ─────────────────
//
// 与 media-gen 的 sessionStateMap 同构，但 state 含运行时回调（pushEvent/runSubAgent 等），
// 这些只有调用入口拿得到 sender / AbortController，故 register 由 cli.ts 或 pi-delegate.ts 调用，
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
  // 把子 agent 事件推渲染端（cli.ts / pi-delegate.ts 经 sendRunEvent 发父会话信封）。
  pushEvent: (ev: CliStreamEvent) => void;
  // 信封归一 P2(双发):子会话完整过程的独立信封(sessionId=childSessionId,runId=callId,
  // 事件不带 roleId/subagentCallId 过滤标记)。未注入时(旧调用方)渲染端只有父流卡片语义。
  pushChildEvent?: (childSessionId: string, callId: string, ev: CliStreamEvent) => void;
  // 喂主进程 inactivity 看门狗（cli.ts 的看门狗只看主 agent stdout，长子任务期间主 agent 静默会被误杀）。
  bumpWatchdog: () => void;
  // 运行策略由设置页投影；主进程注册时仍会归一，避免 renderer 伪造负数或超大值。
  maxParallel: number;
  maxChildRuns: number;
  // 以下字段只属于本轮运行时门闩：先预占子任务配额，再进入并行槽；达到并行上限时 FIFO 排队。
  childRunCount: number;
  activeRuns: number;
  waiters: DelegateWaiter[];
  // 调用入口注入：启动子 agent 执行 task。onEvent 实时推送（事件已带 roleId）；signal 由实现闭包捕获。
  runSubAgent: (
    role: RoleConfig,
    task: string,
    onEvent: (ev: CliStreamEvent) => void,
    childSessionId: string,
    signal?: AbortSignal,
  ) => Promise<SubAgentResult>;
}

type DelegateWaiter = {
  resolve: (acquired: boolean) => void;
  onAbort: () => void;
  signal: AbortSignal;
};

const sessionStateMap = new Map<string, DelegateSessionState>();

export function registerDelegateSession(state: DelegateSessionState): void {
  // 幂等：同 session 多轮 run 覆盖写（runId/sender/roles 每轮更新）；清理由 unregisterDelegateSession 负责。
  state.maxParallel = normalizeLimit(state.maxParallel, DEFAULT_MAX_PARALLEL, MAX_PARALLEL_LIMIT);
  state.maxChildRuns = normalizeLimit(state.maxChildRuns, DEFAULT_MAX_CHILD_RUNS, MAX_CHILD_RUNS_LIMIT);
  sessionStateMap.set(state.sessionId, state);
}

export function unregisterDelegateSession(sessionId: string, expectedState?: DelegateSessionState): void {
  // 同 sessionId 的新一轮可能已覆盖旧 state；旧运行迟到收尾时只能删除自己，不能把新一轮
  // 的 ask_* 工具一起摘掉。未传 expectedState 保留管理/测试侧“按 id 强制注销”的既有语义。
  if (expectedState && sessionStateMap.get(sessionId) !== expectedState) return;
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

function normalizeLimit(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/**
 * 获取本轮委派的并行槽。已满时按到达顺序等待；主会话取消会移除等待者并返回 false，
 * 避免一个永远不会启动的子任务把 MCP tool call 悬挂到进程退出。
 */
async function acquireDelegateSlot(state: DelegateSessionState, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (state.activeRuns < state.maxParallel) {
    state.activeRuns += 1;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const waiter: DelegateWaiter = {
      resolve,
      onAbort: () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        resolve(false);
      },
      signal,
    };
    state.waiters.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

/** 释放一个槽并唤醒首个仍有效的等待者；槽位转交在同一同步段完成，不会短暂超发。 */
function releaseDelegateSlot(state: DelegateSessionState): void {
  state.activeRuns = Math.max(0, state.activeRuns - 1);
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift()!;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.resolve(false);
      continue;
    }
    state.activeRuns += 1;
    waiter.resolve(true);
    break;
  }
}

// ── 单个委派工具执行与注册 ────────────────────────────────────────────────────
async function executeDelegateTool(
  role: RoleConfig,
  state: DelegateSessionState,
  task: string,
  subagentTitle?: string,
  requestSignal?: AbortSignal,
): Promise<ToolResult> {
  // SDK 的 request signal 在 HTTP 调用方断开/超时时触发；必须与父回合 signal 合并。
  // 只监听父 signal 会让已取消的排队请求稍后仍获得槽位并启动无主 child。
  const signal = requestSignal && requestSignal !== state.signal
    ? AbortSignal.any([state.signal, requestSignal])
    : state.signal;
  if (signal.aborted) return errorResult("已取消");
  // task/query 必须自包含；空输入直接返回明确错误，避免独立子进程因拿不到主会话上下文而无效退出。
  const taskText = typeof task === "string" ? task.trim() : "";
  if (!taskText) {
    return errorResult(
      `委派给「${role.label}」失败：任务为空。请提供完整的任务描述，并附上协作者所需的` +
        `全部数据/材料——它是独立进程，看不到你当前对话的内容。`,
    );
  }
  const taskTitle = subagentTitle?.trim() || undefined;
  // 单会话子任务上限是总量护栏，不限制同一角色的合理重复调用；是否调用多少次仍由模型决定。
  // JS handler 的检查与递增处于同一同步段，并发 tool call 也不会共同越过上限。
  if (state.childRunCount >= state.maxChildRuns) {
    return errorResult(
      `本轮已创建 ${state.childRunCount} 个子任务（上限 ${state.maxChildRuns}），请基于已有结果完成回答。`,
    );
  }
  state.childRunCount += 1;
  const acquired = await acquireDelegateSlot(state, signal);
  if (!acquired) return errorResult("已取消");
  // 每一次 ask 调用都有独立 id：同一角色允许重复委派，UI 必须据此把卡片、预览和详情
  // 严格隔离，不能用 roleId 把三次调用的过程混成一份。
  const subagentCallId = randomUUID();
  // childSessionId 是 Cortex 侧持久 side 会话 id，与原生 agent 的 resume id 分离。后者要等
  // 子进程 init 才能得到；提前分配应用 id 才能在第一帧就创建可进入的独立会话。
  const childSessionId = randomUUID();
  // 先发 init（带 roleId/stageLabel）插入 roleHeader，渲染端据此把该协作者的过程独立成段。
  // stage=subagent 是 HMR/刷新恢复标识：renderer 内存中的 run.delegate 丢失后，仍能把后续
  // roleId 事件识别为子代理卡片，而不是误当成圆桌角色消息。
  state.pushEvent({
    type: "init",
    sessionId: state.sessionId,
    roleId: role.id,
    stage: "subagent",
    stageLabel: role.label,
    subagentCallId,
    childSessionId,
    subagentTask: taskText,
    subagentTitle: taskTitle,
    subagentAgentId: role.agent,
    subagentModel: role.model,
    subagentReadOnly: role.toolPolicy === "readOnly",
  });
  // 信封归一 P2(双发):子会话过程走独立信封,事件剥净父会话过滤标记(roleId/subagentCallId),
  // 渲染端按信封 sessionId/runId 直接归属,不再从父流标记推断。init 保留 child 元数据字段
  // (childSessionId/subagentTask 等),它们是子会话自己的语境,不是路由标记。
  const pushChild = (ev: CliStreamEvent) => {
    state.pushChildEvent?.(childSessionId, subagentCallId, { ...ev, roleId: undefined, subagentCallId: undefined });
  };
  pushChild({
    type: "init",
    sessionId: state.sessionId,
    stage: "subagent",
    stageLabel: role.label,
    childSessionId,
    subagentTask: taskText,
    subagentTitle: taskTitle,
    subagentAgentId: role.agent,
    subagentModel: role.model,
    subagentReadOnly: role.toolPolicy === "readOnly",
  });
  // 子 agent 每个事件：父流转发（已带 roleId）+ 子流双发 + 喂主进程看门狗（防长子任务误杀主 agent，R2）。
  const onEvent = (ev: CliStreamEvent) => {
    state.pushEvent({
      ...ev,
      roleId: role.id,
      subagentCallId,
      // 子进程 init 同样携带应用侧 child id，使 renderer HMR 后只收到后续帧时仍能恢复父子绑定。
      ...(ev.type === "init" ? {
        childSessionId,
        subagentTask: taskText,
        subagentTitle: taskTitle,
        subagentAgentId: role.agent,
        subagentModel: ev.subagentModel ?? role.model,
        subagentReadOnly: role.toolPolicy === "readOnly",
      } : {}),
    });
    pushChild(ev.type === "init" ? {
      ...ev,
      childSessionId,
      subagentTask: taskText,
      subagentTitle: taskTitle,
      subagentAgentId: role.agent,
      subagentModel: ev.subagentModel ?? role.model,
      subagentReadOnly: role.toolPolicy === "readOnly",
    } : ev);
    state.bumpWatchdog();
  };
  try {
    let result: SubAgentResult;
    try {
      result = await state.runSubAgent(role, taskText, onEvent, childSessionId, signal);
    } catch (err) {
      // runSubAgent 正常把失败收敛为 SubAgentResult；这里仍防御适配器/桥接层意外 reject，
      // 保证主 Agent 收到结构化 tool error，同时 renderer 的卡片能结束而不是永久转圈。
      const message = err instanceof Error ? err.message : String(err);
      pushChild({ type: "result", ok: false, error: message });
      state.pushEvent({ type: "result", ok: false, error: message, roleId: role.id, subagentCallId });
      return errorResult(`协作者「${role.label}」执行失败：${message}`);
    }
    recordAgentTrace({
      scope: "delegate",
      phase: "context-return",
      summary: `子 Agent「${role.label}」结果回传主会话`,
      runId: state.runId,
      sessionId: state.sessionId,
      agent: role.agent,
      data: {
        roleId: role.id,
        taskPreview: taskText.length > 300 ? `${taskText.slice(0, 300)}…` : taskText,
        resultPreview:
          result.text.length > 300 ? `${result.text.slice(0, 300)}…` : result.text,
        ok: result.ok,
        returnedToMain: true,
      },
    });
    if (!result.ok) {
      pushChild({ type: "result", ok: false, error: result.error ?? "未知错误" });
      state.pushEvent({
        type: "result",
        ok: false,
        error: result.error ?? "未知错误",
        roleId: role.id,
        subagentCallId,
      });
      // token 经济性：失败前的部分输出一并带回。主 Agent 可据此判断已完成多少、只补做缺口，
      // 而不是把整个子任务从零重跑一遍（超时/取消的长任务往往已完成大半）。
      const partial = result.text?.trim();
      return errorResult(
        `协作者「${role.label}」执行失败：${result.error ?? "未知错误"}` +
          (partial
            ? `\n\n[失败前的部分输出（截取末尾），可据此增量补做，避免整体重跑]\n${partial.slice(-4000)}`
            : ""),
      );
    }
    // 子进程的原始 result 在 cli.ts 内部收口，不直接转发；由 delegate host 在 tool_result
    // 返回主 Agent 前补发一次角色级完成帧，驱动会话卡片从“进行中”进入完成态。
    // 子流 result 先于父流:渲染端先收尾子会话过程/归档,父卡片终态随后到达。
    pushChild({ type: "result", ok: true, text: result.text });
    state.pushEvent({ type: "result", ok: true, text: result.text, roleId: role.id, subagentCallId });
    return textResult(result.text || `（协作者「${role.label}」未产生文本输出）`);
  } finally {
    // 成功、失败和适配器异常都必须释放并行槽，否则后续排队任务会永久挂起。
    releaseDelegateSlot(state);
  }
}

function registerDelegateTool(mcp: McpServer, role: RoleConfig, state: DelegateSessionState): void {
  if (role.id === "explore") {
    mcp.registerTool(
      EXPLORE_AGENT_TOOL_NAME,
      {
        description:
          "Use this first for any repository or project exploration. " +
          "Complex questions MUST be split into multiple parallel explore_agent calls with non-overlapping scopes " +
          "(for example one call for API wiring, another for UI, another for tests). " +
          "Never pack a whole-repo investigation into a single call. " +
          "Each call needs a short distinct title (2-6 words) and a narrow self-contained query. " +
          "整项目分析要先枚举所有适用的独立证据面，例如产品定位、后端或核心实现、前端交互、测试与完成度；" +
          "不得为了减少调用次数把彼此独立的证据面合并。拆分数量由问题范围动态决定，不得固定调用次数。",
        inputSchema: {
          title: z.string().min(1).describe("本次探索的简短标题，建议 2-6 个词，用于子 Agent 卡片和会话标题。"),
          query: z.string().min(1).describe("范围明确且自包含的只读探索任务；子 Agent 看不到主会话上下文。"),
        },
      },
      async ({ title, query }: { title: string; query: string }, extra): Promise<ToolResult> =>
        executeDelegateTool(role, state, query, title, extra.signal),
    );
    return;
  }

  const toolName = "ask_" + safeToolId(role.id);
  // description 带角色 persona，帮助主 agent 判断「这是谁、擅长什么、何时该委派给它」（R8）。
  const personaLine = role.systemPrompt ? `角色设定：${role.systemPrompt.slice(0, 240)}。` : "";
  mcp.registerTool(
    toolName,
    {
      description:
        `把一个子任务委派给协作者「${role.label}」（底层 agent：${role.agent}）。${personaLine}` +
        `⚠️ 协作者是一个独立进程，看不到你当前对话的任何上下文——你必须在 task 参数里写明完整的任务描述，` +
        `并附上它完成任务所需的全部数据/材料（例如你已搜集到的内容）。它执行后会把结果返回给你，供你整合。`,
      inputSchema: {
        task: z.string().min(1).describe(
          `交给协作者「${role.label}」的完整任务描述，必须自包含：写清要做什么 + 附上所需的全部数据/材料` +
            `（协作者看不到你的对话上下文，凡未写进 task 的信息它都拿不到）。`,
        ),
      },
    },
    async ({ task }: { task: string }, extra): Promise<ToolResult> =>
      executeDelegateTool(role, state, task, undefined, extra.signal),
  );
}

// ── host 生命周期 ─────────────────────────────────────────────────────────────
//
// per-request McpServer 在每次 HTTP 请求新建，回调按 ctx.sessionId 取本 session 的 roles。
// 取不到 state（未注册 / 子 agent 的 fresh sessionId）→ 不注册任何 ask_<id>，只剩 ping（防递归）。
export function startDelegateHost(): Promise<McpHostHandle> {
  if (delegateHost.getHandle()) return delegateHost.start();
  if (delegateHostStartPromise) return delegateHostStartPromise;
  delegateHostStartPromise = delegateHost.start((mcp, ctx) => {
    const state = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
    // 诊断：pi 桥接每次请求时，host 是否按 X-Cortex-Session 找到 session state（决定是否注册 ask_<id>）。
    try {
      process.stderr.write(
        "[delegate-host] req session=" + ctx.sessionId +
          " known=[" + Array.from(sessionStateMap.keys()).join(",") + "]" +
          " state=" + (state ? "FOUND roles=" + state.roles.map((r) => r.id).join(",") : "NOT-FOUND") + "\n",
      );
    } catch (e) { /* 诊断写失败忽略 */ }
    if (!state) return;
    for (const role of state.roles) {
      registerDelegateTool(mcp, role, state);
    }
  });
  delegateHostStartPromise.finally(() => {
    delegateHostStartPromise = null;
  });
  return delegateHostStartPromise;
}

export function stopDelegateHost(): void {
  delegateHostStartPromise = null;
  delegateHost.stop();
}

export function getDelegateHostHandle(): McpHostHandle | null {
  return delegateHost.getHandle();
}

// ── 注入配置构建（纯函数；register 由 cli.ts 单独调用） ────────────────────────
//
// 与 media-gen 不同：本函数**不** registerDelegateSession（delegate state 含运行时回调，
// 只能由 cli:start / pi:open 构造）。这里只产出 http 注入配置（url + Bearer + X-Cortex-Session）。
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

export async function ensureDelegateMcpServerConfig(sessionId: string | undefined): Promise<McpServerConfig | null> {
  if (!sessionId) return null;
  let cfg = buildDelegateMcpServerConfig(sessionId);
  if (cfg) return cfg;
  const handle = await startDelegateHost();
  if (!handle.serverAvailable) return null;
  cfg = buildDelegateMcpServerConfig(sessionId);
  return cfg;
}
