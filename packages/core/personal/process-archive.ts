// 会话「工作过程」归档:把每一轮(run)的过程流(思考行 + 工具行)与工具调用快照(input/output)
// 打包成一条 TurnProcessArchive 落盘,重开会话/重启应用后仍能展开历史轮的「已处理 8.8s · N 步 ·
// 调用了 N 个工具」。
//
// 为什么另起一个文件而不是塞进 chat JSON:
//  - chat JSON(chats/<id>.json)是**正文**的真相,sanitizeForSave 明确剥离 agentLog/reasoning,
//    过程混进去会撑大主文件、也让旧版本客户端读到不认识的消息;
//  - 归档天然是**可丢**数据(丢了只损失回顾,不损失对话),独立文件坏了/删了不影响正文加载。
// 故归档单独走 chats/<id>.process.json(主进程 ipc/chat.ts),体积由本文件的四道上限约束。
//
// 与瞬态两条流的关系:归档是它们在轮结束时的**快照**,不参与流式;当前轮仍由
// personalProcessKeys(过程流)+ personalRunEventsKeys(原始事件)驱动,轮结束才落一条归档。

import type { CliStreamEvent } from "../desktop/types";
import type { Message } from "../types";
import { cleanToolName, normalizedToolName } from "./tool-name";

// 运行事件流单条记录(与 messages.ts 的 RunEvent 同构;定义放这里避免循环 import)。
export interface RunEventRecord {
  runId: string;
  ts: number;
  ev: CliStreamEvent;
}

/** 一次工具调用的快照:start/end 配对后的输入、输出与起止时刻。 */
export interface ArchivedToolInvocation {
  key: string;
  name: string;
  detail?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  running: boolean;
  /** 工具 start 事件到达时刻；缺 start 帧（只收到 end）时为空，耗时不显示而非猜测。 */
  startedAt?: number;
  /** 工具 end 事件到达时刻；运行中为空。 */
  endedAt?: number;
}

/** 一轮的过程归档。 */
export interface TurnProcessArchive {
  runId: string;
  /**
   * 锚点 = 该轮所回应的那条用户消息 uid。渲染时把过程条插在它后面,与流式期间
   * 「问题 → 过程 → 回答」的顺序一致。自动轮(无用户消息)为空,渲染时并入流末尾。
   */
  anchorUid?: string;
  startedAt: number;
  endedAt: number;
  /** 过程流快照(agentLog / reasoning / stageTitle),reasoning 正文已截断。 */
  messages: Message[];
  /** 工具调用快照,input/output 已截断。 */
  invocations: ArchivedToolInvocation[];
}

// ── 体积上限(四道) ────────────────────────────────────────────────────────
// 归档是「可丢的回顾数据」,宁可截断也不能让某一轮的巨型工具输出把文件撑成几十 MB
//（一个长会话可能跑上百轮,单轮 output 未截断时轻易到 MB 级）。
/** 单会话保留的轮数上限:超出丢最旧。 */
export const MAX_ARCHIVED_TURNS = 30;
/** 单轮保留的工具调用条数上限:超出丢最旧(保留最近的调用,回看时更相关)。 */
export const MAX_ARCHIVED_INVOCATIONS = 60;
/** 单条工具输出字符上限。 */
export const MAX_ARCHIVED_OUTPUT = 4_000;
/** 单条工具输入(JSON 序列化后)字符上限。 */
export const MAX_ARCHIVED_INPUT = 2_000;
/** 单条思考(reasoning)正文字符上限:pi 的长思考流是撑大文件的主要来源。 */
export const MAX_ARCHIVED_REASONING = 2_000;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// 工具入参可能是任意结构(甚至含大段文件内容)。整体序列化后超限就退化成一个带说明的字符串,
// 保证归档 JSON 的单条体积可控;结构化展示只在未超限时保留。
function truncateInput(input: unknown): unknown {
  if (input === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    return "[无法序列化的入参]";
  }
  if (serialized.length <= MAX_ARCHIVED_INPUT) return input;
  return `${serialized.slice(0, MAX_ARCHIVED_INPUT)}…（入参过长已截断）`;
}

/**
 * 把某一轮的原始事件配对成工具调用列表。
 *
 * start/end 优先按 toolCallId 配对；缺 id 时回配最近同名的运行项，仍配不到才保留独立结果，
 * 避免悄悄丢失输出。子代理事件(subagentCallId/roleId)归它自己的卡片,不进主会话时间线。
 *
 * 内联时间线(当前轮)与归档(历史轮)共用这一份实现,杜绝「实时看到的过程」与「回看的过程」漂移。
 */
export function collectRunInvocations(events: RunEventRecord[], runId: string | undefined): ArchivedToolInvocation[] {
  if (!runId) return [];
  const invocations: ArchivedToolInvocation[] = [];
  const openByCallId = new Map<string, ArchivedToolInvocation>();

  for (const record of events) {
    if (record.runId !== runId || record.ev.type !== "tool") continue;
    const ev = record.ev;
    if (ev.subagentCallId || ev.roleId) continue;
    if (ev.phase !== "end") {
      const invocation: ArchivedToolInvocation = {
        key: ev.toolCallId ? `tool-${ev.toolCallId}` : `tool-${invocations.length}`,
        name: cleanToolName(ev.name) || ev.name,
        detail: ev.detail,
        input: ev.input,
        output: ev.output,
        isError: ev.isError,
        // 兼容未显式标 phase 的调用帧：只要尚无输出就先视为打开，最终还会与 process item 状态交叉确认。
        running: ev.output === undefined,
        startedAt: record.ts,
      };
      invocations.push(invocation);
      if (ev.toolCallId) openByCallId.set(ev.toolCallId, invocation);
      continue;
    }

    let open = ev.toolCallId ? openByCallId.get(ev.toolCallId) : undefined;
    if (!open) {
      const normalized = normalizedToolName(ev.name);
      open = [...invocations].reverse().find(
        (candidate) => candidate.running && normalizedToolName(candidate.name) === normalized,
      );
    }
    if (open) {
      open.detail = ev.detail ?? open.detail;
      open.input = ev.input ?? open.input;
      open.output = ev.output;
      open.isError = ev.isError;
      open.running = false;
      open.endedAt = record.ts;
      if (ev.toolCallId) openByCallId.delete(ev.toolCallId);
    } else {
      invocations.push({
        key: ev.toolCallId ? `tool-result-${ev.toolCallId}` : `tool-result-${invocations.length}`,
        name: cleanToolName(ev.name) || ev.name,
        detail: ev.detail,
        input: ev.input,
        output: ev.output,
        isError: ev.isError,
        running: false,
        endedAt: record.ts,
      });
    }
  }
  return invocations;
}

/** 某一轮所有事件(含子代理)的首尾到达时刻 —— 顶部「已处理 8.8s」用的就是它。 */
export function runTimeSpan(
  events: RunEventRecord[],
  runId: string | undefined,
): { startedAt?: number; endedAt?: number } {
  if (!runId) return {};
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const record of events) {
    if (record.runId !== runId) continue;
    if (startedAt === undefined || record.ts < startedAt) startedAt = record.ts;
    if (endedAt === undefined || record.ts > endedAt) endedAt = record.ts;
  }
  return { startedAt, endedAt };
}

// 过程消息落归档前的清理:
//  - 只留 agentLog / reasoning / stageTitle / retrieval(其余不属于过程流);
//  - active/流式中间态归一为完成态(快照语义,历史轮不该有转圈);
//  - reasoning 正文截断(长思考流是撑大文件的主因)。
function sanitizeProcessMessages(messages: Message[]): Message[] {
  const kept: Message[] = [];
  for (const message of messages) {
    if (message.kind === "reasoning") {
      const text = typeof message.text === "string" ? truncate(message.text, MAX_ARCHIVED_REASONING) : message.text;
      kept.push({ ...message, text, active: false, completed: true });
    } else if (message.kind === "agentLog") {
      kept.push({
        ...message,
        active: false,
        items: message.items.map((item) => (item.ic === "running" ? { ...item, ic: "check" as const } : item)),
      });
    } else if (message.kind === "stageTitle") {
      kept.push(message);
    } else if (message.kind === "retrieval") {
      // 轮已结束仍停在非终态 = 前置管线被中断:诚实归一为 failed,不臆造成功(快照里不许有转圈)。
      const terminal = message.phase === "done" || message.phase === "skipped" || message.phase === "failed";
      kept.push(
        terminal
          ? { ...message, active: false }
          : { ...message, phase: "failed", error: "interrupted", active: false },
      );
    }
  }
  return kept;
}

/**
 * 打包一轮的归档。没有任何过程内容(纯文本轮)返回 null —— 不为空轮写文件。
 * 时间跨度取该 runId 名下全部事件的首尾;事件已被环形裁剪掉时回退到过程消息为空的判定。
 */
export function buildTurnArchive(input: {
  runId: string;
  anchorUid?: string;
  processMessages: Message[];
  events: RunEventRecord[];
  /** 事件流里已无该轮记录时的兜底时刻(通常传 Date.now())。 */
  fallbackTs: number;
}): TurnProcessArchive | null {
  const messages = sanitizeProcessMessages(input.processMessages);
  if (messages.length === 0) return null;

  const rawInvocations = collectRunInvocations(input.events, input.runId);
  // 超限时丢最旧:回看时最近几步更相关,且与「摘要条上的计数」偏差最小(计数取自 process 流,不受此裁剪影响)。
  const trimmed =
    rawInvocations.length > MAX_ARCHIVED_INVOCATIONS
      ? rawInvocations.slice(rawInvocations.length - MAX_ARCHIVED_INVOCATIONS)
      : rawInvocations;
  const invocations = trimmed.map((invocation) => ({
    ...invocation,
    // 归档态一律非运行中:轮已结束,残留的 running 只会让历史轮显示成转圈。
    running: false,
    input: truncateInput(invocation.input),
    output: invocation.output === undefined ? undefined : truncate(invocation.output, MAX_ARCHIVED_OUTPUT),
  }));

  const span = runTimeSpan(input.events, input.runId);
  return {
    runId: input.runId,
    anchorUid: input.anchorUid,
    startedAt: span.startedAt ?? input.fallbackTs,
    endedAt: span.endedAt ?? input.fallbackTs,
    messages,
    invocations,
  };
}

/** 追加一条归档并按轮数上限裁剪(同 runId 视为重写,避免重试/收尾二次归档产生重复条)。 */
export function appendTurnArchive(list: TurnProcessArchive[], archive: TurnProcessArchive): TurnProcessArchive[] {
  const withoutSame = list.filter((item) => item.runId !== archive.runId);
  const next = [...withoutSame, archive];
  return next.length > MAX_ARCHIVED_TURNS ? next.slice(next.length - MAX_ARCHIVED_TURNS) : next;
}

/**
 * 读盘结果归一:磁盘上是可丢数据,任何形状异常都退化成空数组而不是让会话加载失败。
 * 逐条校验必需字段(runId/messages),脏条直接丢弃。
 */
export function normalizeLoadedArchives(raw: unknown): TurnProcessArchive[] {
  if (!Array.isArray(raw)) return [];
  const out: TurnProcessArchive[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<TurnProcessArchive>;
    if (typeof record.runId !== "string" || !Array.isArray(record.messages)) continue;
    out.push({
      runId: record.runId,
      anchorUid: typeof record.anchorUid === "string" ? record.anchorUid : undefined,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
      endedAt: typeof record.endedAt === "number" ? record.endedAt : 0,
      messages: record.messages as Message[],
      invocations: Array.isArray(record.invocations) ? (record.invocations as ArchivedToolInvocation[]) : [],
    });
  }
  return out.length > MAX_ARCHIVED_TURNS ? out.slice(out.length - MAX_ARCHIVED_TURNS) : out;
}

/**
 * 历史被重写(编辑重发/截断)后丢弃失效归档:锚点消息已不在消息流里的轮不再有落点,
 * 留着只会挂到错误的位置上。锚点为空的自动轮按「保留」处理(它本就不依赖某条用户消息)。
 */
export function dropArchivesWithoutAnchor(list: TurnProcessArchive[], liveUids: Set<string>): TurnProcessArchive[] {
  return list.filter((item) => !item.anchorUid || liveUids.has(item.anchorUid));
}
