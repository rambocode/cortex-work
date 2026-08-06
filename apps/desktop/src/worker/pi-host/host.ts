// pi-host 的协议层：把 `HostMessage` 落到 `PiSessionEngine` 的方法上，把会话事件与两类反向
// 请求（UI / 凭据）转成 `WorkerMessage` 发回主进程。
//
// ── 它与 in-process 路径的关系 ────────────────────────────────────────────────────────
// 本类**不重新实现会话**：真正的会话仍是 `pi-inproc/session.ts` 的 `PiInProcSession`
// （四道异常闸、事件泵、UI 桥、扩展命令补发收尾全部原样复用），host 只是它外面的一层
// 「方法 ⇄ 消息」适配器。所以 pi 升级带来的会话语义变化只会落在那一个文件里。
//
// ── 承载与并发 ───────────────────────────────────────────────────────────────────────
// 传输由 `index.ts` 注入（生产是 `process.parentPort`，单测是内存替身），本文件只认
// 「一行 JSONL 进 / 一行 JSONL 出」。`postMessage` 本身保序，`AgentSession.subscribe` 的回调
// 也是串行的，故事件顺序天然与 in-process 路径一致，本文件不做任何重排或缓冲。
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
import { openPiInProcSession } from "../../main/agents/pi-inproc";
import type { PiOpenRequest, PiUiRequest, PiUiResponsePayload } from "../../main/ipc/types";
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
 * 扩展的 `session_shutdown` 钩子与 MCP stdio 子进程的回收，超时就来不及清理了。
 * 取 2s（留 1s 余量给 postMessage 投递与主进程侧的调度抖动）；MCP dispose 提前完成会立即退出，
 * 正常情况下根本用不满。
 */
const SHUTDOWN_GRACE_MS = 2_000;

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
 * 一个 pi-host。生命周期 = 一个 worker 进程 = 一个 pi 会话（首版每会话一进程）。
 *
 * 状态机很小：未开会话 → `open` → 可接 `call` → `shutdown` → 退出。
 * 刻意**不**支持一个 host 上多次 `open`：多会话共享 worker 是计划里 deferred 的优化，
 * 现在就留个半吊子分支只会让崩溃归属变得说不清。
 */
export class PiHost {
  private session: PiSessionEngine | null = null;
  /** 防止并发/重复 open。第二条 `open` 直接回失败，而不是悄悄建第二个会话。 */
  private opening = false;
  private shuttingDown = false;

  /**
   * 外部资源释放（当前是 MCP 的 stdio 子进程与在途 HTTP）的完成信号。
   *
   * `PiInProcSession.stop()` 是同步方法，内部把 `onDispose()` 当 floating promise 发出去，
   * 调用方拿不到句柄。但 shutdown 只有 3s 预算（超时被 SIGKILL），必须知道「清理完了没有」，
   * 所以在组装 deps 时把 `onDispose` 包一层，把那个 promise 截留在这里。
   */
  private disposeSettled: Promise<void> = Promise.resolve();

  /** 在途凭据请求：requestId → resolver。超时或收到应答后即摘除。 */
  private readonly pendingCredentials = new Map<
    string,
    { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> }
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
          void this.onOpen(msg.id, msg.request as PiOpenRequest, msg.hasUiOutlet);
          return;
        case "call":
          void this.onCall(msg.id, msg.method, msg.args);
          return;
        case "uiResponse":
          this.onUiResponse(msg.requestId, msg.payload);
          return;
        case "credentialResponse":
          this.onCredentialResponse(msg.requestId, msg.value, msg.error);
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
   * 建会话：组装能力 → `openPiInProcSession`。
   *
   * `hasUiOutlet` 由主进程如实告知，直通到审批 hook —— gateway 下 pi 的 `ctx.hasUI` 与
   * in-process 一样恒为 true，照抄旧判据会让「无 UI = 放行 + 留痕」反转成「全部 block」
   *（见 capabilities.ts 的安全红线 3）。
   */
  private async onOpen(id: string, request: PiOpenRequest, hasUiOutlet: boolean): Promise<void> {
    if (this.session || this.opening) {
      this.reply(id, false, undefined, "pi-host 已持有会话，不支持重复 open");
      return;
    }
    this.opening = true;
    // 组装成功但建会话失败时要手动释放：`PiInProcSession.stop()` 是唯一会调 `onDispose` 的地方，
    // 而那时会话根本没建起来。不释放的话 MCP 的 stdio 子进程会挂在 worker 里直到进程被杀
    //（主进程确实会杀，但不能把「资源回收」建立在「进程马上要死」这个假设上）。
    let deps: PiInProcDeps | null = null;
    try {
      const credentials = createRpcCredentialStore(this.credentialRpc);
      const ctx: WorkerCapabilityContext = {
        hasUiOutlet: () => hasUiOutlet,
        credentials,
        resolveModel: createWorkerModelResolver(credentials),
      };
      deps = this.trackDispose(await (this.options.buildDeps ?? buildWorkerDeps)(request, ctx));

      const openSession = this.options.openSession ?? openPiInProcSession;
      this.session = await openSession({
        request,
        onEvent: (event, runId) => this.send(runId ? { kind: "event", event, runId } : { kind: "event", event }),
        // 只在真有 UI 出口时接线：不接的话 `ui-context.ts` 的 dialog 会按 defaultValue 立即结算，
        // 这正是「无 UI 出口 = 放行 + 留痕」那条语义在引擎层的另一半（confirm 的默认值是 false，
        // 但审批 hook 在 `hasUiOutlet()` 为 false 时压根不会走到 confirm）。
        ...(hasUiOutlet ? { onUiRequest: (req: PiUiRequest) => this.emitUiRequest(req) } : {}),
        ...(request.askQuestionSentinel ? { askQuestionSentinel: request.askQuestionSentinel } : {}),
        deps,
      });
      this.reply(id, true);
    } catch (err) {
      // 建会话失败必须响亮：主进程据此把 `pi:open` 转成 rejection，用户看到的是
      // 「供应商未配置 / 模型不存在」这类可操作的文案，而不是一个卡住的会话。
      log.error("建立 pi 会话失败", { error: errText(err) });
      void deps?.onDispose?.();
      this.reply(id, false, undefined, errText(err));
    } finally {
      this.opening = false;
    }
  }

  /**
   * 给 deps 的 `onDispose` 包一层，把释放完成的 promise 截留到 `disposeSettled`（见该字段注释）。
   * 没有 `onDispose` 时也要包：将来某条路径补上时不必再想起改这里。
   */
  private trackDispose(deps: PiInProcDeps): PiInProcDeps {
    const inner = deps.onDispose;
    return {
      ...deps,
      onDispose: () => {
        // catch 掉：释放失败已由引擎侧记日志，这里只关心「跑完了没有」，
        // 让一个 rejected promise 逃出去会变成 worker 的 unhandledRejection。
        this.disposeSettled = Promise.resolve(inner?.()).then(
          () => undefined,
          () => undefined,
        );
        return this.disposeSettled;
      },
    };
  }

  // ── call ────────────────────────────────────────────────────────────────────────────

  /** 转发一次引擎方法调用（边界 2：任何抛出转成 `reply{ok:false}`）。 */
  private async onCall(id: string, method: EngineMethod, args: unknown[]): Promise<void> {
    if (!FORWARDABLE.has(method)) {
      this.reply(id, false, undefined, `pi-host 不支持的方法: ${String(method)}`);
      return;
    }
    const session = this.session;
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
      log.warn("pi 方法调用失败", { method, error: errText(err) });
      this.reply(id, false, undefined, errText(err));
    }
  }

  // ── 反向请求：UI ────────────────────────────────────────────────────────────────────

  /**
   * 把一条 UI 请求发回主进程。
   *
   * `requestId` 直接用 `PiUiRequest.id`：那个 id 由引擎的 UI 桥生成（`crypto.randomUUID`），
   * 本来就是应答回写的关联键，再造一个映射只会多一处可能对不上的地方。
   */
  private emitUiRequest(request: PiUiRequest): void {
    this.send({ kind: "uiRequest", requestId: request.id, request });
  }

  /** 用户回写。会话已停止时引擎自己有 stopped 守卫，这里不重复判定。 */
  private onUiResponse(requestId: string, payload: PiUiResponsePayload): void {
    if (!this.session) {
      log.warn("收到 UI 应答但会话不存在，已丢弃", { requestId });
      return;
    }
    this.session.respondUi(requestId, payload);
  }

  // ── 反向请求：凭据（KTD1）───────────────────────────────────────────────────────────

  /** 交给 `createRpcCredentialStore` 的出口。绑定成箭头属性，避免 this 丢失。 */
  private readonly credentialRpc: CredentialRpc = (key) =>
    new Promise<string | null>((resolve) => {
      if (this.shuttingDown) {
        resolve(null);
        return;
      }
      const requestId = `cred-${++this.seq}`;
      // 超时兜底见 CREDENTIAL_TIMEOUT_MS 的注释：没有它，一次丢失的应答 = 永久挂起。
      const timer = setTimeout(() => {
        this.pendingCredentials.delete(requestId);
        log.warn("凭据请求超时（按未配置处理）", { key });
        resolve(null);
      }, CREDENTIAL_TIMEOUT_MS);
      // unref：这条定时器不该拖住 worker 退出。
      timer.unref?.();
      this.pendingCredentials.set(requestId, { resolve, timer });
      this.send({ kind: "credentialRequest", requestId, key });
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
    if (error) log.warn("凭据请求返回错误（按未配置处理）", { requestId, error });
    pending.resolve(error ? null : value);
  }

  // ── shutdown ────────────────────────────────────────────────────────────────────────

  /**
   * 停会话并退出进程。
   *
   * 顺序不可调整：先 `session.stop()`（解订阅、解挂起对话框、释放 MCP 子进程与在途 HTTP），
   * 再回 reply，最后延时 exit。宽限是必须的——`postMessage` 是异步投递，立刻 exit 会让
   * 主进程收不到那条 reply，两段式 kill 就只能等到 SIGKILL 那一段。
   */
  private async onShutdown(id: string): Promise<void> {
    if (this.shuttingDown) {
      this.reply(id, true);
      return;
    }
    this.shuttingDown = true;
    try {
      // 同步部分：解订阅、解挂起对话框、发起 runtime.dispose()（跑扩展的 session_shutdown 钩子）
      // 与 onDispose()（关 MCP stdio 子进程 / abort 在途 HTTP）。后两者是异步的，见下。
      this.session?.stop();
    } catch (err) {
      // 停会话失败不该阻断退出：进程马上就没了，剩下的资源由 OS 回收。
      log.warn("停止 pi 会话失败（继续退出）", { error: errText(err) });
    }
    this.session = null;
    // 解掉全部在途凭据请求：它们的 resolver 会随进程一起消失，不解则 pi 侧永久挂起。
    for (const [, pending] of this.pendingCredentials) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingCredentials.clear();

    // reply 先发：主进程的两段式 kill 靠它确认「worker 收到了」，晚发会让它白等一轮宽限。
    this.reply(id, true);

    // 等清理跑完再退，但**必须有上界**——主进程 3s 后 SIGKILL，卡在这里就等于没清理还挨一刀。
    const grace = this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    if (grace > 0) await Promise.race([this.disposeSettled, delay(grace)]);
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
      // 丢一条消息远好过让 worker 崩掉（那会被主进程报成 crashed，整会话失效）。
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
