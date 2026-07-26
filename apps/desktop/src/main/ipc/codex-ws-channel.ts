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
import { createLogger } from "../log";
import { codexMcpToolName, codexWebSearchOutput } from "../agents/codex";
import {
  CODEX_NOTIF,
  type AgentMessageDeltaParams,
  type CodexSandboxMode,
  type CodexApprovalPolicy,
  type CodexUserInput,
  type ErrorNotificationParams,
  type ItemNotificationParams,
  type ReasoningDeltaParams,
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

// codex ws 通道盲区观测(U4):请求超时 / 意外断连 等会静默卡死 turn 的节点在此落盘。
// 埋点失败 try/catch 吞掉,不阻断 ws 主流程(R14)。
const log = createLogger("codex-ws");

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
  // accept-edits 与 sandbox(外部沙箱)同走原生 workspace-write 受限沙箱,与 codex.ts exec 路径一致
  // (避免外部沙箱档在 WS 主交互路径反而落入 danger-full-access 拿到全盘权限的安全分叉)。
  if (mode === "accept-edits" || mode === "sandbox") return { sandbox: "workspace-write", approvalPolicy: "never" };
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
  imageGeneration: "Image", // imagegen skill:item/started 走过程「Image」步骤,完成时另出内联图(见 itemCompleted)
};
const WS_TOOL_TYPES = new Set(Object.keys(WS_TOOL_NAMES));

// MCP 调用带上 server/tool(与 exec 路径共用 codexMcpToolName):否则渲染端只看到裸「MCP」,
// 查不到中文标签、也分不清同一回合里的十几次调用各自在做什么。
function wsToolName(item: NonNullable<ItemNotificationParams["item"]>): string {
  if (item.type === "mcpToolCall") {
    const mcpName = codexMcpToolName(item);
    if (mcpName) return mcpName;
  }
  // 调用点已用 WS_TOOL_TYPES.has(item.type) 守过,查表必命中;类型上仍兜底为原始 type。
  const type = item.type ?? "";
  return WS_TOOL_NAMES[type] ?? type;
}

function clip(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

// 工具输出截断上限(与 claude/codex exec adapter 同值):防超大输出撑爆 IPC 与渲染端内存。
const MAX_TOOL_OUTPUT = 8_000;
function clipToolOutput(s: unknown): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + "…" : s;
}

function toolDetail(item: NonNullable<ItemNotificationParams["item"]>): string | undefined {
  if (item.type === "commandExecution") return clip(item.command);
  return clip(item.path ?? item.query ?? item.tool ?? item.server);
}

/** 解析上下文:agentMessage delta 的 phase 查询(commentary→thinking,final_answer→text)。 */
export interface ParseCtx {
  agentMessagePhase?: (itemId: string | undefined) => string | undefined;
}

/**
 * U4:把一条 app-server 通知映射为归一化 CliStreamEvent(s)。无关/未知通知返回 null。
 * 纯函数,供通道与单测共用。init 不在此处产出(由通道在 thread/start 应答后显式发,见 CodexWsChannel)。
 *
 * 「执行过程」与「对话回复」分流(用户要求:思考/过程进右侧运行过程面板,不进回复):
 *   - reasoning 摘要/原文增量 → thinking(右侧过程流)
 *   - agentMessage phase=commentary(过程叙述) → thinking;phase=final_answer/未知 → text(回复)
 */
export function parseAppServerEvent(
  method: string,
  params: unknown,
  ctx?: ParseCtx,
): CliStreamEvent | CliStreamEvent[] | null {
  switch (method) {
    case CODEX_NOTIF.agentMessageDelta: {
      const p = (params ?? {}) as AgentMessageDeltaParams;
      const delta = p.delta ?? p.text ?? "";
      if (!delta) return null;
      // commentary 是 codex 的过程叙述(如「我先读 skill 再执行 ls」),归入 thinking(右侧过程),
      // 保持对话回复只含 final_answer。phase 未知时按回复处理(向后兼容,见 MessagePhase 文档)。
      const phase = ctx?.agentMessagePhase?.(p.itemId);
      return phase === "commentary" ? { type: "thinking", delta } : { type: "text", delta };
    }
    case CODEX_NOTIF.reasoningSummaryDelta:
    case CODEX_NOTIF.reasoningTextDelta: {
      const p = (params ?? {}) as ReasoningDeltaParams;
      return p.delta ? { type: "thinking", delta: p.delta } : null;
    }
    case CODEX_NOTIF.itemCompleted: {
      // 图片产物在完成时透出:imageGeneration(imagegen skill)/imageView → 以 markdown 图片插入回复,
      // 渲染端 chatMarkdown + ChatInlineImage(bridge.imageReadAny)内联显示绝对路径图片。
      // 工具项完成 → phase:"end" 事件(输出正文 + 失败标记,toolCallId 与 start 配对,
      // 运行过程详情视图消费;agentLog 折叠对 end 有守卫不翻倍)。text 仍走 delta。
      const item = (params as ItemNotificationParams)?.item;
      if (item?.type === "imageGeneration" && item.savedPath)
        return { type: "text", delta: `\n\n![生成的图片](${item.savedPath})\n\n` };
      if (item?.type === "imageView" && item.path)
        return { type: "text", delta: `\n\n![图片](${item.path})\n\n` };
      if (item && typeof item.type === "string" && WS_TOOL_TYPES.has(item.type)) {
        // 输出/退出码双拼写兜底:app-server 按 camelCase 假设,exec JSONL 实测 snake_case,都读。
        const exitCode = item.exitCode ?? item.exit_code;
        // end 帧的 input = 完成 item 剔除输出正文字段:webSearch 等的最终查询词只在完成帧才有,
        // 渲染端用它覆盖调用行 started 时 query:"" 的快照;输出正文可能极大,另走 output 截断透出。
        const itemMeta: Record<string, unknown> = { ...item };
        delete itemMeta.aggregatedOutput;
        delete itemMeta.aggregated_output;
        return {
          type: "tool",
          name: wsToolName(item),
          // end 帧也透出 detail:webSearch 的查询词在 item/started 时常为空(服务端尚未生成),
          // 完成帧才带上 → 渲染端靠它回填调用行/结果行摘要,否则整条搜索呈现为「空调用+无输出」。
          detail: toolDetail(item),
          input: itemMeta,
          phase: "end",
          toolCallId: typeof item.id === "string" ? item.id : undefined,
          // webSearch 无结果正文回传(OpenAI 服务端注入模型上下文)→ 用查询词/来源合成输出;
          // 其余工具照常读 aggregatedOutput。
          output:
            item.type === "webSearch"
              ? clipToolOutput(codexWebSearchOutput(item))
              : clipToolOutput(item.aggregatedOutput ?? item.aggregated_output),
          isError: (typeof exitCode === "number" && exitCode !== 0) || item.status === "failed",
        };
      }
      return null;
    }
    case CODEX_NOTIF.itemStarted: {
      const item = (params as ItemNotificationParams)?.item;
      if (!item || typeof item.type !== "string" || !WS_TOOL_TYPES.has(item.type)) return null;
      return {
        type: "tool",
        name: wsToolName(item),
        detail: toolDetail(item),
        // 完整调用参数(运行过程详情视图展示):item 本身即调用描述,原样透出。
        input: item,
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
  req: Pick<CliStartRequest, "prompt" | "appendSystemPrompt" | "images" | "invokedSkill">,
): CodexUserInput[] {
  const input: CodexUserInput[] = [{ type: "text", text: wrapPrompt(req), text_elements: [] }];
  for (const img of req.images ?? []) input.push({ type: "localImage", path: img.path });
  // U4:codex 原生 skill 触发。选中 skill 时把它作为 turn/start 的原生 skill input item 显式带上,
  // 由 app-server 注入完整 skill 指令(不再由 cortex 改写 prose)。缺省(未选 skill)时不追加,
  // input 数组与改动前逐字一致(向后兼容,不误伤既有调用点)。
  if (req.invokedSkill)
    input.push({ type: "skill", name: req.invokedSkill.name, path: req.invokedSkill.path });
  return input;
}

// U4:codex `codex exec`(非 ws)回退时的定向 prose。codex 的 slash→内容 替换只在交互式 TUI 输入层
// 生效,`codex exec`(委派等退回 exec 的场景)一律把 /name 当纯文本(见 plan KTD2)—— 故 ws 走原生
// skill input item,exec 退回把选中 skill 渲染成「读 SKILL.md 再执行」的定向 prompt,与本次改动前
// codex 单发 skill 的 prose 行为等价(R3 不倒退)。
// ⚠️ 跨进程契约:文案须与 core 的 renderSkillInvocation 对齐(主进程不能 import core 运行时,故各持
// 一份逻辑);invokedSkill 仅带 name/path,description 段落随之省略。name/path 去换行防越界注入。
export function renderCodexSkillFallback(skill: { name: string; path: string }, args: string): string {
  const name = skill.name.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim();
  const dir = skill.path.replace(/[\r\n]+/g, " ");
  const lines = [
    `请使用 skill「${name}」完成本次任务。`,
    `指令文件:${dir}/SKILL.md —— 请先用 Read 工具查看完整指令,再据此执行。`,
  ];
  if (args) lines.push(`本次参数:${args}`);
  return lines.join("\n");
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
  // agentMessage itemId → phase(commentary/final_answer):delta 通知不带 phase,从 item/started 记下,
  // 供 parseAppServerEvent 把 commentary 分流到 thinking(右侧过程)、final_answer 留在 text(回复)。
  private agentMsgPhases = new Map<string, string>();

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
        // 盲区补点(R10):非主动 stop() 的 close = app-server 意外断连(进程崩溃/被杀),
        // 会让上层看门狗收尾本轮。记录 code/reason 便于复盘崩溃原因;主动关闭(expected)不噪声。
        if (!this.stopped) {
          try {
            log.warn("codex ws 意外断连", { code: e?.code, reason: e?.reason, handshake: !opened });
          } catch {
            /* 日志失败不影响 close 回调 */
          }
        }
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
    return id; // init 由 run 每轮发(持久连接复用时不会再调 startThread)
  }

  /** thread/resume 续接已有 thread。init 由 run 每轮发。 */
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
  }

  /** turn/start → turnId。实际工作经通知流式产出(thinking/text/tool/usage/result)。 */
  async startTurn(params: {
    input: CodexUserInput[];
    effort?: string;
    model?: string;
    /** 推理摘要档:默认 "auto" → codex 发 item/reasoning/summaryTextDelta,思考过程可见(右侧)。 */
    summary?: "auto" | "concise" | "detailed" | "none";
  }): Promise<string> {
    if (!this._threadId) throw new Error("startTurn 前需先 startThread/resumeThread");
    this.turnSettled = false;
    this.agentMsgPhases.clear(); // 新 turn 重置 phase 表
    const res = (await this.request("turn/start", {
      threadId: this._threadId,
      input: params.input,
      // 开启推理摘要(默认 auto):否则 codex 不发 reasoning 增量,右侧过程看不到思考。
      summary: params.summary ?? "auto",
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
        if (this.pending.delete(id)) {
          // 盲区补点(R10):JSON-RPC 请求超时(thread/turn/interrupt 等),记录 method + 阈值
          // 便于定位是 app-server 未响应还是阈值过短。仅观测,不改 reject 行为。
          try {
            log.warn("codex ws 请求超时", { method, timeoutMs });
          } catch {
            /* 日志失败不影响 reject */
          }
          reject(new Error(`请求超时:${method}`));
        }
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
      // 记录 agentMessage 的 phase(delta 通知不带 phase,从 item/started 取),供 commentary/final_answer 分流。
      if (msg.method === CODEX_NOTIF.itemStarted) {
        const item = (msg.params as ItemNotificationParams)?.item;
        if (item?.type === "agentMessage" && typeof item.id === "string")
          this.agentMsgPhases.set(item.id, item.phase ?? "");
      }
      const mapped = parseAppServerEvent(msg.method, msg.params, {
        agentMessagePhase: (id) => (id ? this.agentMsgPhases.get(id) : undefined),
      });
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
