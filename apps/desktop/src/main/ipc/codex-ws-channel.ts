// codex app-server WebSocket JSON-RPC 双工通道(U3) + 通知归一化解析器(U4)。
//
// 结构同构于 pi-rpc.ts 的长驻 RPC 通道:请求-应答经 id 关联(pending Map + 超时),通知(无 id)走
// onEvent 回调;stopped/closed 双 flag 防重连/旧事件串入。传输换成 WebSocket 文本帧。
//
// on-the-wire(实测 codex-cli 0.142.2,见计划 Open Questions):JSON-RPC **省略 jsonrpc 字段**。
//   发送请求 {method,id,params};发送通知 {method,params};
//   收到响应 {id,result|error};收到通知 {method,params}(无 id)。
//
// WebSocket 注入:生产用 `globalThis.WebSocket`(Electron 39 主进程 Node 22 自带);单测在 Node 20
// 下无全局 WebSocket,故构造器可注入 fake(KTD3 修订)。

import type { CliStreamEvent, CliStartRequest, PermissionMode } from "./types";
import {
  CODEX_NOTIF,
  type AgentMessageDeltaParams,
  type CodexSandboxMode,
  type CodexApprovalPolicy,
  type CodexUserInput,
  type ErrorNotificationParams,
  type ItemNotificationParams,
  type ThreadStartResult,
  type TokenUsageParams,
  type TurnCompletedParams,
  type TurnStartResult,
} from "../agents/codex-app-server-protocol";

// ── 最小 WebSocket 接口(WHATWG 风格,生产由 globalThis.WebSocket 满足) ──────────
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (ev: unknown) => void): void;
}
export type WsFactory = (url: string) => WsLike;

const defaultWsFactory: WsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
  if (!Ctor) throw new Error("全局 WebSocket 不可用(需 Node 22+/Electron 主进程)");
  return new Ctor(url);
};

// ── U4:权限档 → sandbox + approvalPolicy(KTD6) ───────────────────────────────
// thread/start 的 sandbox 用字符串枚举(SandboxMode);approvalPolicy 恒 "never"(无人值守不弹审批)。
export function mapPermissionMode(mode: PermissionMode | undefined): {
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
} {
  if (mode === "plan") return { sandbox: "read-only", approvalPolicy: "never" };
  if (mode === "accept-edits") return { sandbox: "workspace-write", approvalPolicy: "never" };
  return { sandbox: "danger-full-access", approvalPolicy: "never" }; // full-auto / 缺省
}

// ── U4:app-server item.type → 归一化 tool 名 ───────────────────────────────────
// 注意:app-server 用 camelCase(commandExecution),与 `codex exec` JSONL 的 snake_case(command_execution)不同。
const WS_TOOL_NAMES: Record<string, string> = {
  commandExecution: "Shell",
  fileChange: "Edit",
  patchApply: "Edit",
  mcpToolCall: "MCP",
  webSearch: "WebSearch",
};
const WS_TOOL_TYPES = new Set(Object.keys(WS_TOOL_NAMES));

function clip(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

function toolDetail(item: NonNullable<ItemNotificationParams["item"]>): string | undefined {
  if (item.type === "commandExecution") return clip(item.command);
  return clip(item.path ?? item.query ?? item.tool ?? item.server);
}

/**
 * U4:把一条 app-server 通知映射为归一化 CliStreamEvent(s)。无关/未知通知返回 null。
 * 纯函数,供通道与单测共用。init 不在此处产出(由通道在 thread/start 应答后显式发,见 CodexWsChannel)。
 */
export function parseAppServerEvent(
  method: string,
  params: unknown,
): CliStreamEvent | CliStreamEvent[] | null {
  switch (method) {
    case CODEX_NOTIF.agentMessageDelta: {
      const p = (params ?? {}) as AgentMessageDeltaParams;
      const delta = p.delta ?? p.text ?? "";
      return delta ? { type: "text", delta } : null;
    }
    case CODEX_NOTIF.itemStarted: {
      const item = (params as ItemNotificationParams)?.item;
      if (!item || typeof item.type !== "string" || !WS_TOOL_TYPES.has(item.type)) return null;
      return {
        type: "tool",
        name: WS_TOOL_NAMES[item.type],
        detail: toolDetail(item),
        phase: "start",
        toolCallId: typeof item.id === "string" ? item.id : undefined,
      };
    }
    case CODEX_NOTIF.tokenUsage: {
      const total = (params as TokenUsageParams)?.tokenUsage?.total;
      if (!total) return null;
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      const inputTokens = num(total.inputTokens);
      const outputTokens = num(total.outputTokens);
      const cachedInputTokens = num(total.cachedInputTokens);
      if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined)
        return null;
      return { type: "usage", inputTokens, outputTokens, cachedInputTokens };
    }
    case CODEX_NOTIF.turnCompleted: {
      const p = (params ?? {}) as TurnCompletedParams;
      const status = p.turn?.status;
      if (status === "completed") return { type: "result", ok: true };
      return {
        type: "result",
        ok: false,
        error: stringifyErr(p.turn?.error ?? p.error) || `turn ${status ?? "failed"}`,
      };
    }
    case CODEX_NOTIF.error: {
      const p = (params ?? {}) as ErrorNotificationParams;
      return { type: "result", ok: false, error: p.message || "codex app-server error" };
    }
    default:
      return null;
  }
}

function stringifyErr(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (typeof e === "object" && e && "message" in e && typeof (e as { message: unknown }).message === "string")
    return (e as { message: string }).message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ── U3:turn 输入构造(文本 + 本地图片) ────────────────────────────────────────
function wrapPrompt(req: Pick<CliStartRequest, "prompt" | "appendSystemPrompt">): string {
  if (!req.appendSystemPrompt) return req.prompt;
  return `${req.appendSystemPrompt}\n\n<user_request>\n${req.prompt}\n</user_request>`;
}
export function buildTurnInput(
  req: Pick<CliStartRequest, "prompt" | "appendSystemPrompt" | "images">,
): CodexUserInput[] {
  const input: CodexUserInput[] = [{ type: "text", text: wrapPrompt(req), text_elements: [] }];
  for (const img of req.images ?? []) input.push({ type: "localImage", path: img.path });
  return input;
}

// ── U3:通道 ──────────────────────────────────────────────────────────────────
export interface CodexWsChannelOpts {
  wsUrl: string;
  clientVersion?: string;
  createWebSocket?: WsFactory;
  requestTimeoutMs?: number;
  /** 归一化事件回调(含通道自产的 init 与通知映射结果)。 */
  onEvent: (ev: CliStreamEvent) => void;
  /** 收到任意 ws 消息时回调(供主进程看门狗 noteActivity + keepalive)。 */
  onActivity?: () => void;
  /** ws 关闭。expected=主动 close。 */
  onClose?: (info: { code?: number; reason?: string; expected: boolean }) => void;
  onError?: (err: Error) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexWsChannel {
  private ws: WsLike | null = null;
  private readonly opts: CodexWsChannelOpts;
  private readonly pending = new Map<number, Pending>();
  private idc = 0;
  private stopped = false; // 主动 stop()/close() 后置位:丢弃后续通知,防旧事件串入
  private closed = false; // ws 已关闭
  private _threadId: string | undefined;
  private _turnId: string | undefined;
  private turnSettled = false; // 当前 turn 是否已产出终态 result(防重复 result)

  constructor(opts: CodexWsChannelOpts) {
    this.opts = opts;
  }

  get threadId(): string | undefined {
    return this._threadId;
  }

  /** 建立连接 + initialize/initialized 握手。resolve 表示可发 thread/turn。 */
  connect(): Promise<void> {
    const factory = this.opts.createWebSocket ?? defaultWsFactory;
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let ws: WsLike;
      try {
        ws = factory(this.opts.wsUrl);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      ws.addEventListener("message", (ev) => this.onMessage(ev));
      ws.addEventListener("error", () => {
        if (!opened) reject(new Error("ws 连接失败"));
        this.opts.onError?.(new Error("ws error"));
      });
      ws.addEventListener("close", (ev) => {
        this.closed = true;
        const e = ev as { code?: number; reason?: string };
        this.rejectAllPending(new Error("ws 已关闭"));
        if (!opened) reject(new Error("ws 在握手前关闭"));
        this.opts.onClose?.({ code: e?.code, reason: e?.reason, expected: this.stopped });
      });
      ws.addEventListener("open", async () => {
        opened = true;
        try {
          await this.request("initialize", {
            clientInfo: {
              name: "cortex-desktop",
              title: "Cortex Desktop",
              version: this.opts.clientVersion ?? "0.0.0",
            },
            capabilities: { experimentalApi: true, requestAttestation: false },
          });
          this.notify("initialized", {});
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  }

  /** thread/start → threadId,并产出 init 事件(sessionId=threadId,供持久化与续接)。 */
  async startThread(params: {
    cwd: string;
    permissionMode?: PermissionMode;
    model?: string;
  }): Promise<string> {
    const { sandbox, approvalPolicy } = mapPermissionMode(params.permissionMode);
    const res = (await this.request("thread/start", {
      cwd: params.cwd,
      sandbox,
      approvalPolicy,
      ...(params.model ? { model: params.model } : {}),
    })) as ThreadStartResult;
    const id = res?.thread?.id;
    if (!id) throw new Error("thread/start 未返回 thread.id");
    this._threadId = id;
    this.opts.onEvent({ type: "init", sessionId: id });
    return id;
  }

  /** thread/resume 续接已有 thread,并(幂等)产出 init 保持契约。 */
  async resumeThread(
    threadId: string,
    params: { cwd?: string; permissionMode?: PermissionMode; model?: string },
  ): Promise<void> {
    const { sandbox, approvalPolicy } = mapPermissionMode(params.permissionMode);
    await this.request("thread/resume", {
      threadId,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      sandbox,
      approvalPolicy,
      ...(params.model ? { model: params.model } : {}),
    });
    this._threadId = threadId;
    this.opts.onEvent({ type: "init", sessionId: threadId });
  }

  /** turn/start → turnId。实际工作经通知流式产出(text/tool/usage/result)。 */
  async startTurn(params: {
    input: CodexUserInput[];
    effort?: string;
    model?: string;
  }): Promise<string> {
    if (!this._threadId) throw new Error("startTurn 前需先 startThread/resumeThread");
    this.turnSettled = false;
    const res = (await this.request("turn/start", {
      threadId: this._threadId,
      input: params.input,
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.model ? { model: params.model } : {}),
    })) as TurnStartResult;
    const id = res?.turn?.id;
    this._turnId = id ?? undefined;
    return id ?? "";
  }

  /** 中途取消:优先 turn/interrupt(OQ5=存在);无 turnId 则无操作(由上层 ws.close 兜底)。 */
  async interrupt(): Promise<void> {
    if (!this._threadId || !this._turnId) return;
    try {
      await this.request("turn/interrupt", { threadId: this._threadId, turnId: this._turnId });
    } catch {
      /* 取消尽力而为;失败由上层 close + 杀进程兜底 */
    }
  }

  /** 主动关闭:置 stopped(丢弃后续通知)+ 关 ws + drain pending。 */
  close(): void {
    this.stopped = true;
    this.rejectAllPending(new Error("通道已关闭"));
    try {
      this.ws?.close();
    } catch {
      /* 已关闭 */
    }
  }

  // ── 内部 ──
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.stopped) return Promise.reject(new Error("通道不可用"));
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("ws 未连接"));
    const id = this.idc++;
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`请求超时:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ method, id, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.ws?.send(JSON.stringify({ method, params }));
    } catch {
      /* 发送失败由后续 close/error 路由 */
    }
  }

  private onMessage(ev: unknown): void {
    this.opts.onActivity?.(); // 任意消息都算活跃(看门狗/keepalive)
    const raw = (ev as { data?: unknown })?.data;
    let msg: { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return; // 非 JSON 帧忽略
    }
    // 响应:有 id 且带 result/error
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new Error(stringifyErr(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // 通知:stopped 后丢弃(防旧事件串入新会话)
    if (typeof msg.method === "string" && !this.stopped) {
      const mapped = parseAppServerEvent(msg.method, msg.params);
      if (!mapped) return;
      const events = Array.isArray(mapped) ? mapped : [mapped];
      for (const e of events) {
        // 每 turn 仅放行一个终态 result,防 error + turn/completed 双 result
        if (e.type === "result") {
          if (this.turnSettled) continue;
          this.turnSettled = true;
        }
        this.opts.onEvent(e);
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
