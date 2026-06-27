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
import { CODEX_MCP_CLEAR } from "./mcp-config";
import type { CliExitEvent, CliStartRequest, CliStreamEvent } from "./types";

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
 * 终止所有在途编排子进程（应用退出 / stop-run 时调用）。
 * 对齐 killAllHeadlessPrompts / killAllCli 的统一语义。
 * 由 register.ts 导出，接入 app 退出钩子（与 killAllAutomations / killAllWorkflows 并列）。
 */
export function killAllOrchestrations(): void {
  for (const controller of activeOrchestrations.values()) {
    controller.abort();
  }
  for (const proc of orchestrationProcs) {
    proc.kill();
  }
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
  /** 推理强度（可选；适配 CliStartRequest.effort） */
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
  /** 仅段2传入：访问范围/审批/系统提示词追加块（段1/段3省略 → adapter 默认）。 */
  permissionMode?: string;
  approvalPolicy?: string;
  appendSystemPrompt?: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** 每个非 result 事件的回调（调用方已注入 stage 字段） */
  onEvent: (ev: CliStreamEvent) => void;
}): Promise<StageRunResult> {
  const { stage, prompt, agent, cwd, model, permissionMode, approvalPolicy, appendSystemPrompt, signal, timeoutMs, onEvent } = opts;

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
    // 访问范围/审批策略，并带上 skills/附件/项目等系统提示词上下文。
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

// ── IPC Handler 注册 ─────────────────────────────────────────────────────────

export function registerOrchestrateHandlers(): void {
  // orchestrate:start —— 发起三段编排。
  // 渲染端经 cli:event / cli:exit 消费事件流（与普通 cli:start 共用同一通道，
  // 区别在于事件携带 stage 字段，且中间段 result 不触发 finalizeRun）。
  ipcMain.handle("orchestrate:start", async (event, req: OrchestrateStartRequest) => {
    const { orchestrationRunId: runId, sessionId, agent, cwd, prompt, model, permissionMode, approvalPolicy, appendSystemPrompt } = req;

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

    // ══ 段1：意图理解 ══════════════════════════════════════════════════════════
    sendStageStart("intent", "理解意图中…");
    const stage1Result = await runStage({
      stage: "intent",
      prompt: `${INTENT_SYSTEM_PROMPT}\n\n用户输入：${prompt}`,
      agent,
      cwd,
      model,
      signal: controller.signal,
      timeoutMs: INTENT_TIMEOUT_MS,
      onEvent: sendEvent,
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
    const stage2Result = await runStage({
      stage: "subagent",
      prompt: stage2Prompt,
      agent,
      cwd,
      model,
      // 仅段2透传会话访问范围/审批/系统提示词上下文（段1/段3不传，见 OrchestrateStartRequest 注释）。
      permissionMode,
      approvalPolicy,
      appendSystemPrompt,
      signal: controller.signal,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
      onEvent: sendEvent,
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
    const stage3Result = await runStage({
      stage: "refine",
      prompt: stage3Prompt,
      agent,
      cwd,
      model,
      signal: controller.signal,
      timeoutMs: REFINE_TIMEOUT_MS,
      onEvent: sendEvent,
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
