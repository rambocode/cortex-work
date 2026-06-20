import { ipcMain, type WebContents } from "electron";

export interface AgentTraceEvent {
  id: string;
  ts: number;
  scope: "cli" | "oneshot" | "ask" | "pi" | "pi-rpc";
  phase: string;
  summary: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
  data?: unknown;
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

const MAX_EVENTS = 500;
const MAX_STRING_LENGTH = 4000;
const traceEvents: AgentTraceEvent[] = [];
const subscribers = new Set<WebContents>();
let seq = 0;

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

export function recordAgentTrace(input: AgentTraceInput): AgentTraceEvent {
  const event: AgentTraceEvent = {
    ...input,
    id: traceId(),
    ts: Date.now(),
    data: sanitizeTraceData(input.data),
  };
  traceEvents.push(event);
  if (traceEvents.length > MAX_EVENTS) traceEvents.splice(0, traceEvents.length - MAX_EVENTS);
  emitTrace(event);
  return event;
}

export function agentTraceList(): AgentTraceEvent[] {
  return traceEvents.map((event) => ({ ...event }));
}

export function agentTraceClear(): void {
  traceEvents.splice(0, traceEvents.length);
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
  seq = 0;
}
