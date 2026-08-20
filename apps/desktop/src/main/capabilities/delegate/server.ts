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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle } from "../mcp-host/server";
import type { McpServerConfig, RoleConfig, CliStreamEvent } from "../../ipc/types";
import { recordAgentTrace } from "../../ipc/agent-trace";
import {
  DelegationBudgetGuard,
  delegationContractInputShape,
  renderDelegationContract,
  repositoryDelegationContractInputShape,
  validateDelegationTarget,
  type DelegationBudgetTrip,
  type DelegationContract,
  type RepositoryDelegationContract,
} from "./contract";
import { ChildToolLoopGuard, type ChildToolLoopTrip } from "./tool-loop-guard";

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
  // 事件不带 roleId/subagentCallId 过滤标记)。**必填**(审阅修复):渲染端已删除父流兜底的
  // 子会话写入,漏注入会静默产出永久空壳 side 会话——契约交给编译器把关。
  pushChildEvent: (childSessionId: string, callId: string, ev: CliStreamEvent) => void;
  // 喂主进程 inactivity 看门狗（cli.ts 的看门狗只看主 agent stdout，长子任务期间主 agent 静默会被误杀）。
  bumpWatchdog: () => void;
  // 运行策略由设置页投影；主进程注册时仍会归一，避免 renderer 伪造负数或超大值。
  maxParallel: number;
  maxChildRuns: number;
  // 以下字段只属于本轮运行时门闩：先预占子任务配额，再进入并行槽；达到并行上限时 FIFO 排队。
  childRunCount: number;
  activeRuns: number;
  waiters: DelegateWaiter[];
  // 调用入口注入：启动子 agent 执行已校验、规范化的合同 prompt。targetCwd 来自合同根目录，
  // onEvent 实时推送（事件已带 roleId）；signal 由实现闭包捕获。
  runSubAgent: (
    role: RoleConfig,
    task: string,
    onEvent: (ev: CliStreamEvent) => void,
    childSessionId: string,
    signal?: AbortSignal,
    targetCwd?: string,
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
  contract: DelegationContract,
  requestSignal?: AbortSignal,
  options?: { repositoryTarget?: boolean },
): Promise<ToolResult> {
  // SDK 的 request signal 在 HTTP 调用方断开/超时时触发；必须与父回合 signal 合并。
  // 只监听父 signal 会让已取消的排队请求稍后仍获得槽位并启动无主 child。
  const signal = requestSignal && requestSignal !== state.signal
    ? AbortSignal.any([state.signal, requestSignal])
    : state.signal;
  if (signal.aborted) return errorResult("已取消");
  // MCP schema 负责字段级校验；这里再做跨字段与文件系统校验。目标错误必须在消耗 child 配额前
  // 返回，让父 Agent 修正合同，绝不能由独立 child 自行向父目录或用户主目录扩散搜索。
  const targetError = await validateDelegationTarget(contract, {
    requireRootPath: options?.repositoryTarget === true,
    requireNonEmptyRoot: options?.repositoryTarget === true,
  });
  if (targetError) return errorResult(`委派给「${role.label}」失败：${targetError}`);

  let taskText: string;
  try {
    taskText = renderDelegationContract(contract, {
      access: role.toolPolicy === "readOnly" ? "readOnly" : "inherit",
      roleLabel: role.label,
    });
  } catch (error) {
    return errorResult(`委派给「${role.label}」失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const taskTitle = contract.title;
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
  // 父回合/request signal 仍负责级联取消全部或本次请求；额外的 controller 只属于当前 child。
  // 工具循环熔断时只 abort 这一个执行，不得把父会话或同批并行 child 一起终止。
  const childController = new AbortController();
  const childSignal = AbortSignal.any([signal, childController.signal]);
  const toolLoopGuard = new ChildToolLoopGuard();
  const budgetGuard = new DelegationBudgetGuard(contract.constraints);
  let toolLoopTrip: ChildToolLoopTrip | undefined;
  let budgetTrip: DelegationBudgetTrip | undefined;
  // 每一次委派调用都有独立 id：同一角色允许重复委派，UI 必须据此把卡片、预览和详情
  // 严格隔离，不能用 roleId 把三次调用的过程混成一份。
  const subagentCallId = randomUUID();
  // childSessionId 是 Cortex 侧持久 side 会话 id，与原生 agent 的 resume id 分离。后者要等
  // 子进程 init 才能得到；提前分配应用 id 才能在第一帧就创建可进入的独立会话。
  const childSessionId = randomUUID();
  const tripBudget = (trip: DelegationBudgetTrip) => {
    // 先到达的终止原因是权威原因。工具循环已熔断时，几乎同时到期的预算不能覆盖更具体的诊断。
    if (budgetTrip || toolLoopTrip) return;
    budgetTrip = trip;
    recordAgentTrace({
      scope: "delegate",
      phase: "budget",
      summary: `子 Agent「${role.label}」合同预算耗尽`,
      runId: subagentCallId,
      sessionId: childSessionId,
      agent: role.agent,
      data: {
        kind: trip.kind,
        limit: trip.limit,
        observed: trip.observed,
        parentRunId: state.runId,
        parentSessionId: state.sessionId,
      },
    });
    childController.abort(trip.message);
  };
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
    state.pushChildEvent(childSessionId, subagentCallId, { ...ev, roleId: undefined, subagentCallId: undefined });
  };
  // 子流恰好一条 init(合成帧):sessionId 用子会话自己的 id(信封不变量 2——事件里不携带
  // 属于另一个命名空间的字段);原生 init 只进父流,不再双发,避免子会话事件流出现重复 init。
  pushChild({
    type: "init",
    sessionId: childSessionId,
    stage: "subagent",
    stageLabel: role.label,
    childSessionId,
    subagentTask: taskText,
    subagentTitle: taskTitle,
    subagentAgentId: role.agent,
    subagentModel: role.model,
    subagentReadOnly: role.toolPolicy === "readOnly",
  });
  // 子 agent 每个事件：父流转发（已带 roleId）+ 子流双发（init 除外,见上）+ 喂主进程看门狗
  //（防长子任务误杀主 agent，R2）。
  const onEvent = (ev: CliStreamEvent) => {
    // 熔断/预算耗尽后底层进程或 worker 可能仍冲刷少量迟到事件；它们不再属于有效执行过程，
    // 避免继续污染 child 归档。触发限制的那一帧会先正常写入，再设置终止原因。
    if (toolLoopTrip || budgetTrip) return;
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
    if (ev.type !== "init") pushChild(ev);
    state.bumpWatchdog();

    if (ev.type === "tool" && ev.phase === "start") {
      const trip = budgetGuard.recordToolCall();
      if (trip) {
        tripBudget(trip);
        return;
      }
    }

    const trip = toolLoopGuard.observe(ev);
    if (!trip) return;
    toolLoopTrip = trip;
    recordAgentTrace({
      scope: "delegate",
      phase: "watchdog",
      summary: `子 Agent「${role.label}」工具循环熔断`,
      runId: subagentCallId,
      sessionId: childSessionId,
      agent: role.agent,
      // 工具参数和输出可能包含私有路径或凭据，只记录安全摘要；完整调用仍留在现有过程归档中。
      data: {
        kind: trip.kind,
        toolName: trip.toolName,
        repeatCount: trip.repeatCount,
        parentRunId: state.runId,
        parentSessionId: state.sessionId,
      },
    });
    childController.abort(trip.message);
  };
  budgetGuard.start(tripBudget);
  try {
    let result: SubAgentResult;
    try {
      result = await state.runSubAgent(
        role,
        taskText,
        onEvent,
        childSessionId,
        childSignal,
        contract.target.rootPath,
      );
    } catch (err) {
      // runSubAgent 正常把失败收敛为 SubAgentResult；这里仍防御适配器/桥接层意外 reject，
      // 保证主 Agent 收到结构化 tool error，同时 renderer 的卡片能结束而不是永久转圈。
      const message = budgetTrip?.message ?? toolLoopTrip?.message ?? (err instanceof Error ? err.message : String(err));
      pushChild({ type: "result", ok: false, error: message });
      state.pushEvent({ type: "result", ok: false, error: message, roleId: role.id, subagentCallId });
      return errorResult(`协作者「${role.label}」执行失败：${message}`);
    }
    // 某些 adapter 的 kill/abort 只负责请求停止，仍可能以 ok 或通用“已取消”结算；熔断原因是
    // 更具体、可操作的权威终态，且保留失败前的 partial text 供父 Agent 增量接手。
    if (budgetTrip || toolLoopTrip) {
      result = { ...result, ok: false, error: budgetTrip?.message ?? toolLoopTrip?.message };
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
        contractTitle: contract.title,
        objectivePreview:
          contract.objective.length > 300 ? `${contract.objective.slice(0, 300)}…` : contract.objective,
        inScopeCount: contract.inScope.length,
        outOfScopeCount: contract.outOfScope.length,
        maxToolCalls: contract.constraints.maxToolCalls,
        maxDurationMinutes: contract.constraints.maxDurationMinutes,
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
    budgetGuard.dispose();
    releaseDelegateSlot(state);
  }
}

function registerDelegateTool(mcp: McpServer, role: RoleConfig, state: DelegateSessionState): void {
  if (role.id === "explore") {
    mcp.registerTool(
      EXPLORE_AGENT_TOOL_NAME,
      {
        description:
          "Delegate one bounded repository or project investigation to the read-only Repository Explorer. " +
          "Every call requires a complete task contract: concrete objective, absolute target root, explicit in-scope and " +
          "out-of-scope work, runtime budgets, supplied context, deliverable, completion criteria, and blocker conditions. " +
          "The target root must already be known; never use this tool to guess a project by walking parent or home directories. " +
          "Split complex investigations into parallel calls with non-overlapping evidence scopes.",
        inputSchema: repositoryDelegationContractInputShape,
      },
      async (contract: RepositoryDelegationContract, extra): Promise<ToolResult> =>
        executeDelegateTool(role, state, contract, extra.signal, { repositoryTarget: true }),
    );
    return;
  }

  const toolName = "ask_" + safeToolId(role.id);
  // description 带角色 persona，帮助主 agent 判断「这是谁、擅长什么、何时该委派给它」（R8）。
  const personaLine = role.systemPrompt ? `Role profile: ${role.systemPrompt.slice(0, 240)}. ` : "";
  mcp.registerTool(
    toolName,
    {
      description:
        `Delegate one bounded task to collaborator "${role.label}" (runtime: ${role.agent}). ${personaLine}` +
        "The collaborator cannot see the parent conversation. Every call must supply the complete structured task contract: " +
        "objective, target, inScope, outOfScope, constraints, context, deliverable, doneWhen, and blockedWhen. " +
        "The runtime derives and enforces access mode from the selected role.",
      inputSchema: delegationContractInputShape,
    },
    async (contract: DelegationContract, extra): Promise<ToolResult> =>
      executeDelegateTool(role, state, contract, extra.signal),
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
