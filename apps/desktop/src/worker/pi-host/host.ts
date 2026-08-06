// pi-host 的协议层：把 `HostMessage` 落到 `PiSessionEngine` 的方法上，把会话事件与两类反向
// 请求（UI / 凭据）转成 `WorkerMessage` 发回主进程。
//
// ── 常驻多会话（本轮改造的核心）──────────────────────────────────────────────────────
// 一个 worker 进程**常驻并同时承载多个会话**（sessionId → 会话的注册表）：fork 与三包
// 纯 ESM 闭包的动态 import 只付一次（见 `startPiHostRuntimeWarmup`），开会话只剩
// `createAgentSession`。每个会话的能力组装、UI 桥、MCP 释放仍是**会话级**（与单会话时代
// 语义一致，别动）；凭据 RPC 是 provider 级全局能力，刻意不分会话。
// 生命周期两级：`closeSession` 只关一个会话（进程不退）；`shutdown` 关全部会话并退进程。
//
// ── 它与 in-process 路径的关系 ────────────────────────────────────────────────────────
// 本类**不重新实现会话**：真正的会话仍是 `pi-inproc/session.ts` 的 `PiInProcSession`
// （四道异常闸、事件泵、UI 桥、扩展命令补发收尾全部原样复用），host 只是它外面的一层
// 「方法 ⇄ 消息」适配器。所以 pi 升级带来的会话语义变化只会落在那一个文件里。
//
// ── 承载与并发 ───────────────────────────────────────────────────────────────────────
// 传输由 `index.ts` 注入（生产是 `process.parentPort`，单测是内存替身），本文件只认
// 「一行 JSONL 进 / 一行 JSONL 出」。`postMessage` 本身保序，`AgentSession.subscribe` 的回调
// 也是串行的，故**单个会话内**事件顺序天然与 in-process 路径一致；多会话之间事件交错是
// 合法的（各带 sessionId，主进程按会话路由），本文件不做任何重排或缓冲。
//
// ── 三条「永不抛」的边界（子进程崩了主进程就只能报 crashed，所以这里必须自己兜住）──────
//  1. `handleLine` / `handleMessage`：坏消息只跳过并留痕，绝不因一行坏数据中断通道。
//  2. `call` 的转发：任何抛出转成 `reply{ok:false,error}`，与 `PiSessionEngine` 的
//     「命令级失败」语义同义，主进程侧再转成 IPC rejection，渲染端行为不变。
//  3. 事件与反向请求的发送：序列化失败只丢那一条并留痕（事件已被 `sanitizePiSessionEvent`
//     净化过，这里是最后一道保险）。

import {
  decodeLine,
  encodeLine,
  ENGINE_METHODS,
  type EngineMethod,
  type HostMessage,
  type WorkerMessage,
} from "../../main/agents/pi-gateway/protocol";
import type { PiInProcDeps, PiInProcOpenOptions, PiSessionEngine } from "../../main/agents/pi-inproc";
import {
  loadPiAgentCore,
  loadPiAiCompat,
  loadPiCodingAgent,
  openPiInProcSession,
} from "../../main/agents/pi-inproc";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "../../main/ipc/types";
import { buildWorkerDeps, type WorkerCapabilityContext } from "./capabilities";
import { createRpcCredentialStore, type CredentialRpc } from "./credentials";
import { createLogger, setWorkerLogSink } from "./log";
import { createWorkerModelResolver } from "./model";

const log = createLogger("pi-host");

/** 可转发的方法名集合。用 Set 做 O(1) 判定，同时挡住「主进程发来一个不在契约里的方法名」。 */
const FORWARDABLE = new Set<string>(ENGINE_METHODS);

/**
 * 凭据反向请求的超时。
 *
 * 必须有：主进程若因为任何原因不应答（客户端 bug / 窗口销毁竞态），pi 的 `getAuth()` 会
 * **永久挂起**，表现为「发了消息什么都不发生」，比报错难查得多。超时后按「未配置」结算，
 * pi 会给出一句响亮的「provider 未认证」。20s 与 MCP 控制面超时同量级。
 */
const CREDENTIAL_TIMEOUT_MS = 20_000;

/**
 * `shutdown` 之后到 `process.exit` 的**最长**宽限。
 *
 * 主进程侧是两段式 kill：发 `shutdown` + 优雅 kill，**3s 后 SIGKILL**。所以这段窗口里必须跑完
 * 全部会话的扩展 `session_shutdown` 钩子与 MCP stdio 子进程的回收，超时就来不及清理了。
 * 取 2s（留 1s 余量给 postMessage 投递与主进程侧的调度抖动）；清理提前完成会立即退出，
 * 正常情况下根本用不满。
 */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * fork 即预热：进程启动就开始动态 import 三个 pi 包（纯 ESM 依赖闭包 ~18MB，冷加载耗时可观）。
 *
 * 形态刻意是「boot 时启动 Promise、open 时 await 同一个缓存」而**不是 top-level await**：
 * worker 产物是 CJS，rollup 对 CJS 输出的 top-level await 直接构建期拒绝。
 * `loadPiCodingAgent` 等（`pi-inproc/runtime.ts`）缓存的是 Promise，`openPiInProcSession` 与
 * `model.ts` 内部 await 的就是这里启动的同一个在途加载——所以 open 无需显式等预热句柄。
 * 预热失败不缓存（runtime.ts 的既有约定：失败清缓存），open 时会自动重试并响亮报错，
 * 因此这里只把失败降级成日志，绝不让预热失败影响进程存活。
 */
export function startPiHostRuntimeWarmup(): void {
  const swallow = (err: unknown): void => {
    log.debug("pi 运行时预热失败（open 时会重试并响亮报错）", { error: errText(err) });
  };
  void loadPiCodingAgent().catch(swallow);
  void loadPiAgentCore().catch(swallow);
  void loadPiAiCompat().catch(swallow);
}

export interface PiHostOptions {
  /** 一行 JSONL 出口（生产：`parentPort.postMessage`）。 */
  write: (line: string) => void;
  /** 进程退出（生产：`process.exit`）。单测传替身即可断言「收到 shutdown 后确实退了」。 */
  exit?: (code: number) => void;
  /** 会话构造注入点（单测替身；生产为 `openPiInProcSession`）。 */
  openSession?: (options: PiInProcOpenOptions) => Promise<PiSessionEngine>;
  /** 能力组装注入点（单测替身；生产为 `buildWorkerDeps`）。 */
  buildDeps?: (prepared: PiOpenRequest, ctx: WorkerCapabilityContext) => Promise<PiInProcDeps>;
  /** shutdown 宽限，单测可设 0 让退出同步可见。 */
  shutdownGraceMs?: number;
}

/**
 * 外部资源释放（MCP 子进程与在途 HTTP）完成信号的截留器，**按会话各一份**。
 *
 * `PiInProcSession.stop()` 是同步方法，内部把 `onDispose()` 当 floating promise 发出去，
 * 调用方拿不到句柄。但 shutdown 只有 3s 预算（超时被 SIGKILL），必须知道「清理完了没有」，
 * 所以在组装 deps 时把 `onDispose` 包一层，把那个 promise 截留在这里。多会话下若混用一个
 * 进程级字段，A 会话的清理会把 B 会话的信号顶掉——故必须随会话登记项各存一份。
 */
interface DisposeTracker {
  settled: Promise<void>;
}

/** 一个会话在 host 里的登记项。 */
interface HostSessionEntry {
  session: PiSessionEngine;
  dispose: DisposeTracker;
}

/**
 * 一个 pi-host：**常驻进程，多会话复用**。
 *
 * 状态机：boot（预热已在跑）→ 任意次 `open`/`call`/`closeSession` 交错 → `shutdown` → 退出。
 * 会话之间完全独立：一个会话 open 失败 / 被关掉，不影响其它会话的命令与事件。
 */
export class PiHost {
  /** 会话注册表：sessionId → 会话。所有会话级消息按它路由。 */
  private readonly sessions = new Map<string, HostSessionEntry>();
  /** 正在 open 的 sessionId：挡同一会话的并发重复 open，也让 open 期间的事件不被当成无主丢掉。 */
  private readonly opening = new Set<string>();
  private shuttingDown = false;

  /**
   * 在途凭据请求：requestId → resolver。超时或收到应答后即摘除。
   * `isWrite` 决定失败时是 reject 还是软着陆成 null（见 `credentialRpc` 的失败语义说明）。
   * 全局而非会话级：凭据是 provider 级能力（协议侧同一约定），closeSession 不清它——
   * 在途请求的应答仍会到达或按超时结算，不会随会话关闭而永久挂起。
   */
  private readonly pendingCredentials = new Map<
    string,
    {
      resolve: (value: string | null) => void;
      reject: (err: Error) => void;
      isWrite: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private seq = 0;

  constructor(private readonly options: PiHostOptions) {}

  // ── 入站 ────────────────────────────────────────────────────────────────────────────

  /** 喂一行 JSONL。**永不抛**（边界 1）。 */
  handleLine(line: string): void {
    const msg = decodeLine<HostMessage>(line);
    if (!msg) {
      log.warn("收到无法解析的协议行，已跳过");
      return;
    }
    this.handleMessage(msg);
  }

  /** 处理一条已解码的消息。**永不抛**（边界 1）。 */
  handleMessage(msg: HostMessage): void {
    try {
      switch (msg.kind) {
        case "open":
          void this.onOpen(msg.id, msg.sessionId, msg.request as PiOpenRequest, msg.hasUiOutlet);
          return;
        case "call":
          void this.onCall(msg.id, msg.sessionId, msg.method, msg.args);
          return;
        case "uiResponse":
          this.onUiResponse(msg.sessionId, msg.requestId, msg.payload);
          return;
        case "credentialResponse":
          this.onCredentialResponse(msg.requestId, msg.value, msg.error);
          return;
        case "closeSession":
          this.onCloseSession(msg.id, msg.sessionId);
          return;
        case "shutdown":
          void this.onShutdown(msg.id);
          return;
        default:
          // 协议是封闭联合，走到这里说明对端比本 worker 新。跳过并留痕，不中断通道。
          log.warn("收到未知类型的协议消息，已跳过", { kind: (msg as { kind?: unknown }).kind });
      }
    } catch (err) {
      log.error("协议消息处理异常（已隔离）", { error: errText(err) });
    }
  }

  // ── open ────────────────────────────────────────────────────────────────────────────

  /**
   * 建会话：组装能力 → `openPiInProcSession` → 登记进注册表。
   *
   * `hasUiOutlet` 由主进程如实告知，直通到审批 hook —— gateway 下 pi 的 `ctx.hasUI` 与
   * in-process 一样恒为 true，照抄旧判据会让「无 UI = 放行 + 留痕」反转成「全部 block」
   *（见 capabilities.ts 的安全红线 3）。
   */
  private async onOpen(id: string, sessionId: string, request: PiOpenRequest, hasUiOutlet: boolean): Promise<void> {
    if (this.shuttingDown) {
      this.reply(id, false, undefined, "pi-host 正在关闭，拒绝新会话");
      return;
    }
    // sessionId 是协议必填项；缺失只可能来自对端 bug，响亮失败好过登记出一个路由不到的会话。
    if (!sessionId) {
      this.reply(id, false, undefined, "open 缺少 sessionId");
      return;
    }
    if (this.sessions.has(sessionId) || this.opening.has(sessionId)) {
      this.reply(id, false, undefined, `会话已存在，不支持重复 open: ${sessionId}`);
      return;
    }
    this.opening.add(sessionId);
    // 组装成功但建会话失败时要手动释放：`PiInProcSession.stop()` 是唯一会调 `onDispose` 的地方，
    // 而那时会话根本没建起来。不释放的话 MCP 的 stdio 子进程会一直挂在常驻 worker 里——
    // 多会话形态下进程不再随会话退出，这条泄漏比单会话时代更致命。
    const dispose: DisposeTracker = { settled: Promise.resolve() };
    let deps: PiInProcDeps | null = null;
    try {
      const credentials = createRpcCredentialStore(this.credentialRpc);
      const ctx: WorkerCapabilityContext = {
        hasUiOutlet: () => hasUiOutlet,
        credentials,
        resolveModel: createWorkerModelResolver(credentials),
      };
      deps = this.trackDispose(await (this.options.buildDeps ?? buildWorkerDeps)(request, ctx), dispose);

      const openSession = this.options.openSession ?? openPiInProcSession;
      const session = await openSession({
        request,
        onEvent: (event, runId) => this.emitEvent(sessionId, event, runId),
        // 只在真有 UI 出口时接线：不接的话 `ui-context.ts` 的 dialog 会按 defaultValue 立即结算，
        // 这正是「无 UI 出口 = 放行 + 留痕」那条语义在引擎层的另一半（confirm 的默认值是 false，
        // 但审批 hook 在 `hasUiOutlet()` 为 false 时压根不会走到 confirm）。
        ...(hasUiOutlet ? { onUiRequest: (req: PiUiRequest) => this.emitUiRequest(sessionId, req) } : {}),
        ...(request.askQuestionSentinel ? { askQuestionSentinel: request.askQuestionSentinel } : {}),
        deps,
      });
      this.sessions.set(sessionId, { session, dispose });
      this.reply(id, true);
    } catch (err) {
      // 建会话失败必须响亮：主进程据此把 `pi:open` 转成 rejection，用户看到的是
      // 「供应商未配置 / 模型不存在」这类可操作的文案，而不是一个卡住的会话。
      log.error("建立 pi 会话失败", { sessionId, error: errText(err) });
      void deps?.onDispose?.();
      this.reply(id, false, undefined, errText(err));
    } finally {
      this.opening.delete(sessionId);
    }
  }

  /**
   * 给 deps 的 `onDispose` 包一层，把释放完成的 promise 截留到该会话的 tracker（见其注释）。
   * 没有 `onDispose` 时也要包：将来某条路径补上时不必再想起改这里。
   */
  private trackDispose(deps: PiInProcDeps, tracker: DisposeTracker): PiInProcDeps {
    const inner = deps.onDispose;
    return {
      ...deps,
      onDispose: () => {
        // catch 掉：释放失败已由引擎侧记日志，这里只关心「跑完了没有」，
        // 让一个 rejected promise 逃出去会变成 worker 的 unhandledRejection。
        tracker.settled = Promise.resolve(inner?.()).then(
          () => undefined,
          () => undefined,
        );
        return tracker.settled;
      },
    };
  }

  // ── call ────────────────────────────────────────────────────────────────────────────

  /** 转发一次引擎方法调用（边界 2：任何抛出转成 `reply{ok:false}`）。 */
  private async onCall(id: string, sessionId: string, method: EngineMethod, args: unknown[]): Promise<void> {
    if (!FORWARDABLE.has(method)) {
      this.reply(id, false, undefined, `pi-host 不支持的方法: ${String(method)}`);
      return;
    }
    // 按 sessionId 查注册表：发到不存在（未建 / 已关）的会话是转发层失败，
    // 绝不能落到别的会话——那是最难归因的一类串台。
    const session = this.sessions.get(sessionId)?.session;
    if (!session) {
      this.reply(id, false, undefined, "pi 会话尚未建立");
      return;
    }
    try {
      // 参数形状由 `PiSessionEngine` 在编译期保证（协议的 `ENGINE_METHODS` 与接口有对账断言），
      // 这里不做运行时校验——多一层校验只会在契约演进时变成第二个要同步的地方。
      const fn = session[method] as (...a: unknown[]) => unknown;
      const result = await fn.apply(session, normalizeArgs(args));
      // ⚠️ 命令级失败（`RpcResponse{success:false}`）照常随 `ok:true` 回去：
      // `ok:false` 是**转发层**失败的专用信号，客户端会把它转成 IPC rejection。
      // 混用会让「pi 说这条命令没成功」和「这条命令根本没送到」在渲染端变成同一种错误。
      this.reply(id, true, result);
    } catch (err) {
      log.warn("pi 方法调用失败", { sessionId, method, error: errText(err) });
      this.reply(id, false, undefined, errText(err));
    }
  }

  // ── 事件与反向请求：UI ──────────────────────────────────────────────────────────────

  /**
   * 会话事件出站，带归属守卫：`closeSession` 后引擎的 `stop()` 已解订阅，正常不会再有事件，
   * 但扩展的异步回调可能在解订阅前已在途——已摘除会话的残余事件直接丢弃，不让主进程把它
   * 路由进已关闭的会话。open 期间（注册表尚未登记）的事件靠 `opening` 集合放行。
   */
  private emitEvent(sessionId: string, event: PiSessionEvent, runId?: string): void {
    if (!this.sessions.has(sessionId) && !this.opening.has(sessionId)) return;
    this.send(
      runId !== undefined ? { kind: "event", sessionId, event, runId } : { kind: "event", sessionId, event },
    );
  }

  /**
   * 把一条 UI 请求发回主进程。
   *
   * `requestId` 直接用 `PiUiRequest.id`：那个 id 由引擎的 UI 桥生成（`crypto.randomUUID`），
   * 本来就是应答回写的关联键，再造一个映射只会多一处可能对不上的地方。
   * `sessionId` 必带：主进程按它路由到对应会话的 UI 出口（多会话审批互不串台的前一半）。
   */
  private emitUiRequest(sessionId: string, request: PiUiRequest): void {
    this.send({ kind: "uiRequest", sessionId, requestId: request.id, request });
  }

  /**
   * 用户回写。**只按 sessionId 路由**（多会话审批互不串台的后一半）：
   * A 会话的应答带着 A 的 sessionId 回来，即使 requestId 碰巧与 B 会话的某条相同
   * （理论上 UUID 不会撞），也绝不会落到 B 的 `respondUi` 上。
   * 会话已停止时引擎自己有 stopped 守卫，这里不重复判定。
   */
  private onUiResponse(sessionId: string, requestId: string, payload: PiUiResponsePayload): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      log.warn("收到 UI 应答但会话不存在，已丢弃", { sessionId, requestId });
      return;
    }
    entry.session.respondUi(requestId, payload);
  }

  // ── 反向请求：凭据（KTD1）───────────────────────────────────────────────────────────

  /**
   * 交给 `createRpcCredentialStore` 的出口。绑定成箭头属性，避免 this 丢失。
   *
   * **失败语义按 op 分叉**（这是本方法唯一不直观的地方）：
   *   · `read` / `list` → 软着陆成 `null`，由上层当「未配置」处理。一次通道抖动不该打挂会话。
   *   · `write` / `delete` → **抛出**。写路径静默失败比读失败危险得多：pi 会以为 OAuth
   *     刷新已落盘，而金库里还是旧 token，下次开会话被登出且本会话一切正常，极难归因。
   */
  private readonly credentialRpc: CredentialRpc = (key, op = "read", value) =>
    new Promise<string | null>((resolve, reject) => {
      const isWrite = op === "write" || op === "delete";
      const fail = (reason: string): void => {
        if (isWrite) reject(new Error(`凭据${op === "write" ? "写入" : "删除"}失败：${reason}`));
        else resolve(null);
      };
      if (this.shuttingDown) {
        fail("worker 正在关闭");
        return;
      }
      const requestId = `cred-${++this.seq}`;
      // 超时兜底见 CREDENTIAL_TIMEOUT_MS 的注释：没有它，一次丢失的应答 = 永久挂起。
      const timer = setTimeout(() => {
        this.pendingCredentials.delete(requestId);
        log.warn("凭据请求超时", { key, op });
        fail("超时");
      }, CREDENTIAL_TIMEOUT_MS);
      // unref：这条定时器不该拖住 worker 退出。
      timer.unref?.();
      this.pendingCredentials.set(requestId, { resolve, reject, isWrite, timer });
      this.send({
        kind: "credentialRequest",
        requestId,
        key,
        ...(op === "read" ? {} : { op }),
        ...(value === undefined ? {} : { value }),
      });
    });

  private onCredentialResponse(requestId: string, value: string | null, error?: string): void {
    const pending = this.pendingCredentials.get(requestId);
    if (!pending) {
      // 超时后迟到的应答。丢弃是对的（那次调用已按未配置结算），但要留痕：
      // 频繁出现说明主进程侧解密变慢了，是个值得追的信号。
      log.warn("收到迟到的凭据应答，已丢弃", { requestId });
      return;
    }
    this.pendingCredentials.delete(requestId);
    clearTimeout(pending.timer);
    if (error) {
      log.warn("凭据请求返回错误", { requestId, error });
      // 写路径的错误必须冒给 pi（见 credentialRpc 的失败语义说明）；读路径按未配置软着陆。
      if (pending.isWrite) pending.reject(new Error(error));
      else pending.resolve(null);
      return;
    }
    pending.resolve(value);
  }

  // ── closeSession / shutdown ─────────────────────────────────────────────────────────

  /**
   * 关一个会话（**进程不退**——常驻 runtime 的核心语义）。只清目标会话：
   * 其它会话的命令、事件、MCP 子进程一概不动。
   *
   * 幂等：主进程侧是 fire-and-forget，崩溃恢复/竞态下可能重复发，关不存在的会话回 ok。
   * 先 abort 再 stop：进程不再随会话退出，不 abort 的话在途的 agent run 会带着已解绑的
   * 会话继续烧模型调用与工具执行（单会话时代靠进程退出兜底，现在没有这层了）。
   */
  private onCloseSession(id: string, sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.reply(id, true);
      return;
    }
    this.sessions.delete(sessionId);
    try {
      // abort 是异步 RPC 形态的方法，这里 fire-and-forget：它只负责触发 AbortSignal，
      // 后续清理由 stop() 同步收口；失败也不该阻断关会话。
      void Promise.resolve(entry.session.abort()).catch(() => undefined);
      // stop() 同步解订阅、解挂起对话框，并发起 runtime.dispose（扩展 session_shutdown 钩子）
      // 与 onDispose（MCP stdio 子进程 / 在途 HTTP 的释放）。
      entry.session.stop();
    } catch (err) {
      log.warn("停止 pi 会话失败", { sessionId, error: errText(err) });
    }
    this.reply(id, true);
  }

  /**
   * **进程级**关闭：停全部会话并退出进程（app 退出时用）。
   *
   * 顺序不可调整：先逐个 `session.stop()`（解订阅、解挂起对话框、释放 MCP 子进程与在途 HTTP），
   * 再回 reply，最后延时 exit。宽限是必须的——`postMessage` 是异步投递，立刻 exit 会让
   * 主进程收不到那条 reply，两段式 kill 就只能等到 SIGKILL 那一段。
   */
  private async onShutdown(id: string): Promise<void> {
    if (this.shuttingDown) {
      this.reply(id, true);
      return;
    }
    this.shuttingDown = true;
    const disposals: Array<Promise<void>> = [];
    for (const [sessionId, entry] of this.sessions) {
      try {
        entry.session.stop();
      } catch (err) {
        // 单个会话停失败不该阻断退出：进程马上就没了，剩下的资源由 OS 回收；
        // 但必须继续停其余会话——因为一个坏会话漏停所有人，正是多会话化要防的连坐。
        log.warn("停止 pi 会话失败（继续退出）", { sessionId, error: errText(err) });
      }
      disposals.push(entry.dispose.settled);
    }
    this.sessions.clear();
    // 解掉全部在途凭据请求：它们的 resolver 会随进程一起消失，不解则 pi 侧永久挂起。
    // 读请求软着陆成 null；**写请求带 error 结算**——退出时未完成的写就是没写成，
    // 让它静默变成「未配置」等于告诉 pi「写成功了」，正是要避免的那种谎报。
    for (const [, pending] of this.pendingCredentials) {
      clearTimeout(pending.timer);
      if (pending.isWrite) pending.reject(new Error("worker 正在关闭，凭据写入未完成"));
      else pending.resolve(null);
    }
    this.pendingCredentials.clear();

    // reply 先发：主进程的两段式 kill 靠它确认「worker 收到了」，晚发会让它白等一轮宽限。
    this.reply(id, true);

    // 等全部会话的清理跑完再退，但**必须有上界**——主进程 3s 后 SIGKILL，卡在这里就等于
    // 没清理还挨一刀。任何一个会话的 dispose 卡住都不该拖过宽限。
    const grace = this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    if (grace > 0) await Promise.race([Promise.all(disposals).then(() => undefined), delay(grace)]);
    (this.options.exit ?? ((code: number) => process.exit(code)))(0);
  }

  // ── 出站 ────────────────────────────────────────────────────────────────────────────

  private reply(id: string, ok: boolean, result?: unknown, error?: string): void {
    this.send({
      id,
      kind: "reply",
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  /** 发一条消息（边界 3：序列化失败只丢这一条并留痕）。 */
  private send(msg: WorkerMessage): void {
    let line: string;
    try {
      line = encodeLine(msg);
    } catch (err) {
      // 事件已被 `sanitizePiSessionEvent` 净化过，走到这里说明是命令返回值里混进了活对象；
      // 丢一条消息远好过让 worker 崩掉（那会被主进程报成 crashed，**全部**会话一起失效）。
      log.error("协议消息序列化失败，已丢弃", { kind: msg.kind, error: errText(err) });
      return;
    }
    try {
      this.options.write(line);
    } catch (err) {
      log.error("协议消息发送失败", { kind: msg.kind, error: errText(err) });
    }
  }
}

/**
 * 把 host 的日志出口接到协议上（`WorkerLog`）。
 *
 * 单独一个函数而不是塞进构造函数：日志 sink 是**进程级**全局（被复用的主进程模块在模块
 * 顶层就 `createLogger` 了），而 host 是实例级。混在一起会让单测里两个 host 互相抢 sink。
 */
export function attachHostLogSink(write: (line: string) => void): void {
  setWorkerLogSink((level, message) => {
    try {
      write(encodeLine({ kind: "log", level, message }));
    } catch {
      // 日志通道失败绝不允许冒泡——调用点可能在 pi 的 agent loop 栈上。
    }
  });
}

/**
 * 把 JSON 往返造成的 `null` 还原成 `undefined`（**跨进程契约，与主进程客户端成对**）。
 *
 * `JSON.stringify(["hi", undefined, imgs])` 出来是 `["hi", null, imgs]`：夹在中间的可选参
 * 没法靠「裁掉尾部 undefined」消掉。而引擎里到处是 `runId !== undefined` 这类判定，
 * 收到 `null` 会走错分支（`prompt` 会把 `currentRunId` 设成 null，事件从此带着 null 的代际，
 * 渲染端据此丢弃事件 —— 表现为「发了消息但界面一片空白」，且完全没有报错）。
 *
 * `PiSessionEngine` 的全部参数里没有一个以 `null` 为合法值（都是 string / string[] / 对象），
 * 所以顶层无差别还原是安全的；**不递归**，避免动到 `images` / `payload` 内部的合法 null。
 */
function normalizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => (arg === null ? undefined : arg));
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // unref：这条定时器不该在其它事情都做完之后还拖住进程退出。
    setTimeout(resolve, ms).unref?.();
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
