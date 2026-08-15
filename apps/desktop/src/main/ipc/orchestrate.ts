// 主 agent 编排子 agent 三段式执行链路（个人工作区 chat 专属）。
//
// 架构说明（KTD1/KTD2）：
//   - 主进程内串行三段（意图理解→子 agent 执行→二次加工），渲染端只见单一 orchestration runId。
//   - 直接组合 startAgentProcess + pipeStdoutLines + parseLineEvents 三原语（不抽象 runPromptHeadless、
//     不修改该文件），各段行处理闭包捕获 sender 与本段 stage。
//
// 进程注册表隔离（KTD5）：
//   - 编排子进程注册到本模块自有 Set（orchestrationProcs），绝不进 cli.ts 的 running Map。
//   - 理由：cli:kill 只查 running Map，对编排子进程无效，会留孤立进程；编排取消走独立
//     orchestrate:kill → AbortController.abort() 通道。
//   - killAllOrchestrations() 导出供 register.ts 接入 app 退出钩子。
//
// 事件路由（KTD4）：
//   - 各段事件加 stage 字段后经 cli:event 推渲染端；渲染端按 stage 决定去向（过程面板 vs 聊天流）。
//   - 中间段（intent/subagent）的 result 事件不转发——转发会触发渲染端 finalizeRun，
//     使后续事件被丢弃（对应 run 已不在 runs Map 中）。
//   - 三段全部完成后推一次合成 result(ok:true) + cli:exit，渲染端据此识别终态。
//
// 失败降级（KTD7）：
//   1. 段1失败 → 静默回退，用原始输入作段2 prompt（不通知用户，意图理解是增强层）。
//   2. 段2失败有错误文本 → 进段3 prompt，主 agent 解释/降级。
//   3. 段2失败无输出 → 连锁兜底，段3直答原始问题 + 说明执行失败。
//   4. 段3失败 → 段2结果落消息流 + 独立友好错误消息。
//   5. 分段超时：意图/二次加工 60s，子执行 30min。
//
// 与 workflow runtime 的边界：
//   三段编排等价于固定拓扑工作流，但有意不复用图执行器（chat 编排对单 runId/看门狗/typing
//   有专属耦合，分层独立，防止未来误合并）。
//
// pi 引擎（已收敛，docs/plans/2026-08-06-001-refactor-pi-gateway-worker-plan.md）：
//   `runPiStage` 无条件走 `openPiGatewaySession` —— 三段共享常驻 gateway worker，
//   编排从 3~6 个进程降到 1 个。事件映射 / settle / 超时 / 取消 / 释放路径全部只依赖
//   `PiSessionEngine` 契约。历史上的 binary（spawnPiRpc 子进程）与 in-process（主进程
//   createAgentSession）两条选路已删除。
//
// ⚠️ 并发与资源释放：
//   编排会**并发起多个 pi 会话**（多条链路 × 每条三段），如今共享同一个常驻 worker——
//   旧 spawn 时代每段独立子进程、忘了清理也会自己退出；现在漏释放 = worker 里那份会话
//   （agent loop / MCP 连接 / 挂起对话框）与主进程侧句柄永久驻留。三条防线：
//     1. **会话内异常**由引擎层四道闸兜住（事件泵 try/catch、命令 run() 包裹、prompt 补发 error
//        终态、stop() 解挂起对话框），一个会话炸掉不会冒进 agent loop 或主进程；
//     2. **会话生命周期**统一交给 `orchestrationPiSessions` 租约表（agents/pi-inproc/session-pool.ts），
//        它负责构造期竞态、abort→stop 的释放顺序、批量释放的逐项故障隔离；
//     3. **段级终态**永远有兜底：超时定时器 + abort 监听 + 事件流 result/error，三者任一到达即
//        settle 并释放会话，绝不存在「等一个永远不来的终态」。

import { ipcMain } from "electron";
import { randomUUID } from "crypto";
import type { AgentProcess } from "./cli";
import {
  assertSpawnCwd,
  pipeStdoutLines,
  spawnEnvForDef,
  startAgentProcess,
} from "./cli";
import { getAgentDef, parseLineEvents } from "../agents";
// 纯类型 import(运行时擦除):不把 pi-inproc barrel 拖进本模块的运行时依赖图。
import type { PiSessionEngine } from "../agents/pi-inproc";
import { openPiGatewaySession } from "../agents/pi-gateway/client";
import { createPiSessionPool } from "../agents/pi-inproc/session-pool";
import { CODEX_MCP_CLEAR } from "./mcp-config";
import {
  clearTransientPiUiRequestsForSession,
  preparePiOpenRequest,
  registerTransientPiUiRequest,
} from "./pi-session";
import { createLogger } from "../log";
import type { CliExitEvent, CliStartRequest, CliStreamEvent, PiOpenRequest, PiSessionEvent, PiUiRequest } from "./types";

const log = createLogger("orchestrate");

// ── 分段超时常量 ────────────────────────────────────────────────────────────
// 意图理解与二次加工属于「轻量 prompt 转换」，60s 足够，过长说明出问题。
// 子 agent 执行属于真实任务执行，可能含长工具链，对齐 AI 节点 30 分钟上限。
export const INTENT_TIMEOUT_MS = 60_000;       // 60s：意图理解段
export const REFINE_TIMEOUT_MS = 60_000;       // 60s：二次加工段
export const SUBAGENT_TIMEOUT_MS = 30 * 60_000; // 30min：子 agent 执行段

// 单段输出文本上限（防内存无限膨胀，对齐 run-prompt-headless.ts 的 MAX_OUTPUT）。
const MAX_STAGE_OUTPUT = 200_000;

type OrchestrateStage = "intent" | "subagent" | "refine";

// ── 独立进程注册表 ────────────────────────────────────────────────────────────
// activeOrchestrations: runId → AbortController（链路级取消通道）。
// orchestrationProcs: 所有在途子进程（跨链路），供 killAllOrchestrations 统一终止。
const activeOrchestrations = new Map<string, AbortController>();
const orchestrationProcs = new Set<AgentProcess>();

/**
 * 在途 pi 子会话（gateway handle）的租约表。
 *
 * 释放语义：`clearTransientPiUiRequestsForSession` → 摘表 → `stop()`。gateway 的 `stop()`
 * 发 `closeSession`，worker 侧先 abort 在途 run 再停会话——取消/超时后子 agent 不会继续
 * 在后台跑工具、烧 token，故这里不需要额外的 abortOnRelease。
 */
const orchestrationPiSessions = createPiSessionPool<PiSessionEngine>({
  onBeforeRelease: (session) => clearTransientPiUiRequestsForSession(session),
  onError: (phase, err) => {
    log.warn("编排 pi 会话释放失败（已隔离，不影响其余会话）", {
      phase,
      error: err instanceof Error ? err.message : String(err),
    });
  },
});

/**
 * 终止所有在途编排子进程 / 子会话（应用退出 / stop-run 时调用）。
 * 对齐 killAllHeadlessPrompts / killAllCli 的统一语义。
 * 由 register.ts 导出，接入 app 退出钩子（与 killAllAutomations / killAllWorkflows 并列）。
 *
 * 逐项 try/catch 的理由：本函数跑在「不可失败」的退出路径上，而 `controller.abort()` 会**同步**
 * 触发各链路的 abort 监听器（→ settle → 释放会话）。任何一条链路抛错都会让 for 循环中断，
 * 剩下的链路连终止都没轮到。漏掉的不是「会自己退出的子进程」，而是常驻 worker 里
 * 永久挂着的会话资源 —— 故这里必须逐项隔离。
 */
export function killAllOrchestrations(): void {
  for (const controller of activeOrchestrations.values()) {
    try {
      controller.abort();
    } catch (err) {
      log.warn("编排链路终止失败（已隔离）", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const proc of orchestrationProcs) {
    try {
      proc.kill();
    } catch (err) {
      log.warn("编排子进程终止失败（已隔离）", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  orchestrationPiSessions.releaseAll();
  activeOrchestrations.clear();
  orchestrationProcs.clear();
}

// ── 系统提示词 ──────────────────────────────────────────────────────────────

// 段1：意图理解提示词。
// 把用户原始输入改写成更精确、结构化的执行提示词，供子 agent 执行。
// 用词说明：开放性措辞（「最佳回答」）已比技术描述更适合非技术用户阅读，
// 且语义上传达了「不额外添加内容」的约束。后续可通过用户配置 UI 自定义（Deferred）。
const INTENT_SYSTEM_PROMPT =
  `你是提示词优化专家。请将用户输入改写成更精确、结构化的执行提示词，供另一个 AI 助手执行。\n` +
  `要求：\n` +
  `- 保留用户原始意图和关键信息，不能偏离或添加原始请求中没有的假设\n` +
  `- 使任务目标更明确，拆解复杂需求为清晰步骤\n` +
  `- 避免歧义，明确约束和边界条件\n` +
  `- 直接输出优化后的提示词，不要解释改写过程`;

// 段3：二次加工提示词。
// 对子 agent 执行结果进行整理/总结/润色，产出最终面向用户的高质量回答。
const REFINE_SYSTEM_PROMPT =
  `你负责整理另一个 AI 助手的执行结果，产出最终面向用户的高质量回答。\n` +
  `你将收到「用户原始问题」和「执行结果」，请：\n` +
  `- 确保回答直接响应用户原始问题\n` +
  `- 整理格式，使内容更清晰易读\n` +
  `- 去除冗余信息，保留核心内容\n` +
  `- 如果执行结果已很好，适当润色即可\n` +
  `- 直接输出最终回答，不要添加额外说明`;

// ── 编排启动参数 ──────────────────────────────────────────────────────────────

export interface OrchestrateStartRequest {
  /** 编排链路唯一 ID，渲染端用此 ID 消费全部三段事件（等价于 CliStartRequest.runId） */
  orchestrationRunId: string;
  /** 渲染端会话 ID，随事件回显，供渲染端刷新后兜底归属 */
  sessionId: string;
  /** agent id（内置如 "claude"/"codex"，或 M3-A 派生 id；由渲染端 resolveSpawnAgentId 传入） */
  agent: string;
  /** 工作目录（真实项目路径或无项目会话的 Documents/cortex/<date>） */
  cwd: string;
  /** 用户原始输入（三段均引用：段1提示词基础、段3输入的一部分） */
  prompt: string;
  /** 模型 id（可选；缺省由 adapter 使用默认值） */
  model?: string;
  /** 推理强度（可选；适配 CliStartRequest.effort）。仅段2（真实执行）透传——段1/段3是轻量
   *  提示词转换且仅 60s 超时，高 effort 反而易超时，故沿用 adapter 默认。 */
  effort?: string;
  /**
   * 访问范围/沙箱档（plan/accept-edits/full-auto/sandbox）。仅段2（真实执行）透传，
   * 段1/段3是纯提示词转换不碰文件系统，沿用 adapter 默认。
   * 缺省时段2按 adapter 默认 full-auto —— 故编排会话务必带上，否则 plan 会话也会被允许写盘。
   */
  permissionMode?: string;
  /** 执行/审批策略（与 permissionMode 正交）；同样仅段2透传。 */
  approvalPolicy?: string;
  /**
   * 已组装的系统提示词追加块（全局指令 + 项目信息 + 附件 skills + 文档清单 + skill prose）。
   * 仅段2透传：子 agent 真实执行需要这些上下文；段1/段3用各自固定 system prompt，不叠加。
   */
  appendSystemPrompt?: string;
  /** Pi 三段编排所需的 RPC open 参数（renderer 侧按普通 Pi 发送同源装配）。 */
  piOpen?: Omit<PiOpenRequest, "uiSessionId" | "cwd">;
}

// ── 单段执行 ──────────────────────────────────────────────────────────────────

interface StageRunResult {
  /** 聚合后的文本输出（最多 MAX_STAGE_OUTPUT 字节） */
  text: string;
  /** 段是否成功（ok result + 零退出码 + 非超时/取消） */
  ok: boolean;
  /** 错误描述（失败时） */
  error?: string;
}

/**
 * 执行单段子进程。
 *
 * - 子进程注册到 orchestrationProcs（独立注册表，不进 cli.ts running Map）。
 * - text 事件随流式累积到 out，同时经 onEvent 推渲染端（含 stage 字段）。
 * - result 事件仅内部消费，不经 onEvent 转发（KTD4：防止渲染端提前 finalizeRun）。
 * - signal.abort() → kill 子进程 → 返回 { ok: false, error: "已取消" }。
 * - 超时 → kill 子进程 → 返回 { ok: false, error: "段 X 超时…" }。
 */
async function runStage(opts: {
  stage: OrchestrateStage;
  prompt: string;
  agent: string;
  cwd: string;
  model?: string;
  /** 仅段2传入：推理强度/访问范围/审批/系统提示词追加块（段1/段3省略 → adapter 默认）。 */
  effort?: string;
  permissionMode?: string;
  approvalPolicy?: string;
  appendSystemPrompt?: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** 每个非 result 事件的回调（调用方已注入 stage 字段） */
  onEvent: (ev: CliStreamEvent) => void;
}): Promise<StageRunResult> {
  const { stage, prompt, agent, cwd, model, effort, permissionMode, approvalPolicy, appendSystemPrompt, signal, timeoutMs, onEvent } = opts;

  // signal 提前取消时直接拒绝，避免无谓 spawn
  if (signal.aborted) {
    return { text: "", ok: false, error: "已取消" };
  }

  const adapter = getAgentDef(agent);
  const spawnKey = randomUUID();

  // 每段用独立 runId/sessionId（不续接，各段均为 fresh spawn），不进 cli.ts running Map。
  const req: CliStartRequest = {
    runId: spawnKey,
    sessionId: spawnKey,
    agent,
    cwd,
    prompt,
    model: model ?? undefined,
    // 仅段2会传这些（段1/段3为 undefined → adapter 走默认）：让子 agent 真实执行尊重会话的
    // 推理强度/访问范围/审批策略，并带上 skills/附件/项目等系统提示词上下文。
    effort: effort as CliStartRequest["effort"],
    permissionMode: permissionMode as CliStartRequest["permissionMode"],
    approvalPolicy: approvalPolicy as CliStartRequest["approvalPolicy"],
    appendSystemPrompt,
  } as CliStartRequest;

  assertSpawnCwd(cwd);

  // CODEX_MCP_CLEAR：codex 轻量路径（exec 模式）不注入 MCP，与 run-prompt-headless 对齐。
  const { cmd, args, stdin } = adapter.buildArgs(req, CODEX_MCP_CLEAR);
  const proc = startAgentProcess(cmd, args, {
    cwd,
    env: spawnEnvForDef(req, adapter),
    stdin,
  });

  // 注册到独立进程表：killAllOrchestrations + AbortSignal 两路都能终止
  orchestrationProcs.add(proc);

  return new Promise<StageRunResult>((resolve) => {
    let out = "";
    let settled = false;
    let timedOut = false;
    let resultFailed = false;
    let errorText = "";

    // 分段超时：超出后 kill 子进程（onExit 中判定 timedOut）
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        proc.kill();
      }
    }, timeoutMs);

    // AbortSignal 取消：abort 事件 → kill 子进程
    const onAbort = () => {
      if (!settled) proc.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      orchestrationProcs.delete(proc);
      fn();
    };

    const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
      for (const ev of parseLineEvents(adapter, line)) {
        if (ev.type === "text") {
          // 文本累积（上限截断）+ 转发给渲染端（过程面板展示）
          if (out.length < MAX_STAGE_OUTPUT) out += ev.delta;
          onEvent({ ...ev, stage } as CliStreamEvent);
        } else if (ev.type === "result") {
          // result 仅内部消费，不转发（KTD4）：
          // 转发 result 会触发渲染端 finalizeRun，使后续事件被丢弃，
          // 因为对应 run 已从 runs Map 中移除。三段合成终态由编排器统一推送。
          if (!ev.ok) {
            resultFailed = true;
            errorText = ev.error ?? "执行失败";
          }
        } else {
          // 其余事件（tool/thinking/turn/usage/retry/init）：加 stage 后转发过程面板
          onEvent({ ...ev, stage } as CliStreamEvent);
        }
      }
    });

    proc.stderr?.setEncoding("utf8");

    proc.onError((err) => {
      settle(() => resolve({ text: out.trim(), ok: false, error: err.message }));
    });

    proc.onExit((code) => {
      // 冲刷无换行结尾的最后一行（pi 末行 message_end 在此）
      flushStdout();
      settle(() => {
        if (signal.aborted) {
          return resolve({ text: out.trim(), ok: false, error: "已取消" });
        }
        if (timedOut) {
          return resolve({
            text: out.trim(),
            ok: false,
            error: `段 ${stage} 超时（${Math.round(timeoutMs / 1000)}s），已终止`,
          });
        }
        if (resultFailed) {
          return resolve({ text: out.trim(), ok: false, error: errorText });
        }
        if (code !== 0 && code !== null) {
          return resolve({
            text: out.trim(),
            ok: false,
            error: `${agent} 退出码 ${code}`,
          });
        }
        resolve({ text: out.trim(), ok: true });
      });
    });
  });
}

function piPromptWithAppend(prompt: string, appendSystemPrompt?: string): string {
  return appendSystemPrompt ? `${appendSystemPrompt}\n\n${prompt}` : prompt;
}

function mapPiToCliEvent(ev: PiSessionEvent): CliStreamEvent | null {
  switch (ev.type) {
    case "text":
      return { type: "text", delta: ev.delta };
    case "reasoning":
      return { type: "thinking", delta: ev.delta };
    case "tool-start":
      return { type: "tool", name: ev.name, detail: ev.detail, phase: "start", toolCallId: ev.toolCallId };
    case "tool-end":
      return { type: "tool", name: ev.name, phase: "end", toolCallId: ev.toolCallId };
    case "todo":
      // 任务清单快照原样透传(编排 run 的渲染端有前缀守卫,不渲染 todo 卡)。
      return { type: "todo", todos: ev.todos };
    case "retry":
      return { type: "retry", attempt: ev.attempt, maxAttempts: ev.maxAttempts, reason: ev.error };
    case "turn-end":
      return { type: "turn" };
    case "error":
      return { type: "result", ok: false, error: ev.error };
    case "crashed":
      return { type: "result", ok: false, error: ev.error ?? "pi 进程已退出" };
    case "result":
      return ev.willRetry ? null : { type: "result", ok: true };
    case "notify":
      return ev.message ? { type: "text", delta: ev.message } : null;
    // settled（agent_settled）在编排链路不映射成终态:runPiStage 自带 settle 去重 + 超时兜底,
    // 且 result 已是这里的收尾信号。转成 result 只会与既有路径抢收尾,收益为零。
    // artifact:编排子会话不注册 artifacts 工具(不置 enableArtifactsTool),此处仅为穷尽兜底。
    // step-start 是会话统计条的计时锚点，编排链路没有统计条，不映射。
    case "step-start":
    case "settled":
    case "compaction":
    case "queue":
    case "session-info":
    case "thinking-level":
    case "artifact":
      return null;
  }
}


async function runPiStage(opts: {
  stage: OrchestrateStage;
  prompt: string;
  cwd: string;
  model?: string;
  appendSystemPrompt?: string;
  piOpen?: Omit<PiOpenRequest, "uiSessionId" | "cwd">;
  signal: AbortSignal;
  timeoutMs: number;
  onEvent: (ev: CliStreamEvent) => void;
  onUiRequest: (session: PiSessionEngine, req: PiUiRequest) => void;
}): Promise<StageRunResult> {
  const { stage, prompt, cwd, model, appendSystemPrompt, piOpen, signal, timeoutMs, onEvent, onUiRequest } = opts;
  if (signal.aborted) return { text: "", ok: false, error: "已取消" };

  const spawnKey = randomUUID();
  const uiSessionId = `orch-${spawnKey}`;
  let out = "";
  let settled = false;
  // session 被 settle 与 onUiRequest 两个闭包共享（捕获的是变量而非值）：构造完成前它是
  // undefined，此时到达的 UI 请求按旧路径同款守卫丢弃（会话 stop() 时的 cancelAll 会解锁 pi）。
  let session: PiSessionEngine | undefined;

  return new Promise<StageRunResult>((resolve) => {
    const settle = (result: StageRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // 释放（摘 UI 路由 → 摘表 → [abort] → stop）统一交给租约表，见 session-pool.ts。
      if (session) orchestrationPiSessions.release(session);
      resolve({ ...result, text: result.text.trim() });
    };

    const timer = setTimeout(() => {
      settle({ text: out, ok: false, error: `段 ${stage} 超时（${Math.round(timeoutMs / 1000)}s），已终止` });
    }, timeoutMs);

    const onAbort = () => settle({ text: out, ok: false, error: "已取消" });
    signal.addEventListener("abort", onAbort, { once: true });

    const handlePiEvent = (piEv: PiSessionEvent) => {
      if (settled) return;
      const ev = mapPiToCliEvent(piEv);
      if (!ev) return;
      if (ev.type === "text") {
        if (out.length < MAX_STAGE_OUTPUT) out += ev.delta;
        onEvent({ ...ev, stage } as CliStreamEvent);
        return;
      }
      if (ev.type === "result") {
        settle({ text: out, ok: ev.ok, error: ev.ok ? undefined : ev.error ?? "执行失败" });
        return;
      }
      onEvent({ ...ev, stage } as CliStreamEvent);
    };

    // UI 请求出口。两条引擎路径共用同一个闭包，形状与守卫逐字相同。
    const handleUiRequest = (uiReq: PiUiRequest) => {
      if (!session) return;
      onUiRequest(session, uiReq);
    };

    void (async () => {
      try {
        const req = await preparePiOpenRequest({
          ...(piOpen ?? {}),
          uiSessionId,
          cwd,
          model: piOpen?.model ?? model,
          appendSystemPrompt: stage === "subagent" ? piOpen?.appendSystemPrompt : undefined,
        });
        if (settled || signal.aborted) return;

        // cwd 路径闸：它守的是「能不能在这个目录里跑 agent」，与是否 spawn 无关。
        assertSpawnCwd(cwd);
        // 无条件走 gateway：能力组装在常驻 worker 侧按 req 的结构化字段完成
        // （与主会话同一套 capabilities.ts）。三段共享同一个常驻 runtime——
        // 编排从 3~6 个进程降到 1 个，正是常驻化的主要收益场景。
        const opened: PiSessionEngine = await openPiGatewaySession({
          request: req,
          onEvent: (ev) => handlePiEvent(ev),
          onUiRequest: handleUiRequest,
        });

        // ── 领取会话（资源释放的关键点）───────────────────────────────────────────────
        // `openPiGatewaySession()` 是 await 的，这段窗口里用户可能已点停止、或本段已超时 ——
        // 那时 settle 早跑过、它手里的 `session` 还是 undefined，会话建好后就再也没有引用能停它，
        // worker 侧那份会话资源会一直挂着。adopt() 在同步瞬间重判一次并就地释放，把这条缝补死。
        // 不设 abortOnRelease：gateway 的 closeSession 在 worker 侧本就先 abort 再 stop，
        // 主进程侧无需重复。
        if (!orchestrationPiSessions.adopt(opened, { isStale: () => settled || signal.aborted })) {
          return;
        }
        session = opened;

        await opened.ready();
        if (settled || signal.aborted) return;

        // prompt() 是 fire-and-forget：应答只是「受理 ack」，真正的终态由事件流的 result/error 表达。
        // 刻意**不 await**：一旦本段因超时/取消先行 settle，`await` 会把整个 async 帧（连同已停止的
        // 会话句柄）挂在这个 pending promise 上；回调形式让帧立即展开，且 settled 守卫保证迟到的
        // ack/rejection 不会二次结算。语义与 `await` + `if (!resp.success)` 逐条等价。
        void opened.prompt(piPromptWithAppend(prompt, appendSystemPrompt), spawnKey).then(
          (resp) => {
            if (settled || signal.aborted) return;
            if (!resp.success) settle({ text: out, ok: false, error: resp.error ?? "pi prompt failed" });
          },
          (err: unknown) => {
            if (settled || signal.aborted) return;
            settle({ text: out, ok: false, error: err instanceof Error ? err.message : String(err) });
          },
        );
      } catch (e) {
        settle({ text: out, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

// ── IPC Handler 注册 ─────────────────────────────────────────────────────────

export function registerOrchestrateHandlers(): void {
  // orchestrate:start —— 发起三段编排。
  // 渲染端经 cli:event / cli:exit 消费事件流（与普通 cli:start 共用同一通道，
  // 区别在于事件携带 stage 字段，且中间段 result 不触发 finalizeRun）。
  ipcMain.handle("orchestrate:start", async (event, req: OrchestrateStartRequest) => {
    const { orchestrationRunId: runId, sessionId, agent, cwd, prompt, model, effort, permissionMode, approvalPolicy, appendSystemPrompt, piOpen } = req;

    const sender = event.sender;
    const controller = new AbortController();
    activeOrchestrations.set(runId, controller);

    // 事件发送辅助（检查 sender 是否已销毁，防 IPC 异常）
    const sendEvent = (ev: CliStreamEvent) => {
      if (!sender.isDestroyed()) {
        sender.send("cli:event", { runId, sessionId, event: ev });
      }
    };
    const sendExit = (exit: CliExitEvent) => {
      if (!sender.isDestroyed()) {
        sender.send("cli:exit", exit);
      }
    };

    // 段切换通知（R9）：携带 stageLabel 让渲染端更新 typing 文案。
    // 使用 thinking 类型的空 delta 事件作为段边界信号（不污染 text 输出），
    // stageLabel 是可选增强字段，渲染端也可通过 stage 字段自行推断文案。
    const sendStageStart = (stage: OrchestrateStage, stageLabel: string) => {
      sendEvent({ type: "thinking", delta: "", stage, stageLabel } as CliStreamEvent);
    };
    const sendPiUiRequest = (piSession: PiSessionEngine, request: PiUiRequest) => {
      registerTransientPiUiRequest(sessionId, request.id, piSession, sender);
      if (!sender.isDestroyed()) {
        sender.send("pi:uiRequest", { uiSessionId: sessionId, request });
      }
    };
    const runAnyStage = (stageOpts: {
      stage: OrchestrateStage;
      prompt: string;
      effort?: string;
      permissionMode?: string;
      approvalPolicy?: string;
      appendSystemPrompt?: string;
      timeoutMs: number;
    }) =>
      agent === "pi"
        ? runPiStage({
            stage: stageOpts.stage,
            prompt: stageOpts.prompt,
            cwd,
            model,
            appendSystemPrompt: stageOpts.appendSystemPrompt,
            piOpen,
            signal: controller.signal,
            timeoutMs: stageOpts.timeoutMs,
            onEvent: sendEvent,
            onUiRequest: sendPiUiRequest,
          })
        : runStage({
            stage: stageOpts.stage,
            prompt: stageOpts.prompt,
            agent,
            cwd,
            model,
            effort: stageOpts.effort,
            permissionMode: stageOpts.permissionMode,
            approvalPolicy: stageOpts.approvalPolicy,
            appendSystemPrompt: stageOpts.appendSystemPrompt,
            signal: controller.signal,
            timeoutMs: stageOpts.timeoutMs,
            onEvent: sendEvent,
          });

    // ══ 段1：意图理解 ══════════════════════════════════════════════════════════
    sendStageStart("intent", "理解意图中…");
    const stage1Result = await runAnyStage({
      stage: "intent",
      prompt: `${INTENT_SYSTEM_PROMPT}\n\n用户输入：${prompt}`,
      timeoutMs: INTENT_TIMEOUT_MS,
    });

    // 被取消：直接退出，不推终态（进程已被 kill，渲染端等待的 cli:exit 不会到来，
    // 但 orchestrate:kill 触发时渲染端应自行清理 RunState）
    if (controller.signal.aborted) {
      activeOrchestrations.delete(runId);
      return;
    }

    // 段1失败降级（KTD7-1）：静默回退，用原始输入作段2 prompt，链路继续。
    // 理由：意图理解是增强层，失败不应中断流程；用户感知不到降级，避免被误以为 bug。
    const stage2Prompt =
      stage1Result.ok && stage1Result.text.length > 0 ? stage1Result.text : prompt;

    // ══ 段2：子 agent 执行 ══════════════════════════════════════════════════════
    sendStageStart("subagent", "子 agent 执行中…");
    const stage2Result = await runAnyStage({
      stage: "subagent",
      prompt: stage2Prompt,
      // 仅段2透传会话推理强度/访问范围/审批/系统提示词上下文（段1/段3不传，见 OrchestrateStartRequest 注释）。
      effort,
      permissionMode,
      approvalPolicy,
      appendSystemPrompt,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
    });

    if (controller.signal.aborted) {
      activeOrchestrations.delete(runId);
      return;
    }

    // 段2失败降级（KTD7-2/3）：
    //   - 有错误文本 → 进段3 prompt，主 agent 解释/降级（KTD7-2）
    //   - 无有效输出 → 连锁兜底（KTD7-3），不把错误当子结果，段3直答原始问题
    let stage3Prompt: string;
    let isCascadeFallback = false;

    if (!stage2Result.ok) {
      if (stage2Result.text.trim().length > 0) {
        // 有部分输出：进段3，告知主 agent 结果不完整，让其解释/降级（KTD7-2）
        stage3Prompt =
          `${REFINE_SYSTEM_PROMPT}\n\n` +
          `用户原始问题：\n${prompt}\n\n` +
          `子 agent 执行结果（执行遇到问题，请在整理时如实说明）：\n${stage2Result.text}\n\n` +
          `执行错误信息：${stage2Result.error ?? "未知错误"}`;
      } else {
        // 无任何有效输出：连锁兜底（KTD7-3），段3直答原始问题，并说明执行失败
        isCascadeFallback = true;
        stage3Prompt =
          `${REFINE_SYSTEM_PROMPT}\n\n` +
          `用户原始问题：\n${prompt}\n\n` +
          `（注意：系统尝试执行了相关任务，但执行失败且未产生任何有效结果。请直接根据用户的原始问题给出最佳回答，` +
          `并在回答结尾告知用户执行过程遇到了技术问题。）`;
      }
    } else {
      stage3Prompt =
        `${REFINE_SYSTEM_PROMPT}\n\n` +
        `用户原始问题：\n${prompt}\n\n` +
        `子 agent 执行结果：\n${stage2Result.text}`;
    }

    // ══ 段3：二次加工 ══════════════════════════════════════════════════════════
    sendStageStart("refine", "整理回复中…");
    const stage3Result = await runAnyStage({
      stage: "refine",
      prompt: stage3Prompt,
      timeoutMs: REFINE_TIMEOUT_MS,
    });

    if (controller.signal.aborted) {
      activeOrchestrations.delete(runId);
      return;
    }

    // 段3失败降级（KTD7-4）：段2结果作为回退文本 + 独立友好错误消息落持久流。
    // 错误消息面向用户，不透传技术报错，使用 Markdown 分隔符与主内容区分。
    if (!stage3Result.ok) {
      // 若段3无任何输出（连流式文本也没有），且非连锁兜底场景，则把段2结果推给渲染端
      if (!isCascadeFallback && stage2Result.text.trim().length > 0 && stage3Result.text.length === 0) {
        sendEvent({ type: "text", delta: stage2Result.text, stage: "refine" } as CliStreamEvent);
      }
      // 独立友好错误说明（落持久消息流，可回看）
      sendEvent({
        type: "text",
        delta: "\n\n---\n*回复整理过程遇到技术问题，以上为执行的原始结果，供参考。*",
        stage: "refine",
      } as CliStreamEvent);
    }

    activeOrchestrations.delete(runId);

    // 三段全部完成：推一次合成终态（KTD4）。
    // 各段自身的 result 事件在 runStage 内被拦截（不转发），渲染端需等此合成 result
    // 才能识别成功终态（收起过程流、解冻 typing、触发 finalizeRun）。
    sendEvent({ type: "result", ok: true, stage: "refine" } as CliStreamEvent);
    sendExit({ runId, sessionId, code: 0 });
  });

  // orchestrate:kill —— 取消指定编排链路（用户 stop / 渲染端看门狗触发）。
  // 注意：不走 cli:kill（后者只查 running Map，对编排子进程无效，见 KTD5）。
  // 使用 ipcMain.on（fire-and-forget，对齐 cli:kill 模式）。
  ipcMain.on("orchestrate:kill", (_event, runId: string) => {
    const controller = activeOrchestrations.get(runId);
    if (controller) {
      controller.abort();
      activeOrchestrations.delete(runId);
    }
  });
}
