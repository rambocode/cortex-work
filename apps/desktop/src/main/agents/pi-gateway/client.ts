// pi gateway 的主进程客户端（U3）：`PiSessionEngine` 的**第三个实现**。
//
// ── 为什么这一层可以「零改动接线」──────────────────────────────────────────────────
// `ipc/pi-session.ts` 与 `ipc/orchestrate.ts` 只依赖 `PiSessionEngine` 契约（见 pi-inproc/session.ts
// 的说明），前两个实现是 `PiRpcSession`（bun 二进制 + spawn）与 `PiInProcSession`（主进程内联）。
// 本类把每个方法调用转成一条 `HostCall` RPC 发给 pi-host worker，事件从 `WorkerEvent` 转回
// `onEvent`——因此选路代码只多一个构造分支，命令转发 / 事件回推 / 清理路径**一行都不用改**。
//
// ── 三条反向调用（worker → 主进程）─────────────────────────────────────────────────
//   · `uiRequest`         → 转给调用方给的 `onUiRequest`（最终到 `emitUiRequest` → 渲染端），
//                           用户回写经 `respondUi()` → `HostUiResponse` 送回 worker；
//   · `credentialRequest` → **主进程用 safeStorage 解密**后回 `HostCredentialResponse`（KTD1：
//                           密钥只在请求那一刻跨进程存在一次，不在 worker 常驻、不落盘）；
//   · `log`              → 转到主进程 logger（worker 的 stdout 不连终端，日志只能经这里落盘）。
//
// ── 异常边界 ───────────────────────────────────────────────────────────────────────
// 进程隔离回来了，所以 in-process 那四道闸里「怕把主进程炸了」的部分不再需要；但**跨进程带来
// 三类新的静默卡死**，这里逐条兜住：
//   1. worker 不回消息 → 每条 RPC 都有有界超时（否则渲染端 invoke 永久挂起）；
//   2. worker 死了但还有在途 RPC → 退出时统一 reject（否则调用方永远等不到应答）；
//   3. worker 发来 uiRequest 但本会话没有 UI 出口 → 立刻回 `cancelled`（否则 worker 侧的
//      `ctx.ui.confirm` 永久挂着，把 pi 的工具执行栈一起卡死）。

import {
  decodeLine,
  encodeLine,
  ENGINE_METHODS,
  type EngineMethod,
  type HostMessage,
  type WorkerCredentialRequest,
  type WorkerMessage,
  type WorkerReply,
  type WorkerUiRequest,
} from "./protocol";
import type { PiGatewayForkOptions, PiGatewayTransport, PiGatewayTransportFactory } from "./transport";
import { recordAgentTrace } from "../../ipc/agent-trace";
import { createLogger } from "../../log";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "../../ipc/types";
import type { PiSessionEngine } from "../pi-inproc/session";
import type { PiImageContent, RpcResponse } from "../pi-rpc";

const log = createLogger("pi-gateway");

/** 普通命令的超时。与 `PiRpcSession` 的 `DEFAULT_TIMEOUT_MS` 同值同义。 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * 长命令超时。`compact` 走一次 LLM 调用；`fork` / `newSession` / `switchSession` 要重建整个
 * AgentSession（重跑 provider 解析、扩展加载、MCP 连接）。给较长有界超时——**不设无限**，
 * 无限等待就是渲染端「永久卡住且无终态」的成因。与 `PiRpcSession.COMPACT_TIMEOUT_MS` 同值。
 */
const LONG_CALL_TIMEOUT_MS = 5 * 60_000;
const LONG_CALL_METHODS = new Set<EngineMethod>(["compact", "fork", "newSession", "switchSession"]);

/**
 * 建会话超时。worker 冷启动（进程 fork + 纯 ESM 三包动态 import）+ `createAgentSession`
 * （provider 解析、扩展加载、MCP server 连接）都在这一条 RPC 里，故显著长于普通命令。
 */
const OPEN_TIMEOUT_MS = 120_000;

/** 两段式 kill 的宽限期：发完 shutdown 后这么久还没退出就强杀。与 pi-rpc.ts 的 3s 同值。 */
const DEFAULT_KILL_DELAY_MS = 3_000;

/**
 * 凭据金库访问器。key 的命名空间与 op 的语义见 `accessGatewayCredential`。
 *
 * 入参刻意是整条 `WorkerCredentialRequest`（而不是把 key/op/value 拆成三个位置参数）：
 * 协议将来再加字段时，注入点的签名不用跟着动，单测替身也不必逐个补参数。
 */
export type PiGatewayCredentialReader = (request: WorkerCredentialRequest) => Promise<string | null>;

/** 会话构造的可注入依赖。生产路径全部走默认值，单测逐个替换。 */
export interface PiGatewayDeps {
  /** 进程承载工厂。缺省 `forkPiHostTransport`（懒加载，避免单测被迫装 electron 替身）。 */
  createTransport?: PiGatewayTransportFactory;
  /** 凭据金库访问（KTD1）。缺省 `accessGatewayCredential`（safeStorage 金库）。 */
  readCredential?: PiGatewayCredentialReader;
  /** 传给 worker 的追加环境变量（自定义 Provider 密钥占位、Computer Use grounding 等）。 */
  env?: Record<string, string>;
  /** 两段式 kill 的宽限期，缺省 3s。 */
  killDelayMs?: number;
  /**
   * 会话停止时要一并释放的**外部**资源（与 `PiInProcDeps.onDispose` 同义同位）。
   * 放在引擎内部而不是让调用方包装 `stop()`：停会话的路径有五六处，逐处补调必漏一处。
   */
  onDispose?: () => Promise<void> | void;
}

export interface PiGatewayOpenOptions {
  /** 已经过 `preparePiOpenRequest` 的请求。原样透传给 worker（含 bridgeServers 等内部字段）。 */
  request: PiOpenRequest;
  /** 归一化事件出口（`pi-session.ts` 转成 `pi:event`）。 */
  onEvent: (ev: PiSessionEvent, runId?: string) => void;
  /** 需用户回写的 UI 请求出口（`pi-session.ts` 转成 `pi:uiRequest`）。缺省 = 本会话无 UI 出口。 */
  onUiRequest?: (req: PiUiRequest) => void;
  deps?: PiGatewayDeps;
}

interface PendingCall {
  /** 用于超时/退出时的可读诊断（是哪条命令没回来）。 */
  label: string;
  resolve: (reply: WorkerReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把 worker 回来的 `result` 归一成 `RpcResponse`。
 *
 * worker 侧持有的也是一个 `PiSessionEngine`，所以正常情况下 `result` **本身就是** RpcResponse，
 * 原样返回即可。这里额外容忍「worker 只回了裸 data」的形态并帮它裹一层：协议两端各自演进时，
 * 这条容错让形状不一致表现为「多包了一层但功能正常」，而不是渲染端读不到 `data` 的静默失效。
 */
function normalizeResponse(command: string, result: unknown): RpcResponse {
  if (
    result !== null &&
    typeof result === "object" &&
    (result as { type?: unknown }).type === "response" &&
    typeof (result as { success?: unknown }).success === "boolean"
  ) {
    return result as RpcResponse;
  }
  return result === undefined
    ? { type: "response", command, success: true }
    : { type: "response", command, success: true, data: result };
}

/**
 * 裁掉尾部的 undefined 参数。
 *
 * 为什么必须裁：`JSON.stringify([a, undefined, undefined])` 产出 `[a,null,null]`，worker 侧
 * `runId !== undefined` 这类判定会因此走错分支（`prompt(msg)` 会变成「显式传了 runId=null」）。
 * 裁掉尾部即可让最常见的可选参调用完全干净；**夹在中间**的 undefined 仍会变成 null，
 * 故 worker 侧对可选参必须按「null 等同未传」处理（跨进程契约，两侧都要守）。
 */
function trimArgs(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

// ── 默认凭据解析（KTD1）──────────────────────────────────────────────────────────────

/** 凭据清单的伪 key。`op` 缺省 read 时也按 list 处理，两种写法都认。 */
const CREDENTIAL_LIST_KEY = "credentials:list";
const SECRET_PREFIX = "secret:";
const PROVIDER_PREFIX = "provider:";

/** 从 key 里剥出 providerId。裸 id 与 `provider:` 前缀同义。 */
function providerIdOf(key: string): string {
  return key.startsWith(PROVIDER_PREFIX) ? key.slice(PROVIDER_PREFIX.length) : key;
}

/**
 * 默认凭据金库访问器：worker 要用密钥的那一刻才回主进程取，主进程用 safeStorage 解密后返回。
 *
 * **key 的命名空间约定**（协议只给了「一个 string key」，语义在这里定死）：
 *   · `secret:<NAME>`          → 命名 Secret 的明文（自定义 Provider 的 `${secret:NAME}` 引用）；
 *   · `credentials:list`       → 凭据元信息清单 `JSON.stringify([{providerId,type}])`（**不含密钥**）；
 *   · `provider:<id>` / `<id>` → 该 Provider 的凭据，`JSON.stringify` 后的 pi `Credential`
 *                                （`{type:"api_key",key,env?}` 或 oauth），worker 侧 `JSON.parse` 还原。
 * 未配置一律返回 `null`——**不是空串**，空串是合法的凭据值（协议注释里那条约束）。
 *
 * ── 写路径的收窄（安全边界，务必保留）────────────────────────────────────────────
 * `write` / `delete` **只接受 provider 命名空间**。命名 Secret 是用户在设置页手工维护的资产，
 * pi 没有任何理由改写它们；放开的话一个跑飞的扩展就能把用户的 Secret 抹掉，而这类破坏
 * 没有撤销路径。落到 secret/list 命名空间的写请求一律拒绝并留痕。
 *
 * 权限面对照：本访问器给 worker 的能力**不宽于 in-process 路径**——那条路直接把
 * `createSafeStorageCredentialStore()`（含 modify/delete）交给了 pi。gateway 只是把同一组能力
 * 收窄成四个具名 op 经协议过一次桥，多了一层可审计的收口。
 *
 * ⚠️ 返回值可能是明文密钥：**任何分支都不得把它写进日志**（只记 key 与 op）。
 * 金库模块用懒加载 import 拉进来，让本文件的单测不必替身整条 safeStorage 链路。
 */
export async function accessGatewayCredential(request: WorkerCredentialRequest): Promise<string | null> {
  const vault = await import("../../providers/credentials");
  const { key, op = "read" } = request;

  if (op === "list" || key === CREDENTIAL_LIST_KEY) {
    // 只回元信息（providerId + type），不解密任何密文——这条是 pi `CredentialStore.list()` 的契约。
    const metas = await vault.listStoredCredentialMetas();
    return JSON.stringify(metas.map(({ providerId, type }) => ({ providerId, type })));
  }

  if (op === "write" || op === "delete") {
    if (key.startsWith(SECRET_PREFIX)) {
      throw new Error(`拒绝写入命名 Secret（pi 只允许改写 provider 凭据）: ${key}`);
    }
    const providerId = providerIdOf(key);
    if (op === "delete") {
      await vault.deleteStoredCredential(providerId);
      return null;
    }
    if (request.value === undefined) throw new Error(`凭据写入缺少 value: ${key}`);
    // 解析放在写之前：坏 JSON 必须在碰金库之前失败，绝不把半个对象落盘。
    const next = JSON.parse(request.value) as Awaited<ReturnType<typeof vault.readStoredCredential>>;
    if (!next || typeof next !== "object") throw new Error(`凭据写入的 value 不是对象: ${key}`);
    // 走 modifyStoredCredential 而不是自己读写：它持有金库的串行锁，pi 的 OAuth 刷新与设置页
    // 的写入必须共用同一把锁，否则并发刷新会互相覆盖、其中一份 refresh token 被服务端作废。
    const written = await vault.modifyStoredCredential(providerId, async () => next);
    return written ? JSON.stringify(written) : null;
  }

  if (key.startsWith(SECRET_PREFIX)) {
    const name = key.slice(SECRET_PREFIX.length);
    const secrets = await vault.readSecrets();
    return Object.prototype.hasOwnProperty.call(secrets, name) ? (secrets[name] ?? null) : null;
  }
  const credential = await vault.readStoredCredential(providerIdOf(key));
  return credential ? JSON.stringify(credential) : null;
}

/**
 * 建会话请求的脱敏：摘掉 `provider.apiKey`（KTD1）。
 *
 * `preparePiOpenRequest` 会把解析出来的 Provider 连同**明文 apiKey** 填进请求（见 ipc/types.ts
 * 对该字段的告警）。binary / in-process 两条路都在同进程内消费它，所以直接带着走；但 gateway
 * 下这条请求要跨进程，带上密钥就等于把「密钥只在请求那一刻跨进程存在一次」这条 KTD1 作废——
 * 而它本来就不需要：worker 侧只用 `id` 与 `baseUrl` 登记 baseUrl 覆盖，真要用密钥时会发
 * `credentialRequest` 回主进程取。
 *
 * 浅拷贝到新对象而不是 `delete` 原对象的字段：入参是调用方（`pi:open` handler）还在用的
 * `prepared`，就地改会波及 binary/in-process 分支与后续的 trace 记录。
 */
function sanitizeOpenRequest(request: PiOpenRequest): PiOpenRequest {
  if (!request.provider?.apiKey) return request;
  const { apiKey: _apiKey, ...provider } = request.provider;
  return { ...request, provider: provider as PiOpenRequest["provider"] };
}

// ── 会话实现 ─────────────────────────────────────────────────────────────────────────

/**
 * 一个 gateway pi 会话。生命周期与旧 binary 路径的一个 pi 子进程等价：
 * `openPiGatewaySession()` 建、`stop()` 销，中途经方法调用下发 RPC、经 `onEvent` 上报事件。
 *
 * **每会话一个 worker**（首版决策，见计划 Deferred）：隔离最彻底，且与 binary 路径的进程开销同量级。
 */
export class PiGatewaySession implements PiSessionEngine {
  private seq = 0;
  private readonly pending = new Map<string, PendingCall>();
  /**
   * pi 侧 UI 请求 id（`PiUiRequest.id`）→ 协议侧 `WorkerUiRequest.requestId`。
   *
   * 两者**不是同一个 id**：前者是 pi 自己 `crypto.randomUUID()` 出来、渲染端回写时原样带回的；
   * 后者是 worker 为这次反向调用分配的关联键。渲染端只知道前者，所以主进程必须留这张映射表，
   * 否则用户点了「允许」之后应答会带着错的 requestId 回去，worker 那边永远等不到、工具栈卡死。
   */
  private readonly uiRequestIds = new Map<string, string>();
  /** 主动停止标志：主动停的退出**不算崩溃**，不能上报 crashed。 */
  private stopped = false;
  /** 退出去重标志：exit 与 error 可能先后到达，收尾只能跑一次。 */
  private exited = false;
  private exitError?: Error;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transport: PiGatewayTransport,
    private readonly options: {
      onEvent: (ev: PiSessionEvent, runId?: string) => void;
      onUiRequest?: (req: PiUiRequest) => void;
      readCredential: PiGatewayCredentialReader;
      uiSessionId: string;
      killDelayMs?: number;
      onDispose?: () => Promise<void> | void;
    },
  ) {
    transport.onLine((line) => this.handleLine(line));
    transport.onExit((code, stderrTail) => this.handleExit(code, stderrTail));
    transport.onError((err) => this.handleError(err));
  }

  /** 在途 RPC 数（诊断/单测用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ── 出站 ──────────────────────────────────────────────────────────────────────────

  private nextId(): string {
    this.seq += 1;
    return `pg_${this.seq}`;
  }

  /** 写一条不需要应答的消息（uiResponse / credentialResponse / shutdown）。管道已断时静默忽略。 */
  private write(msg: HostMessage): void {
    try {
      this.transport.writeLine(encodeLine(msg));
    } catch (err) {
      // 会话停止 / worker 已退出后的残余写入是正常竞态，不该冒泡成命令失败。
      log.debug("pi gateway 写入失败（通道已断）", { kind: msg.kind, error: errText(err) });
    }
  }

  /** 发一条需要应答的消息并等 `WorkerReply`。超时或 worker 已退出则 reject。 */
  private send(msg: HostMessage & { id: string }, timeoutMs: number, label: string): Promise<WorkerReply> {
    if (this.exited || this.stopped) {
      return Promise.reject(this.exitError ?? new Error("pi 会话已停止退出"));
    }
    return new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        // 命令级超时没有终态事件，最容易表现为渲染端静默卡死——必须留痕。
        log.warn("pi gateway 命令超时", { command: label, timeoutMs });
        reject(new Error(`pi 命令超时: ${label}`));
      }, timeoutMs);
      this.pending.set(msg.id, { label, resolve, reject, timer });
      try {
        this.transport.writeLine(encodeLine(msg));
      } catch (err) {
        this.pending.delete(msg.id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 转发一次引擎方法调用，返回 worker 的 `result`；worker 侧 dispatch 失败则抛。 */
  private async invoke(method: EngineMethod, args: unknown[]): Promise<unknown> {
    const timeoutMs = LONG_CALL_METHODS.has(method) ? LONG_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS;
    const reply = await this.send(
      { id: this.nextId(), kind: "call", method, args: trimArgs(args) },
      timeoutMs,
      method,
    );
    // `ok:false` = worker 侧**转发层**失败（未知方法 / 会话未建 / dispatch 抛错），不是命令级失败。
    // 命令级失败由 worker 的 PiSessionEngine 包在 `RpcResponse{success:false}` 里随 ok:true 回来。
    if (!reply.ok) throw new Error(reply.error ?? `pi 命令失败: ${method}`);
    return reply.result;
  }

  /**
   * 命令转发的统一收口：`RpcResponse` 语义与前两个实现逐字一致。
   *
   * 传输级失败（超时 / worker 已退出）**保持 reject**——与 binary 路径 `PiRpcSession.send()`
   * 同义；`pi-session.ts` 的 `command()` 会把它直接转成 IPC rejection。
   */
  private command(method: EngineMethod, args: unknown[]): Promise<RpcResponse> {
    return this.invoke(method, args).then((result) => normalizeResponse(method, result));
  }

  // ── 入站 ──────────────────────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    // 停止/退出后到来的残余消息一律丢弃：否则重开同 uiSessionId 会把旧 worker 的事件串到新会话。
    if (this.stopped || this.exited) return;
    const msg = decodeLine<WorkerMessage>(line);
    if (!msg) {
      // 一行坏数据绝不中断通道（协议 decodeLine 的契约），只留痕。
      log.warn("pi gateway 丢弃不可解析的 worker 消息", { length: line.length });
      return;
    }
    switch (msg.kind) {
      case "reply": {
        const entry = this.pending.get(msg.id);
        // 未知 id：已超时被清掉的迟到应答。忽略，避免串台。
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
        return;
      }
      case "event":
        this.emitEvent(msg.event, msg.runId);
        return;
      case "uiRequest":
        this.handleUiRequest(msg);
        return;
      case "credentialRequest":
        void this.handleCredentialRequest(msg);
        return;
      case "log":
        // worker 的日志经主进程 logger 落盘（它自己的 stdout 不连终端也不进日志文件）。
        log[msg.level]?.(`[pi-host] ${msg.message}`);
        return;
      default:
        log.warn("pi gateway 收到未知消息类型", { kind: (msg as { kind?: unknown }).kind });
    }
  }

  /**
   * 事件出口。**必须永不抛**：这里抛出去就会打断 transport 的 message 回调，
   * 后续所有事件与应答一起消失（表现为会话「活着但不再有任何反应」）。
   */
  private emitEvent(ev: PiSessionEvent, runId?: string): void {
    try {
      this.options.onEvent(ev, runId);
    } catch (err) {
      log.warn("pi gateway 事件回调抛错（已吞，会话继续）", { type: ev.type, error: errText(err) });
    }
  }

  /** 反向调用：UI 交互（审批 / askquestion）转给渲染端。 */
  private handleUiRequest(msg: WorkerUiRequest): void {
    const sink = this.options.onUiRequest;
    if (!sink) {
      // 无 UI 出口却收到 uiRequest：立刻回 cancelled。不回的话 worker 侧 `ctx.ui.*` 的 Promise
      // 永久挂起，把它所在的 pi 工具执行栈一起冻住（跨进程后没人能替它兜底，只能主进程显式应答）。
      this.write({ id: this.nextId(), kind: "uiResponse", requestId: msg.requestId, payload: { cancelled: true } });
      return;
    }
    this.uiRequestIds.set(msg.request.id, msg.requestId);
    try {
      sink(msg.request);
    } catch (err) {
      // 转发失败（渲染端已销毁等）同样必须回一条，否则 worker 永久等待。
      log.warn("pi gateway UI 请求转发失败", { method: msg.request.method, error: errText(err) });
      this.uiRequestIds.delete(msg.request.id);
      this.write({ id: this.nextId(), kind: "uiResponse", requestId: msg.requestId, payload: { cancelled: true } });
    }
  }

  /**
   * 反向调用：取一条凭据（KTD1）。
   *
   * 时序：worker 侧 `CredentialStore.read()` → 本条消息 → 主进程 safeStorage 解密 →
   * `HostCredentialResponse` → worker 侧 Promise 落定。密钥因此**只在这一次往返里跨进程存在**，
   * 不在 worker 常驻、不落盘——严格优于 binary 路径（密钥烘焙进 .js 文件 + spawn env）。
   *
   * 解密失败不抛给 worker 之外的任何人：回一条 `value:null` + error，让 pi 走「未配置」路径
   * 并给出可读原因，而不是让整条会话在一个金库故障上崩掉。**任何分支都不记录 value。**
   */
  private async handleCredentialRequest(msg: WorkerCredentialRequest): Promise<void> {
    let value: string | null = null;
    let error: string | undefined;
    try {
      value = await this.options.readCredential(msg);
    } catch (err) {
      error = errText(err);
      value = null;
      // 只记 key 与 op，绝不记 value（它可能是明文密钥）。
      log.warn("pi gateway 凭据访问失败", { key: msg.key, op: msg.op ?? "read", error });
    }
    // 解密是异步的，期间会话可能已经停了；write() 内部对断管道是静默的。
    this.write({
      id: this.nextId(),
      kind: "credentialResponse",
      requestId: msg.requestId,
      value,
      ...(error ? { error } : {}),
    });
  }

  // ── 退出 ──────────────────────────────────────────────────────────────────────────

  /**
   * worker 进程退出的统一收口（R5）。非主动停止的退出 = 崩溃 → 上报 `crashed`，
   * `pi-session.ts` 的 `emitEvent` 见到 `crashed` 会摘除注册表条目——与 binary 路径逐字同义。
   *
   * ⚠️ **code=0 也可能是崩溃**：worker 的 ESM 加载失败、入口指向 asar 内路径这两类失败都表现为
   * 「code=0、无任何输出」（KTD2/KTD3）。故判据是「没主动停 → 崩溃」，而不是「退出码非 0 → 崩溃」；
   * stderr 尾环只要非空就一定拼进 error，它是这两类失败唯一的线索。
   */
  private handleExit(code: number | null, stderrTail?: string): void {
    if (this.exited) return;
    this.exited = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    const codeText = code === null ? "null" : String(code);
    const tail = stderrTail?.trim();
    const detail = tail
      ? `退出码 ${codeText}: ${tail}`
      : code === 0 || code === null
        ? undefined
        : `退出码 ${codeText}`;
    this.exitError = new Error(detail ?? `pi-host worker 退出（code=${codeText}）`);
    // 在途 RPC 必须在上报之前了结：上层收到 crashed 后可能立刻重开会话，届时旧 pending 还挂着就是泄漏。
    this.rejectAllPending(this.exitError);
    if (this.stopped) return;
    log.warn("pi-host worker 崩溃退出", { code, detail });
    this.options.onEvent({ type: "crashed", ...(detail ? { error: detail } : {}) });
  }

  /** 承载层错误（当前 utilityProcess 不会触发；保留以对将来的 child_process 实现通用）。 */
  private handleError(err: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitError = err;
    this.rejectAllPending(err);
    if (this.stopped) return;
    log.warn("pi-host worker 错误退出", { error: err.message });
    this.options.onEvent({ type: "crashed", error: err.message });
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  // ── PiSessionEngine ───────────────────────────────────────────────────────────────

  /** 建会话。由 `openPiGatewaySession` 调用一次，失败即视为会话不可用。 */
  async open(request: PiOpenRequest, hasUiOutlet: boolean): Promise<void> {
    const reply = await this.send(
      { id: this.nextId(), kind: "open", request: sanitizeOpenRequest(request), hasUiOutlet },
      OPEN_TIMEOUT_MS,
      "open",
    );
    if (!reply.ok) throw new Error(reply.error ?? "pi gateway 会话建立失败");
  }

  /**
   * 就绪探测。worker 侧的实现（`PiInProcSession.ready()`）在会话建好时就是同步事实，
   * 故这里只是一次普通 RPC；参数保留只为与另两个实现同签名，选路层不写分支。
   */
  async ready(opts?: { tries?: number; intervalMs?: number }): Promise<{ sessionId: string; sessionFile?: string }> {
    const result = await this.invoke("ready", [opts]);
    const data = result as { sessionId?: unknown; sessionFile?: unknown } | undefined;
    if (!data || typeof data.sessionId !== "string" || !data.sessionId) {
      throw new Error("pi 会话就绪失败：缺少 sessionId");
    }
    return typeof data.sessionFile === "string"
      ? { sessionId: data.sessionId, sessionFile: data.sessionFile }
      : { sessionId: data.sessionId };
  }

  /**
   * 拉取并缓存斜杠命令表（缓存在 **worker 侧**，用于扩展命令补发收尾的精确判定）。
   * 失败静默降级：它只影响补发判定精度，绝不因这一步失败阻断会话可用性（与另两个实现一致）。
   */
  async loadSlashCommands(): Promise<void> {
    try {
      await this.invoke("loadSlashCommands", []);
    } catch (err) {
      log.debug("pi gateway 斜杠命令表拉取失败（退回宽限窗兜底）", { error: errText(err) });
    }
  }

  prompt(message: string, runId?: string, images?: PiImageContent[]): Promise<RpcResponse> {
    return this.command("prompt", [message, runId, images]);
  }

  steer(message: string): Promise<RpcResponse> {
    return this.command("steer", [message]);
  }

  followUp(message: string): Promise<RpcResponse> {
    return this.command("followUp", [message]);
  }

  abort(): Promise<RpcResponse> {
    return this.command("abort", []);
  }

  fork(entryId: string): Promise<RpcResponse> {
    return this.command("fork", [entryId]);
  }

  getForkMessages(): Promise<RpcResponse> {
    return this.command("getForkMessages", []);
  }

  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.command("setModel", [provider, modelId]);
  }

  setThinkingLevel(level: string): Promise<RpcResponse> {
    return this.command("setThinkingLevel", [level]);
  }

  compact(customInstructions?: string): Promise<RpcResponse> {
    return this.command("compact", [customInstructions]);
  }

  getState(): Promise<RpcResponse> {
    return this.command("getState", []);
  }

  getSessionStats(): Promise<RpcResponse> {
    return this.command("getSessionStats", []);
  }

  newSession(parentSession?: string): Promise<RpcResponse> {
    return this.command("newSession", [parentSession]);
  }

  switchSession(sessionPath: string): Promise<RpcResponse> {
    return this.command("switchSession", [sessionPath]);
  }

  getLastAssistantText(): Promise<RpcResponse> {
    return this.command("getLastAssistantText", []);
  }

  getCommands(): Promise<RpcResponse> {
    return this.command("getCommands", []);
  }

  /** 渲染端的对话框应答回填。停止后静默丢弃（与另两个实现的 stopped 守卫同义）。 */
  respondUi(id: string, payload: PiUiResponsePayload): void {
    if (this.stopped || this.exited) return;
    // 找不到映射时退回用原 id 当 requestId：worker 侧若采用「requestId === pi 的 id」的实现，
    // 这条兜底让它照样能对上；即便对不上，最坏也只是 worker 忽略一条应答，不会串到别的请求。
    const requestId = this.uiRequestIds.get(id) ?? id;
    this.uiRequestIds.delete(id);
    this.write({ id: this.nextId(), kind: "uiResponse", requestId, payload });
  }

  /**
   * 主动停止：两段式 kill + 资源释放。幂等。
   *
   * 第一段先发 `shutdown`（而不是直接 SIGTERM）：worker 需要跑扩展的 `session_shutdown` 钩子、
   * 关掉 MCP stdio 子进程。`utilityProcess.kill()` 没有信号参数，所以「先礼」只能靠协议本身。
   * 紧接着调一次优雅 kill，再挂一个宽限定时器兜底强杀——worker 卡在某个 await 上不响应 shutdown
   * 时，只有这一段能保证进程真的没了（孤儿 worker 会继续持有模型连接与 MCP 子进程）。
   *
   * 定时器 `unref()`：它不该拖住 Electron 的退出流程。
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.uiRequestIds.clear();
    this.write({ id: this.nextId(), kind: "shutdown" });
    this.rejectAllPending(new Error("pi 会话已停止退出"));
    this.transport.kill();
    if (!this.exited) {
      this.killTimer = setTimeout(() => {
        this.killTimer = undefined;
        this.transport.kill(true);
      }, this.options.killDelayMs ?? DEFAULT_KILL_DELAY_MS);
      this.killTimer.unref?.();
    }
    // 外部资源释放（当前是主进程侧的 MCP 桥等）。失败只记日志：释放失败不该阻断「会话已停止」这个事实。
    void Promise.resolve(this.options.onDispose?.()).catch((err) =>
      log.warn("pi gateway 会话外部资源释放失败", { error: errText(err) }),
    );
    // scope 沿用 "pi"（AgentTraceEvent 是封闭联合，不为本次迁移扩张 IPC 契约）；
    // 是哪条引擎路径由 summary 区分。
    recordAgentTrace({
      scope: "pi",
      phase: "exit",
      summary: "pi gateway 会话停止",
      sessionId: this.options.uiSessionId,
      agent: "pi",
    });
  }
}

/**
 * 编译期对账：`PiGatewaySession` 必须实现 `PiSessionEngine` 的**每一个**转发方法。
 *
 * `implements` 子句已经保证「不多不少」，这条断言补的是另一半——`ENGINE_METHODS`（协议侧的
 * 方法名清单）里的每一项都得在本类上真实存在。漏一个的表现是「某个命令静默失效」而不是报错。
 */
type _AssertClassCoversProtocol = Exclude<(typeof ENGINE_METHODS)[number], keyof PiGatewaySession> extends never
  ? true
  : never;
const _assertClassCoversProtocol: _AssertClassCoversProtocol = true;
void _assertClassCoversProtocol;

// ── 构造入口 ─────────────────────────────────────────────────────────────────────────

/**
 * 建一个 gateway pi 会话。等价于 binary 路径的 `spawnPiRpc(...) + new PiRpcSession(...)`、
 * in-process 路径的 `openPiInProcSession(...)`。
 *
 * 失败路径（fork 失败 / open 超时 / worker 起不来）一律 **kill 掉 worker 再抛**：
 * 不 kill 的话会留下一个既没人用、也不会自己退出的孤儿进程。此处的 `stop()` 已把 `stopped`
 * 置真，故随后的进程退出**不会**被误报成 `crashed`（那是我们主动放弃，不是它崩了）。
 */
export async function openPiGatewaySession(options: PiGatewayOpenOptions): Promise<PiGatewaySession> {
  const { request, onEvent, onUiRequest, deps = {} } = options;

  // 懒加载 transport：它 import 了 electron，静态引会让本模块的单测被迫替身整条 electron 链路。
  const createTransport: PiGatewayTransportFactory =
    deps.createTransport ?? (await import("./transport")).forkPiHostTransport;

  const forkOptions: PiGatewayForkOptions = {
    cwd: request.cwd,
    ...(deps.env ? { env: deps.env } : {}),
  };
  const transport = createTransport(forkOptions);

  const session = new PiGatewaySession(transport, {
    onEvent,
    ...(onUiRequest ? { onUiRequest } : {}),
    readCredential: deps.readCredential ?? accessGatewayCredential,
    uiSessionId: request.uiSessionId,
    ...(deps.killDelayMs === undefined ? {} : { killDelayMs: deps.killDelayMs }),
    ...(deps.onDispose ? { onDispose: deps.onDispose } : {}),
  });

  try {
    // hasUiOutlet 决定 worker 侧审批 hook 在「无 UI 可问」时的语义（见 origin 计划的 native-hooks）。
    await session.open(request, onUiRequest !== undefined);
  } catch (err) {
    session.stop();
    throw err instanceof Error ? err : new Error(String(err));
  }

  recordAgentTrace({
    scope: "pi",
    phase: "open",
    summary: "pi gateway 会话建立",
    sessionId: request.uiSessionId,
    agent: "pi",
    data: {
      cwd: request.cwd,
      model: request.model ?? "(默认)",
      providerId: request.providerId,
      engine: "gateway",
    },
  });

  return session;
}
