// pi gateway 的主进程客户端（U3）：`PiSessionEngine` 的**第三个实现**。
//
// ── 常驻 runtime + 多会话复用（本轮改造的核心）───────────────────────────────────────
// 旧形态是「每会话 fork 一个 worker」：每次 `pi:open` 都要付 fork + 三包纯 ESM 闭包
// （~18MB）动态 import + `createAgentSession` 三段冷启动，而前两段其实是进程级的。
// 现在主进程持有**模块级单例** `PiGatewayRuntime`（唯一 transport、pending 表、
// UI/凭据路由、会话注册表），每个会话只是 runtime 上的一个 handle（`PiGatewaySession`）：
//   · 首次 `openPiGatewaySession()` 才 fork（可用 `primePiGatewayRuntime()` 在启动时预热）；
//   · 之后开会话只剩 `createAgentSession` 一段；
//   · 会话 `stop()` 发 `closeSession` 只关自己那份资源，**进程不退**；
//   · 进程级退出只有两条路：app 退出时 `shutdownPiGatewayRuntime()`，或 worker 崩溃。
//
// ── supervisor 与懒重启 ─────────────────────────────────────────────────────────────
// worker 意外退出（非 shutdown 触发）时：reject 全部 pending → 给**每个**活跃会话扇出
// `crashed` 事件（沿用既有上报路径，`pi-session.ts` 见到 crashed 会摘注册表）→ 清空注册表
// 与单例。**刻意不自动重拉**：崩溃可能由某个会话的输入稳定触发，自动重启会变成崩溃循环；
// 下次 `openPiGatewaySession()` 自然重新 fork（懒重启）。
//
// ── 三条反向调用（worker → 主进程）─────────────────────────────────────────────────
//   · `uiRequest`         → 按 sessionId 路由到对应会话的 `onUiRequest`（最终到 `emitUiRequest`
//                           → 渲染端），用户回写经 `respondUi()` → `HostUiResponse` 送回；
//   · `credentialRequest` → **主进程用 safeStorage 解密**后回 `HostCredentialResponse`（KTD1：
//                           密钥只在请求那一刻跨进程存在一次，不在 worker 常驻、不落盘）。
//                           凭据是 provider 级全局能力，不带 sessionId，路由只靠 requestId；
//   · `log`              → 转到主进程 logger（worker 的 stdout 不连终端，日志只能经这里落盘）。
//
// ── 异常边界 ───────────────────────────────────────────────────────────────────────
// 进程隔离回来了，所以 in-process 那四道闸里「怕把主进程炸了」的部分不再需要；但**跨进程带来
// 三类新的静默卡死**，这里逐条兜住：
//   1. worker 不回消息 → 每条 RPC 都有有界超时（否则渲染端 invoke 永久挂起）；
//   2. worker 死了但还有在途 RPC → 退出时统一 reject（否则调用方永远等不到应答）；
//   3. worker 发来 uiRequest 但目标会话没有 UI 出口（或已被关掉）→ 立刻回 `cancelled`
//      （否则 worker 侧的 `ctx.ui.confirm` 永久挂着，把 pi 的工具执行栈一起卡死）。

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
import type { PiGatewayTransport, PiGatewayTransportFactory } from "./transport";
import { recordAgentTrace } from "../../ipc/agent-trace";
import { createLogger } from "../../log";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "../../ipc/types";
import type { PiSessionEngine } from "../pi-inproc/session";
import type { PiImageContent, RpcResponse } from "../pi-inproc/rpc-shared";

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
 * 建会话超时。常驻 runtime 下这条 RPC 的构成分两种情况：
 *   · **首个会话**：进程 fork + 三包纯 ESM 动态 import（worker 端 fork 即预热，但首个 open
 *     仍可能要等它收尾）+ `createAgentSession`；
 *   · **后续会话**：只剩 `createAgentSession`（provider 解析、扩展加载、MCP 连接）。
 * 上限按最贵的首次取值，后续会话通常远用不满。
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

/**
 * 会话构造的可注入依赖。生产路径全部走默认值，单测逐个替换。
 *
 * ⚠️ 常驻 runtime 下的生效时机分两类：
 *   · `onDispose` 是**会话级**，每次 open 都生效；
 *   · `createTransport` / `readCredential` / `env` / `killDelayMs` 是 **runtime 级**，
 *     只在「创建单例 runtime 的那一次」生效——之后的 open 复用既有 runtime，这些字段被忽略。
 *     生产路径它们恒为默认值，所以无感；单测靠 `__resetPiGatewayRuntimeForTests()` 换新。
 */
export interface PiGatewayDeps {
  /** 进程承载工厂。缺省 `forkPiHostTransport`（懒加载，避免单测被迫装 electron 替身）。 */
  createTransport?: PiGatewayTransportFactory;
  /** 凭据金库访问（KTD1）。缺省 `accessGatewayCredential`（safeStorage 金库）。 */
  readCredential?: PiGatewayCredentialReader;
  /** 传给 worker 的追加环境变量。runtime 级：只在首次 fork 时注入。 */
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
  /** 归属会话。会话 `stop()` 时按它只了结自己的在途 RPC，不动别的会话。 */
  sessionId?: string;
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

// ── 常驻 runtime ─────────────────────────────────────────────────────────────────────

/** runtime 级构造依赖（只在创建单例那一次生效，见 `PiGatewayDeps` 的说明）。 */
interface PiGatewayRuntimeOptions {
  readCredential: PiGatewayCredentialReader;
  killDelayMs?: number;
}

/**
 * 常驻 gateway runtime：唯一 transport + pending 表 + 会话注册表 + 凭据/日志路由。
 *
 * 生命周期与 worker 进程一一对应：fork 即生、`shutdown()` 或 worker 崩溃即死。
 * 死后不复活（懒重启见模块级单例的说明）。会话（`PiGatewaySession`）只是它上面的路由条目。
 */
class PiGatewayRuntime {
  private seq = 0;
  private sessionSeq = 0;
  private readonly pending = new Map<string, PendingCall>();
  /** 会话注册表：sessionId → handle。事件 / UI 请求按它路由，崩溃时按它扇出。 */
  private readonly handles = new Map<string, PiGatewaySession>();
  /** 进程级 shutdown 已发起（app 退出路径）。此后的退出**不算崩溃**，不扇出 crashed。 */
  private stopping = false;
  /** 退出去重标志：exit 与 error 可能先后到达，supervisor 收尾只能跑一次。 */
  private exited = false;
  private exitError?: Error;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transport: PiGatewayTransport,
    private readonly options: PiGatewayRuntimeOptions,
  ) {
    transport.onLine((line) => this.handleLine(line));
    transport.onExit((code, stderrTail) => this.handleExit(code, stderrTail));
    transport.onError((err) => this.handleError(err));
  }

  /** runtime 是否已不可用（崩溃或已发起 shutdown）。 */
  get isDown(): boolean {
    return this.exited || this.stopping;
  }

  /**
   * 分配连接内唯一的会话路由键。
   * 与 `uiSessionId` 刻意解耦：后者是渲染端的业务 id，同一个 uiSessionId 可能关掉重开——
   * 若直接拿它当路由键，旧会话的残余消息会精准串进新会话。
   */
  allocateSessionId(): string {
    this.sessionSeq += 1;
    return `sess_${this.sessionSeq}`;
  }

  /** 登记一个会话 handle（必须在发 open 之前：createAgentSession 期间 worker 就可能发事件）。 */
  register(handle: PiGatewaySession): void {
    this.handles.set(handle.sessionId, handle);
  }

  /** 某会话的在途 RPC 数（诊断/单测用）。 */
  pendingCountOf(sessionId: string): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) count += 1;
    }
    return count;
  }

  nextId(): string {
    this.seq += 1;
    return `pg_${this.seq}`;
  }

  /** 写一条不需要应答的消息（uiResponse / credentialResponse / closeSession / shutdown）。管道已断时静默忽略。 */
  write(msg: HostMessage): void {
    try {
      this.transport.writeLine(encodeLine(msg));
    } catch (err) {
      // 会话停止 / worker 已退出后的残余写入是正常竞态，不该冒泡成命令失败。
      log.debug("pi gateway 写入失败（通道已断）", { kind: msg.kind, error: errText(err) });
    }
  }

  /** 发一条需要应答的消息并等 `WorkerReply`。超时或 runtime 已死则 reject。 */
  send(msg: HostMessage & { id: string }, timeoutMs: number, label: string, sessionId?: string): Promise<WorkerReply> {
    if (this.isDown) {
      return Promise.reject(this.exitError ?? new Error("pi gateway runtime 已关闭"));
    }
    return new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        // 命令级超时没有终态事件，最容易表现为渲染端静默卡死——必须留痕。
        log.warn("pi gateway 命令超时", { command: label, timeoutMs });
        reject(new Error(`pi 命令超时: ${label}`));
      }, timeoutMs);
      this.pending.set(msg.id, { label, resolve, reject, timer, ...(sessionId ? { sessionId } : {}) });
      try {
        this.transport.writeLine(encodeLine(msg));
      } catch (err) {
        this.pending.delete(msg.id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 关一个会话：摘注册表、按会话了结在途 RPC、发 `closeSession`。**进程不退。**
   *
   * fire-and-forget：worker 的 reply 到达时 pending 表里没有对应 id，会按迟到应答丢弃——
   * 关会话的本地清理不依赖对端确认（worker 已经死了的时候也要能关干净）。
   */
  closeSession(sessionId: string): void {
    this.handles.delete(sessionId);
    this.rejectPendingOf(sessionId, new Error("pi 会话已停止退出"));
    if (!this.isDown) {
      this.write({ id: this.nextId(), kind: "closeSession", sessionId });
    }
  }

  /**
   * **进程级** shutdown（app 退出路径）：关全部会话 + 两段式 kill。幂等。
   *
   * 第一段先发 `shutdown`（而不是直接 SIGTERM）：worker 需要跑各会话扩展的 `session_shutdown`
   * 钩子、关掉 MCP stdio 子进程。`utilityProcess.kill()` 没有信号参数，所以「先礼」只能靠协议。
   * 紧接着调一次优雅 kill，再挂一个宽限定时器兜底强杀——worker 卡在某个 await 上不响应 shutdown
   * 时，只有这一段能保证进程真的没了（孤儿 worker 会继续持有模型连接与 MCP 子进程）。
   *
   * 与崩溃路径的关键区别：**不扇出 crashed**（这是主动关闭，不是它崩了），
   * 各 handle 只被标记为「runtime 已关」，此后命令直接 reject。定时器 `unref()`：
   * 它不该拖住 Electron 的退出流程。
   */
  shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    clearRuntimeSingleton(this);
    const err = new Error("pi gateway runtime 已关闭");
    for (const handle of this.handles.values()) handle.onRuntimeShutdown(err);
    this.handles.clear();
    this.rejectAllPending(err);
    this.write({ id: this.nextId(), kind: "shutdown" });
    this.transport.kill();
    if (!this.exited) {
      this.killTimer = setTimeout(() => {
        this.killTimer = undefined;
        this.transport.kill(true);
      }, this.options.killDelayMs ?? DEFAULT_KILL_DELAY_MS);
      this.killTimer.unref?.();
    }
  }

  // ── 入站 ──────────────────────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    // runtime 死后到来的残余消息一律丢弃：否则会串进（懒重启后的）新 runtime 的会话。
    if (this.isDown) return;
    const msg = decodeLine<WorkerMessage>(line);
    if (!msg) {
      // 一行坏数据绝不中断通道（协议 decodeLine 的契约），只留痕。
      log.warn("pi gateway 丢弃不可解析的 worker 消息", { length: line.length });
      return;
    }
    switch (msg.kind) {
      case "reply": {
        const entry = this.pending.get(msg.id);
        // 未知 id：已超时被清掉的迟到应答，或 fire-and-forget 的 closeSession 确认。忽略，避免串台。
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
        return;
      }
      case "event":
        // 按 sessionId 路由。无主（会话已被 stop 摘除）的残余事件直接丢弃——
        // 不丢会串进之后复用同 uiSessionId 的新会话。
        this.handles.get(msg.sessionId)?.dispatchEvent(msg.event, msg.runId);
        return;
      case "uiRequest": {
        const handle = this.handles.get(msg.sessionId);
        if (!handle) {
          // 会话已关但 worker 侧还有在途 UI 请求：必须立刻回 cancelled，否则 worker 的
          // 工具执行栈会挂在一个永远无人应答的 Promise 上（异常边界 3）。
          this.write({
            id: this.nextId(),
            kind: "uiResponse",
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            payload: { cancelled: true },
          });
          return;
        }
        handle.dispatchUiRequest(msg);
        return;
      }
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
   * 反向调用：取一条凭据（KTD1）。runtime 级——凭据是 provider 级全局能力，与会话无关。
   *
   * 时序：worker 侧 `CredentialStore.read()` → 本条消息 → 主进程 safeStorage 解密 →
   * `HostCredentialResponse` → worker 侧 Promise 落定。密钥因此**只在这一次往返里跨进程存在**，
   * 不在 worker 常驻、不落盘——严格优于 binary 路径（密钥烘焙进 .js 文件 + spawn env）。
   *
   * 解密失败不抛给 worker 之外的任何人：回一条 `value:null` + error，让 pi 走「未配置」路径
   * 并给出可读原因，而不是让整个 runtime 在一个金库故障上崩掉。**任何分支都不记录 value。**
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
    // 解密是异步的，期间 runtime 可能已经死了；write() 内部对断管道是静默的。
    this.write({
      id: this.nextId(),
      kind: "credentialResponse",
      requestId: msg.requestId,
      value,
      ...(error ? { error } : {}),
    });
  }

  // ── supervisor（退出收口）──────────────────────────────────────────────────────────

  /**
   * worker 进程退出的统一收口（R5 + 崩溃扇出）。非 shutdown 触发的退出 = 崩溃：
   * **每个**活跃会话都要收到 `crashed`（常驻 runtime 下一个进程承载多个会话，漏一个就有一条
   * 渲染端会话永远显示「运行中」），`pi-session.ts` 的 `emitEvent` 见到 crashed 会摘除注册表
   * 条目——与 binary 路径逐字同义。随后清空单例（懒重启：**不自动重拉**，防崩溃循环；
   * 下次 `openPiGatewaySession()` 再 fork）。
   *
   * ⚠️ **code=0 也可能是崩溃**：worker 的 ESM 加载失败、入口指向 asar 内路径这两类失败都表现为
   * 「code=0、无任何输出」（KTD2/KTD3）。故判据是「没主动 shutdown → 崩溃」，而不是
   * 「退出码非 0 → 崩溃」；stderr 尾环只要非空就一定拼进 error，它是这两类失败唯一的线索。
   */
  private handleExit(code: number | null, stderrTail?: string): void {
    if (this.exited) return;
    this.exited = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    clearRuntimeSingleton(this);
    const codeText = code === null ? "null" : String(code);
    const tail = stderrTail?.trim();
    const detail = tail
      ? `退出码 ${codeText}: ${tail}`
      : code === 0 || code === null
        ? undefined
        : `退出码 ${codeText}`;
    this.exitError = new Error(detail ?? `pi-host worker 退出（code=${codeText}）`);
    // 在途 RPC 必须在扇出之前了结：上层收到 crashed 后可能立刻重开会话，届时旧 pending 还挂着就是泄漏。
    this.rejectAllPending(this.exitError);
    if (this.stopping) return;
    log.warn("pi-host worker 崩溃退出", { code, detail, sessions: this.handles.size });
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles) handle.onRuntimeCrashed(this.exitError, detail);
  }

  /** 承载层错误（当前 utilityProcess 不会触发；保留以对将来的 child_process 实现通用）。 */
  private handleError(err: Error): void {
    if (this.exited) return;
    this.exited = true;
    clearRuntimeSingleton(this);
    this.exitError = err;
    this.rejectAllPending(err);
    if (this.stopping) return;
    log.warn("pi-host worker 错误退出", { error: err.message });
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles) handle.onRuntimeCrashed(err, err.message);
  }

  private rejectPendingOf(sessionId: string, err: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// ── 会话 handle ──────────────────────────────────────────────────────────────────────

/**
 * 一个 gateway pi 会话：常驻 runtime 上的路由条目 + `PiSessionEngine` 的实现。
 * `openPiGatewaySession()` 建、`stop()` 销（只关本会话，进程不退），
 * 中途经方法调用下发 RPC、经 `onEvent` 上报事件。
 */
export class PiGatewaySession implements PiSessionEngine {
  /**
   * pi 侧 UI 请求 id（`PiUiRequest.id`）→ 协议侧 `WorkerUiRequest.requestId`。
   *
   * 两者**不是同一个 id**：前者是 pi 自己 `crypto.randomUUID()` 出来、渲染端回写时原样带回的；
   * 后者是 worker 为这次反向调用分配的关联键。渲染端只知道前者，所以主进程必须留这张映射表，
   * 否则用户点了「允许」之后应答会带着错的 requestId 回去，worker 那边永远等不到、工具栈卡死。
   * **按会话各一份**（多会话隔离）：A 会话的回写查的是 A 自己的表，绝不可能落到 B 会话。
   */
  private readonly uiRequestIds = new Map<string, string>();
  /** 主动停止标志：主动停的会话不在注册表里，天然收不到 crashed 扇出。 */
  private stopped = false;
  /** runtime 死亡（崩溃或进程级 shutdown）后的终态错误；此后所有命令直接 reject 它。 */
  private runtimeError?: Error;

  constructor(
    private readonly runtime: PiGatewayRuntime,
    /** 连接内唯一的路由键（runtime 分配），协议里所有会话级消息都带它。 */
    readonly sessionId: string,
    private readonly options: {
      onEvent: (ev: PiSessionEvent, runId?: string) => void;
      onUiRequest?: (req: PiUiRequest) => void;
      uiSessionId: string;
      onDispose?: () => Promise<void> | void;
    },
  ) {}

  /** 本会话的在途 RPC 数（诊断/单测用）。 */
  get pendingCount(): number {
    return this.runtime.pendingCountOf(this.sessionId);
  }

  // ── 出站 ──────────────────────────────────────────────────────────────────────────

  /** 发一条需要应答的会话级消息。会话已停 / runtime 已死时直接 reject（异常边界 1/2）。 */
  private send(msg: HostMessage & { id: string }, timeoutMs: number, label: string): Promise<WorkerReply> {
    if (this.stopped || this.runtimeError) {
      return Promise.reject(this.runtimeError ?? new Error("pi 会话已停止退出"));
    }
    return this.runtime.send(msg, timeoutMs, label, this.sessionId);
  }

  /** 转发一次引擎方法调用，返回 worker 的 `result`；worker 侧 dispatch 失败则抛。 */
  private async invoke(method: EngineMethod, args: unknown[]): Promise<unknown> {
    const timeoutMs = LONG_CALL_METHODS.has(method) ? LONG_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS;
    const reply = await this.send(
      { id: this.runtime.nextId(), kind: "call", sessionId: this.sessionId, method, args: trimArgs(args) },
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

  // ── 入站（由 runtime 按 sessionId 路由进来）────────────────────────────────────────

  /**
   * 事件出口。**必须永不抛**：这里抛出去就会打断 transport 的 message 回调，
   * runtime 上**所有会话**的后续事件与应答一起消失（表现为「全都活着但不再有任何反应」）。
   */
  dispatchEvent(ev: PiSessionEvent, runId?: string): void {
    try {
      this.options.onEvent(ev, runId);
    } catch (err) {
      log.warn("pi gateway 事件回调抛错（已吞，会话继续）", { type: ev.type, error: errText(err) });
    }
  }

  /** 反向调用：UI 交互（审批 / askquestion）转给渲染端。 */
  dispatchUiRequest(msg: WorkerUiRequest): void {
    const sink = this.options.onUiRequest;
    if (!sink) {
      // 无 UI 出口却收到 uiRequest：立刻回 cancelled。不回的话 worker 侧 `ctx.ui.*` 的 Promise
      // 永久挂起，把它所在的 pi 工具执行栈一起冻住（跨进程后没人能替它兜底，只能主进程显式应答）。
      this.writeUiResponse(msg.requestId, { cancelled: true });
      return;
    }
    this.uiRequestIds.set(msg.request.id, msg.requestId);
    try {
      sink(msg.request);
    } catch (err) {
      // 转发失败（渲染端已销毁等）同样必须回一条，否则 worker 永久等待。
      log.warn("pi gateway UI 请求转发失败", { method: msg.request.method, error: errText(err) });
      this.uiRequestIds.delete(msg.request.id);
      this.writeUiResponse(msg.requestId, { cancelled: true });
    }
  }

  /** UI 应答出站的小收口：sessionId 必带（worker 按它路由回本会话，防串台）。 */
  private writeUiResponse(requestId: string, payload: PiUiResponsePayload): void {
    this.runtime.write({
      id: this.runtime.nextId(),
      kind: "uiResponse",
      sessionId: this.sessionId,
      requestId,
      payload,
    });
  }

  /**
   * 崩溃扇出入口（supervisor 调）。主动 `stop()` 过的会话已不在注册表里，不会走到这——
   * 所以「主动停的退出不算崩溃」这条既有语义在多会话形态下由注册表结构本身保证。
   */
  onRuntimeCrashed(err: Error, detail?: string): void {
    this.runtimeError = err;
    this.uiRequestIds.clear();
    this.dispatchEvent({ type: "crashed", ...(detail ? { error: detail } : {}) });
  }

  /** 进程级 shutdown（app 退出）时的标记：不算崩溃、不发事件，只让后续命令快速失败。 */
  onRuntimeShutdown(err: Error): void {
    this.runtimeError = err;
    this.uiRequestIds.clear();
  }

  // ── PiSessionEngine ───────────────────────────────────────────────────────────────

  /** 建会话。由 `openPiGatewaySession` 调用一次，失败即视为会话不可用。 */
  async open(request: PiOpenRequest, hasUiOutlet: boolean): Promise<void> {
    const reply = await this.send(
      {
        id: this.runtime.nextId(),
        kind: "open",
        sessionId: this.sessionId,
        request: sanitizeOpenRequest(request),
        hasUiOutlet,
      },
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
    if (this.stopped || this.runtimeError) return;
    // 找不到映射时退回用原 id 当 requestId：worker 侧采用的正是「requestId === pi 的 id」的实现，
    // 这条兜底让它照样能对上；即便对不上，最坏也只是 worker 忽略一条应答，不会串到别的请求。
    const requestId = this.uiRequestIds.get(id) ?? id;
    this.uiRequestIds.delete(id);
    this.writeUiResponse(requestId, payload);
  }

  /**
   * 主动停止：**只关本会话，进程不退**（常驻 runtime 的核心语义变化）。幂等。
   *
   * 发 `closeSession` 让 worker 侧 abort 在途 run → stop 会话 → 释放该会话的 MCP 等资源；
   * 本地摘注册表、只了结**本会话**的在途 RPC——其它会话不受任何影响。
   * 进程级退出只在 `shutdownPiGatewayRuntime()`（app 退出）与 worker 崩溃两条路上发生。
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.uiRequestIds.clear();
    this.runtime.closeSession(this.sessionId);
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

// ── 模块级单例与构造入口 ──────────────────────────────────────────────────────────────
//
// 缓存的是 **Promise** 而不是实例：并发首开（编排一次拉起多条会话）时，两条
// `openPiGatewaySession` 只能 fork 出一个进程。创建失败不缓存（app 未 ready / 入口缺失
// 修好后下次重试）；崩溃或 shutdown 时清空 → 懒重启。

let runtimePromise: Promise<PiGatewayRuntime> | null = null;
let activeRuntime: PiGatewayRuntime | null = null;

/**
 * 懒重启的另一半：runtime 死亡（崩溃 / shutdown）时清掉单例。
 * 带 identity 判定：旧 runtime 的迟到退出事件不能把刚建好的新 runtime 顶掉。
 */
function clearRuntimeSingleton(rt: PiGatewayRuntime): void {
  if (activeRuntime === rt) {
    activeRuntime = null;
    runtimePromise = null;
  }
}

/** 真正创建 runtime：fork worker + 构造路由。只被 `ensureRuntime` 在无单例时调用一次。 */
async function createRuntime(deps: PiGatewayDeps): Promise<PiGatewayRuntime> {
  // 懒加载 transport：它 import 了 electron，静态引会让本模块的单测被迫替身整条 electron 链路。
  const createTransport: PiGatewayTransportFactory =
    deps.createTransport ?? (await import("./transport")).forkPiHostTransport;
  // 常驻进程刻意**不绑定任何一个会话的 cwd**：pi 的工具与会话文件推导只认 open 请求里的
  // `request.cwd`（in-process 路径同理——主进程 cwd 与项目目录本就无关），fork 继承主进程即可。
  // 绑首个会话的 cwd 反而是坑：worker 活得比那个会话久，后续会话会踩着别人的目录跑。
  return new PiGatewayRuntime(createTransport({ ...(deps.env ? { env: deps.env } : {}) }), {
    readCredential: deps.readCredential ?? accessGatewayCredential,
    ...(deps.killDelayMs === undefined ? {} : { killDelayMs: deps.killDelayMs }),
  });
}

/** 取（或创建）单例 runtime。失败不缓存；已死的单例由 supervisor 清掉，这里永远拿到活的或新 fork 的。 */
function ensureRuntime(deps: PiGatewayDeps): Promise<PiGatewayRuntime> {
  if (runtimePromise) return runtimePromise;
  const promise = createRuntime(deps).then(
    (rt) => {
      activeRuntime = rt;
      // 极端竞态护栏：fork 后瞬死（exit 在登记单例之前就到了）时不把死 runtime 挂成单例。
      if (rt.isDown) clearRuntimeSingleton(rt);
      return rt;
    },
    (err: unknown) => {
      if (runtimePromise === promise) {
        runtimePromise = null;
        activeRuntime = null;
      }
      throw err instanceof Error ? err : new Error(String(err));
    },
  );
  runtimePromise = promise;
  return promise;
}

/**
 * 预热：确保常驻 runtime 已 fork。worker 进程一起来就自己开始动态 import 三包
 * （见 `pi-host/index.ts` 的 fork 即预热），所以主进程侧只需把进程拉起来。
 *
 * fire-and-forget：app 启动路径调用，失败只留日志——真正需要时 `openPiGatewaySession`
 * 会重试并响亮报错。幂等：单例缓存的是 Promise，连调两次也只 fork 一次。
 * （接线到启动流程是集成阶段的事，本模块只导出不接线。）
 */
export function primePiGatewayRuntime(deps: PiGatewayDeps = {}): void {
  void ensureRuntime(deps).catch((err: unknown) => {
    log.warn("pi gateway runtime 预热失败（不影响启动）", { error: errText(err) });
  });
}

/**
 * **进程级** shutdown：关全部会话并让 worker 退出 + 两段式 kill 兜底。
 * 替代旧「每会话一进程」形态下 `killAllPiHostWorkers` 的语义位（接线到 app 的
 * before-quit 是集成阶段的事，本模块只导出不接线）。幂等；创建仍在途时也能收口
 * （等 fork 完成后立刻 shutdown，避免留下无人管的孤儿 worker）。
 */
export function shutdownPiGatewayRuntime(): void {
  const rt = activeRuntime;
  const pending = runtimePromise;
  activeRuntime = null;
  runtimePromise = null;
  if (rt) {
    rt.shutdown();
    return;
  }
  void pending?.then(
    (created) => created.shutdown(),
    () => undefined,
  );
}

/** 单测复位：强制关掉单例 runtime，避免跨用例串状态。生产代码不得调用。 */
export function __resetPiGatewayRuntimeForTests(): void {
  shutdownPiGatewayRuntime();
}

/**
 * 建一个 gateway pi 会话。等价于 binary 路径的 `spawnPiRpc(...) + new PiRpcSession(...)`、
 * in-process 路径的 `openPiInProcSession(...)`；对选路层的签名与语义完全不变。
 *
 * 常驻 runtime 下的失败路径与旧版有一处刻意区别：open 失败**只关本会话、不杀进程**——
 * runtime 上可能还有别的活跃会话，为一次 open 失败杀进程等于连坐。worker 真挂死时由
 * supervisor（exit 监听）统一收口并扇出 crashed。
 */
export async function openPiGatewaySession(options: PiGatewayOpenOptions): Promise<PiGatewaySession> {
  const { request, onEvent, onUiRequest, deps = {} } = options;

  const runtime = await ensureRuntime(deps);
  const session = new PiGatewaySession(runtime, runtime.allocateSessionId(), {
    onEvent,
    ...(onUiRequest ? { onUiRequest } : {}),
    uiSessionId: request.uiSessionId,
    ...(deps.onDispose ? { onDispose: deps.onDispose } : {}),
  });
  // 先登记再 open：`createAgentSession` 期间 worker 就可能开始发事件（扩展加载告警等），
  // 不先登记它们会被当成无主事件丢掉。
  runtime.register(session);

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
