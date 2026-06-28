import { ipcMain, type WebContents } from "electron";

// 流式增量段类型:text=assistant 正文,reasoning=思考过程。各自合并为独立的一条段。
export type TraceSegmentType = "text" | "reasoning";

export interface AgentTraceEvent {
  id: string;
  ts: number;
  scope: "cli" | "oneshot" | "ask" | "pi" | "pi-rpc" | "roundtable";
  phase: string;
  summary: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
  data?: unknown;
  // ↓ 流式合并段专用(普通事件不带):标记该条是由连续同类增量累积而成的「段」。
  segmentType?: TraceSegmentType; // 段类型(text / reasoning)
  streaming?: boolean; // true=仍在生长,false=已收尾定格
  deltaCount?: number; // 已累积的增量个数
}

export interface AgentTraceInput {
  scope: AgentTraceEvent["scope"];
  phase: string;
  summary: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
  data?: unknown;
}

// 流式增量入参:调用方(cli.ts / pi-session.ts)把 text/reasoning 增量交给记录端合并。
export interface StreamDeltaInput {
  scope: AgentTraceEvent["scope"];
  segmentType: TraceSegmentType;
  delta: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
}

const MAX_EVENTS = 500;
const MAX_STRING_LENGTH = 4000;
const traceEvents: AgentTraceEvent[] = [];
const subscribers = new Set<WebContents>();
let seq = 0;

// 「打开中的段」:同一 run/session 在任一时刻至多一条活跃段(增量按序到达)。
// key = scope + run/session,保证并发 run 互不串场(R3)。
interface OpenSegment {
  event: AgentTraceEvent; // 复用同一 id 的 live 事件,随增量原地更新
  content: string; // 累积原文(上限 MAX_STRING_LENGTH)
}
const openSegments = new Map<string, OpenSegment>();

function streamKey(input: { scope: string; runId?: string; sessionId?: string }): string {
  return `${input.scope}::${input.runId ?? input.sessionId ?? "anon"}`;
}

// 收尾指定 key 的打开段:翻 streaming=false 并末次广播,从 map 摘除。事件已在缓冲内(开段时已 push),此处不重复入队。
function finalizeOpenSegment(key: string): void {
  const seg = openSegments.get(key);
  if (!seg) return;
  seg.event.streaming = false;
  openSegments.delete(key);
  emitTrace(seg.event);
}

function traceId(): string {
  seq += 1;
  return `trace-${Date.now()}-${seq}`;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "cortexpikey" ||
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
}

export function sanitizeTraceData(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value);
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceData(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? "[redacted]" : sanitizeTraceData(item);
  }
  return out;
}

function emitTrace(event: AgentTraceEvent): void {
  for (const sender of subscribers) {
    if (sender.isDestroyed()) {
      subscribers.delete(sender);
      continue;
    }
    sender.send("agent-trace:event", event);
  }
}

// 入队并裁剪环形缓冲;被淘汰的事件若恰是打开段则一并摘除,避免悬挂引用。
function pushEvent(event: AgentTraceEvent): void {
  traceEvents.push(event);
  if (traceEvents.length > MAX_EVENTS) {
    const removed = traceEvents.splice(0, traceEvents.length - MAX_EVENTS);
    if (openSegments.size > 0) {
      const removedIds = new Set(removed.map((e) => e.id));
      for (const [key, seg] of openSegments) {
        if (removedIds.has(seg.event.id)) {
          // 打开段被挤出缓冲:末次广播 streaming=false,否则 renderer 该行永久停在「生长中…」。
          seg.event.streaming = false;
          emitTrace(seg.event);
          openSegments.delete(key);
        }
      }
    }
  }
}

export function recordAgentTrace(input: AgentTraceInput): AgentTraceEvent {
  // 落普通(非增量)事件前,先收尾同 run/session 的打开段,保证顺序(如 tool 事件到达时 text 段定格)。
  // 例外:stderr 是与 stdout 并发的旁路噪声,不是流式段的逻辑边界——若收尾,交错到达的 stderr
  // 会把正在生长的 text 段切碎(tool/result/turn-end/exit 等真实边界仍照常收尾)。
  if (input.phase !== "stderr") finalizeOpenSegment(streamKey(input));
  const event: AgentTraceEvent = {
    ...input,
    id: traceId(),
    ts: Date.now(),
    data: sanitizeTraceData(input.data),
  };
  pushEvent(event);
  emitTrace(event);
  return event;
}

// 记录一个流式增量:连续同类型增量累积到同一条「段」并实时广播(同 id);类型变化或无打开段则另起新段。
export function recordStreamDelta(input: StreamDeltaInput): AgentTraceEvent {
  const key = streamKey(input);
  const existing = openSegments.get(key);
  if (existing && existing.event.segmentType === input.segmentType) {
    // 命中同类型打开段:追加内容(上限截断)、刷新 ts/deltaCount,原地更新同一条。
    const combined = existing.content + input.delta;
    existing.content =
      combined.length > MAX_STRING_LENGTH ? `${combined.slice(0, MAX_STRING_LENGTH)}…` : combined;
    existing.event.ts = Date.now();
    existing.event.deltaCount = (existing.event.deltaCount ?? 0) + 1;
    existing.event.data = { [input.segmentType]: existing.content };
    emitTrace(existing.event);
    return existing.event;
  }
  // 类型变化或无打开段:先收尾旧段,再开新段。
  if (existing) finalizeOpenSegment(key);
  const content =
    input.delta.length > MAX_STRING_LENGTH ? `${input.delta.slice(0, MAX_STRING_LENGTH)}…` : input.delta;
  const event: AgentTraceEvent = {
    id: traceId(),
    ts: Date.now(),
    scope: input.scope,
    phase: "event",
    summary: `${input.agent ?? input.scope} ${input.segmentType}`,
    runId: input.runId,
    sessionId: input.sessionId,
    agent: input.agent,
    segmentType: input.segmentType,
    streaming: true,
    deltaCount: 1,
    data: { [input.segmentType]: content },
  };
  pushEvent(event);
  openSegments.set(key, { event, content });
  emitTrace(event);
  return event;
}

export function agentTraceList(): AgentTraceEvent[] {
  return traceEvents.map((event) => ({ ...event }));
}

export function agentTraceClear(): void {
  traceEvents.splice(0, traceEvents.length);
  // 一并清打开段,否则清空后仍在流的增量会命中残留段、以旧 id 重新冒出幽灵行。
  openSegments.clear();
}

function assertDevMode(devMode: boolean): void {
  if (!devMode) throw new Error("Agent trace 仅在开发环境可用");
}

export function registerAgentTraceHandlers({ devMode }: { devMode: boolean }): void {
  ipcMain.handle("agent-trace:list", async () => {
    assertDevMode(devMode);
    return agentTraceList();
  });
  ipcMain.handle("agent-trace:clear", async () => {
    assertDevMode(devMode);
    agentTraceClear();
  });
  ipcMain.on("agent-trace:subscribe", (event) => {
    if (!devMode) return;
    subscribers.add(event.sender);
    event.sender.once("destroyed", () => subscribers.delete(event.sender));
  });
  ipcMain.on("agent-trace:unsubscribe", (event) => {
    subscribers.delete(event.sender);
  });
}

export function __resetAgentTraceForTest(): void {
  traceEvents.splice(0, traceEvents.length);
  subscribers.clear();
  openSegments.clear();
  seq = 0;
}
