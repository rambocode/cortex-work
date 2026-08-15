// RunEvent 流 → trajectory 布局折叠(复刻 deepseek-harness layout.ts 的折叠语义,
// 数据源换成本仓库的归一化 CLI 事件流):
//   一个 runId = 一轮(Turn);轮内 Message 组放用户 prompt,Step N 组放每次模型请求
//   (思考/回复段 + 其后的工具调用)。步进启发式:工具调用之后再出现思考/回复段 = 新一步
//   (claude/codex/pi 的流内,单次请求的正文总在其工具调用之前)。
// usage 语义沿用旧详情弹层:每轮取「最后一条 usage」(codex ws 是累计快照,逐条累加会重复计数),
// 挂到该轮末个 assistant 行与末步 request 上;跨轮 cumulative 再求和。
import { cleanToolName, type RunEvent, type RunPromptRecord } from "@cortex-work/core";
import {
  jsonDetail,
  trajectoryPreviewText,
  type TrajectoryCellProps,
  type TrajectoryGroupModel,
  type TrajectoryRequestInfo,
  type TrajectoryTurnModel,
  type TrajectoryUsage,
} from "./trajectory-model";

/** 布局折叠输入。 */
export interface TrajectoryLayoutInput {
  events: RunEvent[];
  prompts: RunPromptRecord[];
  /** 会话是否仍在运行(末轮未配对的工具/正文判 running 用)。 */
  running: boolean;
  /** tool 名兜底(事件缺 name 时)。 */
  fallbackToolName: string;
}

/** 折叠结果:轮列表 + 每步请求信息。 */
export interface TrajectoryLayoutResult {
  turns: TrajectoryTurnModel[];
  requests: TrajectoryRequestInfo[];
}

// 折叠期的可变步状态。
interface StepState {
  step: number;
  cells: TrajectoryCellProps[];
  assistant: TrajectoryCellProps | null;
  sawTool: boolean;
  startedAt: number | null;
  lastTs: number | null;
  error?: string;
  retries: number;
}

// 折叠期的可变轮状态。
interface TurnState {
  runId: string;
  firstTs: number;
  userCell: TrajectoryCellProps | null;
  steps: StepState[];
  lastUsage: { input?: number; cacheRead?: number; output?: number; costUsd?: number } | null;
  lastUsageStep: number;
  resultError?: string;
  errorCell: TrajectoryCellProps | null;
  prevTs: number | null;
}

function newStep(step: number): StepState {
  return { step, cells: [], assistant: null, sawTool: false, startedAt: null, lastTs: null, retries: 0 };
}

// assistant 行的正文/思考预览:优先回复正文,无正文退思考。
function assistantPreview(cell: TrajectoryCellProps): void {
  const source = cell.outputDetail ?? cell.thinkingDetail;
  if (source !== undefined && source !== "") cell.previewText = trajectoryPreviewText(source);
}

/**
 * 折叠事件流为 trajectory 轮/步布局。
 * 单次遍历;工具 start/end 按 toolCallId 配对(无 id 时同名未配对行兜底)。
 */
export function buildTrajectoryLayout(input: TrajectoryLayoutInput): TrajectoryLayoutResult {
  const { events, prompts, running, fallbackToolName } = input;
  const turnsByRun = new Map<string, TurnState>();
  const runOrder: string[] = [];

  const turnFor = (runId: string, ts: number): TurnState => {
    let turn = turnsByRun.get(runId);
    if (turn === undefined) {
      turn = {
        runId,
        firstTs: ts,
        userCell: null,
        steps: [newStep(1)],
        lastUsage: null,
        lastUsageStep: 1,
        errorCell: null,
        prevTs: null,
      };
      turnsByRun.set(runId, turn);
      runOrder.push(runId);
    }
    return turn;
  };

  // 用户 prompt 先入轮:run 已启动但事件未到时,轮里也要先出现 USER 行。
  for (const prompt of prompts) {
    const turn = turnFor(prompt.runId, prompt.ts);
    turn.firstTs = Math.min(turn.firstTs, prompt.ts);
    turn.prevTs = prompt.ts;
    turn.userCell = {
      index: 0,
      recordId: `${prompt.runId}:user`,
      kind: "user",
      text: "",
      previewText: trajectoryPreviewText(prompt.text),
      inputDetail: prompt.text,
      timeSeconds: 0,
      startedAt: prompt.ts,
      opensTurn: true,
    };
  }

  // 工具配对表:callId → 未settle 的 tool 行;无 callId 的按「轮内最近未配对同名行」兜底。
  const openByCallId = new Map<string, TrajectoryCellProps>();
  let toolSeq = 0;
  let miscSeq = 0;

  for (const { runId, ts, ev } of events) {
    const turn = turnFor(runId, ts);
    const step = turn.steps[turn.steps.length - 1]!;
    const advanceStep = (): StepState => {
      const next = newStep(turn.steps.length + 1);
      turn.steps.push(next);
      return next;
    };

    if (ev.type === "thinking" || ev.type === "text") {
      // 工具之后再来正文/思考段 = 下一次模型请求(新 Step)。
      const target = step.sawTool ? advanceStep() : step;
      let assistant = target.assistant;
      if (assistant === null) {
        assistant = {
          index: 0,
          recordId: `${runId}:s${target.step}:assistant`,
          kind: "message",
          text: "",
          timeSeconds: null,
          startedAt: turn.prevTs ?? ts,
        };
        target.assistant = assistant;
        target.cells.push(assistant);
        target.startedAt ??= turn.prevTs ?? ts;
      }
      if (ev.type === "thinking") {
        assistant.thinkingDetail = assistant.thinkingDetail
          ? `${assistant.thinkingDetail}\n\n${ev.delta}`
          : ev.delta;
      } else {
        assistant.outputDetail = assistant.outputDetail ? `${assistant.outputDetail}\n\n${ev.delta}` : ev.delta;
      }
      // 段 ts 是「最后一次增量到达时刻」(recordRunEvent 合并时刷新),据此得段耗时。
      const started = assistant.startedAt ?? ts;
      assistant.timeSeconds = Math.max(0, (ts - started) / 1000);
      assistantPreview(assistant);
      target.lastTs = ts;
      turn.prevTs = ts;
      continue;
    }

    if (ev.type === "tool") {
      if (ev.phase !== "end") {
        const name = cleanToolName(ev.name) || fallbackToolName;
        const cell: TrajectoryCellProps = {
          index: 0,
          recordId: ev.toolCallId ? "" : `${runId}:tool${(toolSeq += 1)}`,
          kind: "tool",
          text: name,
          ...(ev.detail ? { previewText: trajectoryPreviewText(ev.detail) } : {}),
          ...(ev.input !== undefined ? { inputDetail: jsonDetail(ev.input) } : {}),
          ...(ev.toolCallId !== undefined ? { callId: ev.toolCallId } : {}),
          running: true,
          timeSeconds: null,
          startedAt: ts,
        };
        if (ev.input !== undefined && !ev.detail) cell.previewText = trajectoryPreviewText(jsonDetail(ev.input));
        step.sawTool = true;
        step.cells.push(cell);
        step.startedAt ??= ts;
        step.lastTs = ts;
        if (ev.toolCallId) openByCallId.set(ev.toolCallId, cell);
        turn.prevTs = ts;
        continue;
      }
      // end 帧:配对回填(名字/late detail/入参覆盖 —— webSearch 等工具查询词在 end 帧才就绪)。
      let open = ev.toolCallId ? openByCallId.get(ev.toolCallId) : undefined;
      if (open === undefined && !ev.toolCallId) {
        const name = cleanToolName(ev.name);
        for (let i = turn.steps.length - 1; i >= 0 && open === undefined; i -= 1) {
          const cells = turn.steps[i]!.cells;
          for (let j = cells.length - 1; j >= 0; j -= 1) {
            const candidate = cells[j]!;
            if (candidate.kind === "tool" && candidate.running && (!name || candidate.text === name)) {
              open = candidate;
              break;
            }
          }
        }
      }
      if (open !== undefined) {
        open.running = false;
        if (ev.toolCallId) openByCallId.delete(ev.toolCallId);
        const name = cleanToolName(ev.name);
        if (name) open.text = name;
        if (!open.previewText && ev.detail) open.previewText = trajectoryPreviewText(ev.detail);
        if (ev.input !== undefined) {
          open.inputDetail = jsonDetail(ev.input);
          if (!ev.detail && !open.previewText) open.previewText = trajectoryPreviewText(open.inputDetail);
        }
        open.isError = ev.isError === true;
        if (ev.output !== undefined && ev.output !== "") {
          open.outputDetail = ev.output;
          open.result = "";
          open.resultPreviewText = trajectoryPreviewText(ev.output);
        } else {
          open.outputDetail = ev.output ?? "";
          open.result = ev.isError ? "error" : "No output";
        }
        const started = open.startedAt ?? ts;
        open.timeSeconds = Math.max(0, (ts - started) / 1000);
      } else {
        // 丢配的孤儿结果帧:独立成行兜底,保证输出不丢。
        const name = cleanToolName(ev.name) || fallbackToolName;
        const cell: TrajectoryCellProps = {
          index: 0,
          recordId: ev.toolCallId ? "" : `${runId}:tool${(toolSeq += 1)}`,
          kind: "tool",
          text: name,
          ...(ev.detail ? { previewText: trajectoryPreviewText(ev.detail) } : {}),
          ...(ev.input !== undefined ? { inputDetail: jsonDetail(ev.input) } : {}),
          ...(ev.toolCallId !== undefined ? { callId: ev.toolCallId } : {}),
          isError: ev.isError === true,
          timeSeconds: null,
          startedAt: ts,
        };
        if (ev.output !== undefined && ev.output !== "") {
          cell.outputDetail = ev.output;
          cell.result = "";
          cell.resultPreviewText = trajectoryPreviewText(ev.output);
        } else {
          cell.outputDetail = "";
          cell.result = ev.isError ? "error" : "No output";
        }
        step.sawTool = true;
        step.cells.push(cell);
        step.lastTs = ts;
      }
      step.lastTs = ts;
      turn.prevTs = ts;
      continue;
    }

    if (ev.type === "retry") {
      step.retries += 1;
      const cell: TrajectoryCellProps = {
        index: 0,
        recordId: `${runId}:retry${(miscSeq += 1)}`,
        kind: "context",
        text: `Retry ${ev.attempt}${ev.maxAttempts ? `/${ev.maxAttempts}` : ""}`,
        ...(ev.reason ? { previewText: trajectoryPreviewText(ev.reason), inputDetail: ev.reason } : {}),
        timeSeconds: 0,
        startedAt: ts,
      };
      step.cells.push(cell);
      step.lastTs = ts;
      turn.prevTs = ts;
      continue;
    }

    if (ev.type === "result") {
      if (!ev.ok) {
        turn.resultError = ev.error ?? "failed";
        step.error = turn.resultError;
        // 失败轮补一条红色 CONTEXT 行:失败信息必须在台账可见,不能只藏在请求检查器里。
        turn.errorCell = {
          index: 0,
          recordId: `${runId}:error`,
          kind: "context",
          text: "Error",
          ...(ev.error ? { previewText: trajectoryPreviewText(ev.error), inputDetail: ev.error } : {}),
          isError: true,
          timeSeconds: 0,
          startedAt: ts,
        };
        step.cells.push(turn.errorCell);
      }
      step.lastTs = ts;
      turn.prevTs = ts;
      continue;
    }

    if (ev.type === "usage") {
      const prev = turn.lastUsage;
      turn.lastUsage = {
        input: ev.inputTokens ?? prev?.input,
        cacheRead: ev.cachedInputTokens ?? prev?.cacheRead,
        output: ev.outputTokens ?? prev?.output,
        costUsd: ev.costUsd ?? prev?.costUsd,
      };
      turn.lastUsageStep = step.step;
      continue;
    }
    // init/turn/todo:不产台账行(todo 时间线在消息流内已有专属卡)。
  }

  // 收尾:编号、request 信息、usage 落位。
  const turns: TrajectoryTurnModel[] = [];
  const requests: TrajectoryRequestInfo[] = [];
  let index = 0;
  let requestNumber = 0;
  let cumulative: TrajectoryUsage | undefined;
  const ordered = runOrder
    .map((runId) => turnsByRun.get(runId)!)
    .sort((a, b) => a.firstTs - b.firstTs);
  const lastRun = ordered[ordered.length - 1];

  for (const [turnAt, state] of ordered.entries()) {
    const turnNo = turnAt + 1;
    const isLastRun = state === lastRun;
    const groups: TrajectoryGroupModel[] = [];
    if (state.userCell) {
      state.userCell.index = ++index;
      groups.push({ title: "Message", cells: [state.userCell] });
    }
    // usage 挂到轮内最后一个 assistant 行(与旧详情弹层「每轮取末条 usage」同语义)。
    const lastAssistant = [...state.steps].reverse().find((s) => s.assistant !== null)?.assistant ?? null;
    if (lastAssistant && state.lastUsage) {
      if (state.lastUsage.input !== undefined) lastAssistant.input = state.lastUsage.input;
      if (state.lastUsage.cacheRead !== undefined) lastAssistant.cacheRead = state.lastUsage.cacheRead;
      if (state.lastUsage.output !== undefined) lastAssistant.output = state.lastUsage.output;
    }
    for (const step of state.steps) {
      if (step.cells.length === 0) continue;
      for (const cell of step.cells) {
        cell.index = ++index;
        // 会话已不在运行却仍未配对的工具行:不能永远转圈,按失败画上句号。
        if (cell.kind === "tool" && cell.running && !(running && isLastRun)) {
          cell.running = false;
          cell.isError = true;
          cell.result ??= "interrupted";
        }
        // 末轮运行中:assistant 段耗时仍在增长,标 running 语义由消费端(状态列)判定。
      }
      const usage: TrajectoryUsage | undefined =
        state.lastUsage && step.step === state.lastUsageStep
          ? {
              ...(state.lastUsage.input !== undefined ? { input: state.lastUsage.input } : {}),
              ...(state.lastUsage.cacheRead !== undefined ? { cacheRead: state.lastUsage.cacheRead } : {}),
              ...(state.lastUsage.output !== undefined ? { output: state.lastUsage.output } : {}),
            }
          : undefined;
      if (usage !== undefined) {
        cumulative = {
          input: (cumulative?.input ?? 0) + (usage.input ?? 0),
          cacheRead: (cumulative?.cacheRead ?? 0) + (usage.cacheRead ?? 0),
          output: (cumulative?.output ?? 0) + (usage.output ?? 0),
        };
      }
      const isLastStep = step === state.steps[state.steps.length - 1];
      const stepRunning =
        running &&
        isLastRun &&
        isLastStep &&
        step.error === undefined &&
        state.resultError === undefined;
      requests.push({
        turn: turnNo,
        step: step.step,
        group: `Step ${step.step}`,
        number: ++requestNumber,
        status: step.error !== undefined || step.cells.some((c) => c.isError) ? "error" : stepRunning ? "running" : "complete",
        ...(step.startedAt !== null ? { startedAt: step.startedAt } : {}),
        completedAt: stepRunning ? null : step.lastTs,
        ...(step.error !== undefined ? { error: step.error } : {}),
        ...(step.retries > 0 ? { retries: step.retries } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(cumulative !== undefined ? { cumulativeUsage: { ...cumulative } } : {}),
        ...(state.lastUsage?.costUsd !== undefined && step.step === state.lastUsageStep
          ? { costUsd: state.lastUsage.costUsd }
          : {}),
      });
      groups.push({ title: `Step ${step.step}`, cells: step.cells });
    }
    if (groups.length === 0) continue;
    turns.push({ turn: turnNo, runId: state.runId, groups });
  }

  return { turns, requests };
}
