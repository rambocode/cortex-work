// pi RPC 长驻会话通道（pi --mode rpc）。与单发 cli.ts 并存:pi 经此获得运行时控制
// （steer/abort/fork/切模型/压缩），claude/codex 仍走 cli.ts 单发管线。
//
// 协议（实测 0.79.2，详见 docs/plans/2026-06-16-003-feat-pi-rpc-session-plan.md）：
//   · stdin 逐行发命令 JSON（带 id 关联）；stdout 逐行回 {type:"response",id,...} 或事件。
//   · 分帧严格按 \n（payload 可能含 U+2028/U+2029,只能切 \n）。
//   · 启动不主动 emit sessionId,需发 get_state 取;冷启动 ~790ms,就绪靠 get_state 探测。
//   · run 失败（坏 key/限流/provider 挂/abort）只体现在 message_end 的 stopReason=error|aborted
//     + errorMessage 上（与单发 pi.ts 同款陷阱）；命令级失败走 {type:"response",success:false}。

import { spawn } from "child_process";

import { resolvePiBinary } from "./pi-locate";
import { safeId } from "./pi-providers";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "../ipc/types";

// 从工具入参里取一段可读 detail（命令 / 路径 / 模式 / URL），过长截断。与 pi.ts 对齐。
function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const candidate = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url;
  if (typeof candidate !== "string") return undefined;
  return candidate.length > 80 ? candidate.slice(0, 80) + "…" : candidate;
}

// diagnostics 最后一项里的错误信息（provider_transport_failure 等）。与 pi.ts 对齐。
function diagnosticsError(diagnostics: unknown): string | undefined {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return undefined;
  const last = diagnostics[diagnostics.length - 1] as Record<string, unknown> | undefined;
  const err = last?.error as Record<string, unknown> | undefined;
  return typeof err?.message === "string" ? err.message : undefined;
}

/**
 * 把 pi 的 AgentSessionEvent（stdout 事件行）映射为归一化 PiSessionEvent。
 * 无状态纯函数:无法识别 / 需忽略的事件（agent_start、turn_start、message_start、
 * text_start、text_end、toolcall_start/delta/end、auto_retry_end、response、以及正常收尾的
 * message_end）返回 null。run 失败的 message_end（stopReason=error|aborted）映射为 error 事件。
 */
export function mapPiEvent(raw: unknown): PiSessionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "message_update": {
      const ev = o.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!ev || typeof ev !== "object") return null;
      if (ev.type === "text_delta" && typeof ev.delta === "string") return { type: "text", delta: ev.delta };
      if (ev.type === "thinking_delta" && typeof ev.delta === "string") return { type: "reasoning", delta: ev.delta };
      // 防御性:实测 pi 0.79.2 的错误不走这里（走 message_end，见下），保留以防协议变体。
      if (ev.type === "error") {
        const errObj = ev.error as Record<string, unknown> | undefined;
        const error =
          (typeof errObj?.errorMessage === "string" ? errObj.errorMessage : undefined) ??
          (typeof ev.reason === "string" ? ev.reason : undefined) ??
          "error";
        return { type: "error", error };
      }
      return null;
    }
    case "message_end": {
      // run 的真实错误载体:assistant message 的 stopReason=error|aborted + errorMessage（与 pi.ts
      // 100-113 同源）。正常收尾（stop/length/toolUse）不产出——turn-end / result 已表达。
      const msg = o.message as Record<string, unknown> | undefined;
      const stopReason = msg?.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        const error =
          (typeof msg?.errorMessage === "string" ? msg.errorMessage : undefined) ??
          diagnosticsError(msg?.diagnostics) ??
          String(stopReason);
        return { type: "error", error };
      }
      return null;
    }
    case "tool_execution_start": {
      if (typeof o.toolName !== "string" || typeof o.toolCallId !== "string") return null;
      const out: Extract<PiSessionEvent, { type: "tool-start" }> = {
        type: "tool-start",
        name: o.toolName,
        toolCallId: o.toolCallId,
      };
      const detail = toolDetail(o.args);
      if (detail) out.detail = detail;
      return out;
    }
    case "tool_execution_end": {
      if (typeof o.toolName !== "string" || typeof o.toolCallId !== "string") return null;
      return { type: "tool-end", name: o.toolName, toolCallId: o.toolCallId, isError: !!o.isError };
    }
    case "turn_end":
      return { type: "turn-end" };
    case "agent_end":
      return { type: "result", willRetry: !!o.willRetry };
    case "compaction_start":
    case "compaction_end": {
      const out: Extract<PiSessionEvent, { type: "compaction" }> = {
        type: "compaction",
        phase: o.type === "compaction_start" ? "start" : "end",
      };
      if (typeof o.reason === "string") out.reason = o.reason;
      return out;
    }
    case "auto_retry_start": {
      const out: Extract<PiSessionEvent, { type: "retry" }> = {
        type: "retry",
        attempt: typeof o.attempt === "number" ? o.attempt : 0,
      };
      if (typeof o.maxAttempts === "number") out.maxAttempts = o.maxAttempts;
      if (typeof o.errorMessage === "string") out.error = o.errorMessage;
      return out;
    }
    case "queue_update":
      return {
        type: "queue",
        steering: Array.isArray(o.steering) ? o.steering.length : 0,
        followUp: Array.isArray(o.followUp) ? o.followUp.length : 0,
      };
    case "session_info_changed": {
      const out: Extract<PiSessionEvent, { type: "session-info" }> = { type: "session-info" };
      if (typeof o.name === "string") out.name = o.name;
      return out;
    }
    case "thinking_level_changed":
      return typeof o.level === "string" ? { type: "thinking-level", level: o.level } : null;
    default:
      return null;
  }
}

// 子进程传输抽象。生产用 child_process（spawnPiRpc），测试注入 fake。
// onExit 回带 stderr tail 供崩溃诊断（非 0 退出时拼进 crashed.error）。
export interface RpcTransport {
  write(line: string): void; // 写一行（含末尾 \n）到子进程 stdin
  onStdout(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null, stderrTail?: string) => void): void;
  onError(cb: (err: Error) => void): void;
  kill(): void;
}

/**
 * 构造 `pi --mode rpc` 启动参数。复用单发 pi 的 provider/skill 注入,但**不带**
 * `-p`/prompt/`--session`:prompt 走 stdin 的 prompt 命令、续会话走 switchSession。
 * 与 pi.ts buildArgs 同策略:`--no-extensions` 与显式 `-e` 可共存（实测）。
 */
export function buildRpcArgs(req: PiOpenRequest): string[] {
  const args = ["--mode", "rpc", "--no-extensions"];
  // skills 默认禁用,仅 useOwnSkills===true 时加载（与 pi 单发 / claude adapter 对齐）。
  if (req.useOwnSkills !== true) args.push("--no-skills");
  // extension:provider（piExtensionPath）+ 阶段3 审批/样例（extraExtensionPaths）多 `-e` 共存
  // （spike 已证 --no-extensions 与多个显式 -e 共存、hook 注册）。各加一个 -e,`-a` 信任只加一次。
  const exts = [req.piExtensionPath, ...(req.extraExtensionPaths ?? [])].filter((p): p is string => !!p);
  if (exts.length) {
    for (const p of exts) args.push("-e", p);
    args.push("-a");
    // provider 名必须用 safeId（与 registerProvider 注册名同源）;仅自定义供应商时选中。
    if (req.provider) args.push("--provider", safeId(req.provider.id));
  }
  if (req.model) args.push("--model", req.model);
  // 持久 system prompt（阶段4）:系统级注入,与单发 pi.ts 同款 --append-system-prompt。
  // pi RPC 无运行时改 system prompt 的命令,故只能冷启注入,改值靠 extensionFingerprint 重开会话。
  if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
  // 思考强度初值（阶段5）:冷启经 --thinking 设档;已开会话切档走运行时 set_thinking_level(不重开)。
  if (req.thinkingLevel) args.push("--thinking", req.thinkingLevel);
  return args;
}

// SIGTERM 先礼,3s 未退出再用 pid 强杀。与 cli.ts 同策略,此处自持一份:pi-rpc 不引入
// cli.ts 的 electron 依赖,纯 node 即可单测。
function killWithTimeout(soft: () => void, pid: number | undefined): void {
  soft();
  setTimeout(() => {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  }, 3000);
}

/**
 * 生产用 RpcTransport:spawn pi 二进制（`--mode rpc`）,stdin/stdout/stderr 全 pipe。
 * env 由调用方（pi-session.ts）经 spawnEnvFor 计算后传入（含 CORTEX_PI_KEY 注入）。
 * - stderr:留末尾 2KB tail 供崩溃诊断,持续消费避免管道胀满阻塞。
 * - stdin:绑 error 监听 + 写前可写性守卫,避免对已死管道写入冒泡成主进程未捕获异常。
 */
export function spawnPiRpc(args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): RpcTransport {
  const child = spawn(resolvePiBinary(), args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  // 子进程已死后写 stdin 会异步 emit 'error'(EPIPE),无监听则成主进程 uncaughtException → 吞掉。
  child.stdin?.on("error", () => {});
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  return {
    write: (line) => {
      if (child.stdin && child.stdin.writable) child.stdin.write(line);
    },
    onStdout: (cb) => {
      child.stdout?.on("data", (chunk: string) => cb(chunk));
    },
    onExit: (cb) => {
      child.on("close", (code) => cb(code, stderrTail.trim() || undefined));
    },
    onError: (cb) => {
      child.on("error", cb);
    },
    kill: () => killWithTimeout(() => child.kill("SIGTERM"), child.pid),
  };
}

// RPC 命令的应答行（{type:"response", id, command, success, data|error}）。
export interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// 压缩走一次 LLM 调用,应答在 session.compact() 完成后才回,给较长有界超时（非 0,留兜底）。
const COMPACT_TIMEOUT_MS = 5 * 60_000;

/**
 * 一个长驻 pi RPC 会话:把命令写到子进程 stdin、解析 stdout 的 response/事件行。
 * 协议复刻官方 RpcClient,但传输可注入（便于测试）、就绪判定改为 get_state 探测。
 * 命令均通过 id 关联应答;事件经 mapPiEvent 归一化后回调 onEvent。
 */
export class PiRpcSession {
  private buf = "";
  private readonly pending = new Map<string, PendingRequest>();
  private reqId = 0;
  private exited = false;
  private stopped = false;
  // 阶段4 代际:当前轮的 runId（Cortex 自造,prompt 时绑定）。事件回带它,renderer 据此守卫
  // 丢弃迟到/串台事件（崩溃重开/editResend 重入时旧轮事件落入新轮）。
  private currentRunId?: string;

  constructor(
    private readonly transport: RpcTransport,
    private readonly onEvent: (ev: PiSessionEvent, runId?: string) => void,
    // extension 经 ctx.ui.* 发起的 UI 请求（独立于事件流;阶段3 用于工具确认弹窗）。
    private readonly onUiRequest?: (req: PiUiRequest) => void,
  ) {
    transport.onStdout((chunk) => this.feed(chunk));
    transport.onExit((code, stderrTail) => this.handleExit(code, stderrTail));
    transport.onError((err) => this.handleError(err));
  }

  // LF-only 行缓冲（payload 可能含 U+2028/U+2029,只能按 \n 切）。
  private feed(chunk: string): void {
    // 停止/退出后到来的残余 stdout 一律丢弃:否则重开同 uiSessionId 会把旧进程事件串到新会话。
    if (this.stopped || this.exited) return;
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    // 命中 pending 的 response → resolve 对应请求。
    if (obj?.type === "response" && typeof obj.id === "string" && this.pending.has(obj.id)) {
      const p = this.pending.get(obj.id)!;
      this.pending.delete(obj.id);
      clearTimeout(p.timer);
      p.resolve(obj as unknown as RpcResponse);
      return;
    }
    // extension UI 请求（pi → host，需 host 回写）：在 mapPiEvent 前专门分流——mapPiEvent 丢 id
    // 且 default→null 会吞掉。只对带 id 的请求上抛。
    if (obj?.type === "extension_ui_request" && typeof obj.id === "string") {
      this.onUiRequest?.(obj as unknown as PiUiRequest);
      return;
    }
    const ev = mapPiEvent(obj);
    if (ev) this.onEvent(ev, this.currentRunId);
  }

  /**
   * 回写 extension UI 应答到 pi stdin。**绕过 send/pending**:用 pi 给的原始 id（非自增 req_N）,
   * 且 pi 对回写不发 response（fire-and-forget），故直写、不登记 pending、不等应答。
   * stopped/exited 后静默丢弃（与 feed 一致;且写已死管道由 spawnPiRpc 的可写性守卫兜底）。
   */
  respondUi(id: string, payload: PiUiResponsePayload): void {
    if (this.stopped || this.exited) return;
    this.transport.write(JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n");
  }

  /** 发一条命令,等带相同 id 的 response。超时或进程已退出则 reject。 */
  send(command: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RpcResponse> {
    if (this.exited) return Promise.reject(new Error("pi 会话已退出"));
    const id = `req_${++this.reqId}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi 命令超时: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.write(JSON.stringify({ ...command, id }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * 就绪探测:轮询 get_state 直到拿到 sessionId（冷启动 ~790ms,故不用固定 sleep）。
   * 顺带返回 sessionFile（磁盘 JSONL 路径,阶段4 崩溃/空闲恢复用;in-memory 会话可能无）。
   */
  async ready(opts: { tries?: number; intervalMs?: number } = {}): Promise<{ sessionId: string; sessionFile?: string }> {
    const tries = opts.tries ?? 60;
    const intervalMs = opts.intervalMs ?? 250;
    for (let i = 0; i < tries; i++) {
      if (this.exited) throw new Error("pi 进程在就绪前退出");
      try {
        const resp = await this.send({ type: "get_state" }, intervalMs);
        const data = resp.success ? (resp.data as { sessionId?: string; sessionFile?: string } | undefined) : undefined;
        if (data?.sessionId) return { sessionId: data.sessionId, sessionFile: data.sessionFile };
        // 已应答但暂无 sessionId:小睡一轮再试,避免无间隔忙轮询烧光 tries。
        await new Promise((r) => setTimeout(r, intervalMs));
      } catch {
        // get_state 超时（≈intervalMs）= 进程未就绪,直接重试（超时本身已构成间隔）。
      }
    }
    throw new Error("pi 会话就绪超时");
  }

  // ── 命令封装（均返回应答 Promise）─────────────────────────────────────
  // 注:prompt 的 response 是 preflight 受理后的即时 ack（毫秒级，非任务完成）;一轮 run 的
  // 结束由 agent_end 事件（映射为 {type:"result"}）经事件流单独表达。故 prompt 用默认短超时
  // 即可（与官方 RpcClient 一致），只覆盖「受理」这一步。compact 的 response 才是 await 压缩完成。
  // runId（Cortex 自造）在写 stdin prompt 时同步绑定,确保首条 agent_start 事件已带新 runId
  // （pi 不参与;steer/abort 不换 runId,其事件仍归属当前轮）。
  prompt(message: string, runId?: string): Promise<RpcResponse> {
    if (runId !== undefined) this.currentRunId = runId;
    return this.send({ type: "prompt", message });
  }
  steer(message: string): Promise<RpcResponse> {
    return this.send({ type: "steer", message });
  }
  followUp(message: string): Promise<RpcResponse> {
    return this.send({ type: "follow_up", message });
  }
  abort(): Promise<RpcResponse> {
    return this.send({ type: "abort" });
  }
  fork(entryId: string): Promise<RpcResponse> {
    return this.send({ type: "fork", entryId });
  }
  getForkMessages(): Promise<RpcResponse> {
    return this.send({ type: "get_fork_messages" });
  }
  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.send({ type: "set_model", provider, modelId });
  }
  setThinkingLevel(level: string): Promise<RpcResponse> {
    return this.send({ type: "set_thinking_level", level });
  }
  compact(customInstructions?: string): Promise<RpcResponse> {
    return this.send({ type: "compact", customInstructions }, COMPACT_TIMEOUT_MS);
  }
  getState(): Promise<RpcResponse> {
    return this.send({ type: "get_state" });
  }
  getSessionStats(): Promise<RpcResponse> {
    return this.send({ type: "get_session_stats" });
  }
  newSession(parentSession?: string): Promise<RpcResponse> {
    return this.send({ type: "new_session", parentSession });
  }
  // 阶段4 崩溃/空闲/LRU/重启恢复:从 JSONL 重建上下文。大会话 loadEntriesFromFile+buildSessionContext
  // 可能逼近默认 30s,给独立长超时（参 compact）。坏文件 pi 静默起空会话仍回 success。
  switchSession(sessionPath: string): Promise<RpcResponse> {
    return this.send({ type: "switch_session", sessionPath }, COMPACT_TIMEOUT_MS);
  }
  getLastAssistantText(): Promise<RpcResponse> {
    return this.send({ type: "get_last_assistant_text" });
  }

  /** 主动停止:不再上报 crashed。 */
  stop(): void {
    this.stopped = true;
    this.exited = true;
    this.rejectAllPending(new Error("pi 会话已停止退出"));
    this.transport.kill();
  }

  // close 与 error 可能先后到达（spawn 失败时尤甚）:用 exited 去重,确保终止只处理一次
  // （rejectAllPending 与 crashed 各最多一次,不依赖下游摘除注册表的时序）。
  private handleExit(code: number | null, stderrTail?: string): void {
    if (this.exited) return;
    this.exited = true;
    this.rejectAllPending(new Error(`pi 进程退出 (code=${code})`));
    if (!this.stopped) {
      const detail =
        code === 0 || code === null ? undefined : stderrTail ? `退出码 ${code}: ${stderrTail}` : `退出码 ${code}`;
      this.onEvent({ type: "crashed", error: detail });
    }
  }

  private handleError(err: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.rejectAllPending(err);
    if (!this.stopped) this.onEvent({ type: "crashed", error: err.message });
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
