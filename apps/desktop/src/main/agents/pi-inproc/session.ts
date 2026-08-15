// pi in-process 会话层：`createAgentSession()` 的封装，实现 `PiSessionEngine` 契约。
// 引擎收敛后它的宿主是 **gateway worker**（`worker/pi-host/host.ts` 持有本类实例），
// 主进程经 `pi-gateway/client.ts` 的 RPC 与之通信；渲染端契约（R1）不变。
//
// ── 这一层到底做了什么 ────────────────────────────────────────────────────────────────
// 历史路径：`spawn(pi --mode rpc)` 二进制 → 手抄 JSONL 协议 → stdin 写命令 / stdout 读事件。
// 现路径：直接持有 `AgentSession`，命令 = 方法调用，事件 = `subscribe()` 回调。
// 「删掉进程边界」是那次迁移的全部内容，**不是**重写 pi 集成：下面每个方法都能在
// pi-coding-agent 0.82.1 的 `modes/rpc/rpc-mode.js` 里找到逐条对应的 case，行为按那份实现对齐。
//
// ── 旧二进制 `buildRpcArgs()` 的每个 CLI flag 在本层的对应物（迁移时逐条核对过）────────
// | CLI flag                  | in-process 对应                                                  |
// |---------------------------|------------------------------------------------------------------|
// | `--mode rpc`              | 无：本层直接调用 AgentSession 方法，没有 RPC 传输层               |
// | `--no-extensions`         | `resourceLoaderOptions.noExtensions = true`（恒为 true，见下）    |
// | `-e <path>` / `-a`        | `extensionFactories`（原生 InlineExtension）+ `customTools`；      |
// |                           | 不再生成 .js 扩展文件，故信任门（`-a`）连同落盘密钥一起消失（U3） |
// | `--no-skills`             | `resourceLoaderOptions.noSkills = req.useOwnSkills !== true`      |
// | `--skill <p>`             | `resourceLoaderOptions.additionalSkillPaths`                      |
// | `--tools a,b,c`           | `tools` 初值 + 运行时 `setActiveToolsByName()`（见 tools.ts）      |
// | `--provider <id>`         | `modelRuntime`（由 U3 的 providers/pi-inproc-models.ts 注入）      |
// | `--model <id>`            | `model`（同上，经 `deps.resolveModel` 解析，本层不做 provider 解析）|
// | `--append-system-prompt`  | `resourceLoaderOptions.appendSystemPrompt: [值]`                  |
// | `--thinking <level>`      | `thinkingLevel` 初值 + 运行时 `setThinkingLevel()`                 |
//
// `noExtensions` 恒为 true 的理由与旧路径 `--no-extensions` 一致：Cortex 只注入自己那批能力，
// 绝不让 pi 去用户目录自动发现并加载任意扩展（那是一条未经审计的代码执行路径）。
//
// ── 进程隔离消失：本层的异常边界（迁移计划最高风险项）────────────────────────────────
// 旧路径 pi 崩溃只死一个子进程；in-process 后未捕获异常会直接打到主进程。这里有四道闸：
//   1. **命令边界**：每个命令方法都经 `run()` 包裹，异常一律转成 `{success:false,error}`，
//      与旧路径「命令级失败走 response.success=false」逐字同义 —— `pi-session.ts` 的 `command()`
//      把它转成 IPC rejection，渲染端行为完全不变。
//   2. **事件边界**：`AgentSession._emit()` 对监听器没有 try/catch（已核源码），监听器抛错会冒进
//      pi 的 agent loop。事件泵（events.ts）保证 `handle()` 永不抛。
//   3. **轮次边界**：`session.prompt()` 是 fire-and-forget（ack 走 preflight），它 ack 之后再 reject
//      不会被任何人接住 → 主进程 unhandledRejection，且 renderer 永久卡「思考中」。这里显式
//      `.catch()` 并补发 `{type:"error"}` 终态。
//   4. **会话隔离**：一个会话的 `stop()` 必须解掉全部挂起的 UI 对话框与订阅，否则它持有的
//      agent loop 栈会永久留在主进程里（旧路径杀进程就自动清了）。
// 这四道闸都在**会话粒度**，一个会话炸掉不会拖垮主进程或同批其它会话（U6 的并发场景依赖这点）。

import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createPiEventPump, isAgentTurnEvent } from "./events";
import { loadPiCodingAgent, type PiCodingAgentModule } from "./runtime";
import { applyActiveTools, resolveToolWhitelist } from "./tools";
import { createPiUiBridge, type PiUiBridge } from "./ui-context";
import { slashCommandName, type PiImageContent, type RpcResponse, type RpcSlashCommandSource } from "./rpc-shared";
import { recordAgentTrace } from "../../ipc/agent-trace";
import { createLogger } from "../../log";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "../../ipc/types";

const log = createLogger("pi-inproc");

// 扩展命令(/cmd)收尾宽限。与 pi-rpc.ts 的同名常量同值同义：pi 对扩展命令即时执行后返回、
// **不跑 agent**（永不发 agent_end/agent_settled），必须同步补发 result + settled，否则 renderer
// 无法在保留自动 follow-up 语义的同时结束这类普通命令。
const EXT_COMMAND_FINALIZE_GRACE_MS = 1_500;

// ── 对外契约 ──────────────────────────────────────────────────────────────────────────

/**
 * pi 会话引擎的对外契约。`PiInProcSession`（本层，跑在 gateway worker 内）与
 * `PiGatewaySession`（主进程客户端）同形，`ipc/pi-session.ts` 只依赖这个接口。
 *
 * 返回值刻意沿用 `RpcResponse`（而不是换成更「干净」的 Result 类型）：`pi-session.ts` 的
 * `command()` 已经按 `{success, data, error}` 解包并把失败转成 IPC rejection，换类型等于
 * 让渲染端契约跟着动，与 R1「IPC 契约保持不变」直接冲突。
 */
export interface PiSessionEngine {
  ready(opts?: { tries?: number; intervalMs?: number }): Promise<{ sessionId: string; sessionFile?: string }>;
  loadSlashCommands(): Promise<void>;
  prompt(message: string, runId?: string, images?: PiImageContent[]): Promise<RpcResponse>;
  steer(message: string): Promise<RpcResponse>;
  followUp(message: string): Promise<RpcResponse>;
  abort(): Promise<RpcResponse>;
  fork(entryId: string): Promise<RpcResponse>;
  getForkMessages(): Promise<RpcResponse>;
  setModel(provider: string, modelId: string): Promise<RpcResponse>;
  setThinkingLevel(level: string): Promise<RpcResponse>;
  compact(customInstructions?: string): Promise<RpcResponse>;
  getState(): Promise<RpcResponse>;
  getSessionStats(): Promise<RpcResponse>;
  newSession(parentSession?: string): Promise<RpcResponse>;
  switchSession(sessionPath: string): Promise<RpcResponse>;
  getLastAssistantText(): Promise<RpcResponse>;
  getCommands(): Promise<RpcResponse>;
  respondUi(id: string, payload: PiUiResponsePayload): void;
  stop(): void;
}

/** 模型与 Provider 的解析结果。由 U3 的 `providers/pi-inproc-models.ts` 产出。 */
export interface PiInProcModelSelection {
  /** pi 的 `ModelRuntime`：承载 Provider 注册表与凭据。缺省则由 pi 自建（读 `~/.pi/agent/auth.json`）。 */
  modelRuntime?: unknown;
  /** pi 的 `Model<Api>`：会话初始模型。缺省则由 pi 按 settings/首个可用模型兜底。 */
  model?: unknown;
}

/**
 * 模型解析注入点（**本层刻意不实现 provider 解析**）。
 *
 * 为什么留成注入点而不是在这里做：Cortex 的 provider 解析是三段式（Catalog → 自定义 → 响亮失败），
 * 涉及 safeStorage 金库、baseUrl 覆盖偏好与自定义供应商注册表，那一整套已经在 `providers/` 下，
 * 由并行的 U3 适配到 pi 的 `ModelRuntime`。本层只负责把结果塞进 `createAgentSession`。
 */
export type PiInProcModelResolver = (req: PiOpenRequest) => Promise<PiInProcModelSelection>;

/** 会话构造的可注入依赖。除 `resolveModel` 外都有安全默认值。 */
export interface PiInProcDeps {
  /** 模型/Provider 解析（U3 注入）。缺省时 pi 走自己的默认链 —— 见 `openPiInProcSession` 的告警。 */
  resolveModel?: PiInProcModelResolver;
  /** 原生注册的自定义工具（MCP 桥 / capabilities / todo / askquestion，U3 填充）。 */
  customTools?: ToolDefinition[];
  /** 原生内联扩展（审批 hook 等，U3 填充）。取代旧路径「生成 .js 文件 + `-e` 加载」。 */
  extensionFactories?: unknown[];
  /**
   * 磁盘上已安装的 pi extension 路径（等价旧路径的 `-e <path>`），透传给
   * `resourceLoaderOptions.additionalExtensionPaths`。
   *
   * 为什么单列一个槽而不是塞进 `extensionFactories`：`pi-computer-use` 这类第三方能力是
   * `pi install` 装到 `~/.pi` 的**磁盘包**，不是我们自己的对象——SDK 侧由 DefaultResourceLoader
   * 经 jiti 加载（能吃 .ts/.js 与 package.json 的 `pi.extensions` 清单），我们没有理由去重造加载器。
   *
   * ⚠️ 与 `noExtensions: true` 并不冲突：实测 SDK 实现里 `noExtensions` 只是让
   * `extensionPaths = cliEnabledExtensions`（即**只**取本字段解析出来的那批），屏蔽的是「自动发现」，
   * 显式路径照常加载。这与 CLI 侧「`--no-extensions` 与显式 `-e` 共存」是同一套语义。
   */
  additionalExtensionPaths?: string[];
  /** pi 全局配置目录。缺省 `~/.pi/agent`（与 CLI 同源，保证 `pi install` 装的包能被找到）。 */
  agentDir?: string;
  /** 会话 JSONL 落盘目录。缺省由 pi 按 cwd 推导（与 CLI 同源，`sessionFile` 语义不变）。 */
  sessionDir?: string;
  /** 包加载器注入点（单测替身）。 */
  loadModule?: () => Promise<PiCodingAgentModule>;
  /**
   * 会话停止时要一并释放的**外部**资源（当前是 MCP 桥：stdio 子进程 + 在途 HTTP）。
   *
   * 由引擎在 `stop()` 里统一调用，而不是让调用方各自包装 `stop()`——后者既会破坏
   * `PiSessionEngine` 的方法身份（测试里 stop 不再是同一个函数），也必然在某条清理路径上漏调。
   * 失败只记日志：释放失败不该阻断「会话已停止」这个事实。
   */
  onDispose?: () => Promise<void> | void;
}

export interface PiInProcOpenOptions {
  request: PiOpenRequest;
  /** 归一化事件出口（`pi-session.ts` 转成 `pi:event`）。 */
  onEvent: (ev: PiSessionEvent, runId?: string) => void;
  /** 需用户回写的 UI 请求出口（`pi-session.ts` 转成 `pi:uiRequest`）。 */
  onUiRequest?: (req: PiUiRequest) => void;
  /**
   * 会话对象已构造、但 `rebind()` / `session_start` 尚未完成。
   *
   * gateway worker 必须在这个时点先登记临时回写句柄：市场扩展可在
   * `session_start` 里 `await ctx.ui.confirm()`，若等 open 返回后才登记，UI 应答就无处路由。
   */
  onSessionCreated?: (session: PiSessionEngine) => void;
  /** askquestion 借道的会话级 sentinel（与旧路径同义，见 ui-context.ts）。 */
  askQuestionSentinel?: string;
  /** javascript_repl 借道的会话级 sentinel（askQuestionSentinel 同轨，见 ui-context.ts）。 */
  jsReplSentinel?: string;
  deps?: PiInProcDeps;
}

// ── 应答构造 ──────────────────────────────────────────────────────────────────────────

/**
 * 把命令返回值净化成可结构化克隆的纯 JSON 值。
 *
 * 旧路径的 `data` 天然是 `JSON.parse(line)` 的产物，一定能过 `webContents.send` 的
 * structured clone；in-process 拿到的是**活对象**（`Model`、`CompactionResult`、`SessionStats`…），
 * 里面一旦混进函数/class 实例/循环引用，`pi:getState` 之类就会在 IPC 层抛 "could not be cloned"，
 * 堆栈里完全看不到 pi。这里做一次 JSON 往返把差异抹平，恢复与旧路径一致的序列化语义。
 */
function toIpcSafe(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(data)) as unknown;
  } catch (err) {
    log.warn("pi 命令返回值无法序列化，已降级为 undefined", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** 成功应答。`id` 刻意不填：in-process 没有请求关联的概念，调用方也只读 success/data/error。 */
function ok(command: string, data?: unknown): RpcResponse {
  const safe = toIpcSafe(data);
  return safe === undefined
    ? { type: "response", command, success: true }
    : { type: "response", command, success: true, data: safe };
}

/** 失败应答。与旧路径 `{type:"response",success:false,error}` 同形。 */
function fail(command: string, error: string): RpcResponse {
  return { type: "response", command, success: false, error };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 会话实现 ──────────────────────────────────────────────────────────────────────────

/**
 * 一个 in-process pi 会话。生命周期与旧路径的一个 pi 子进程等价：
 * `openPiInProcSession()` 建、`stop()` 销，中途经方法调用下发命令、经 `onEvent` 上报事件。
 *
 * 线程/并发模型：pi 的 agent loop 与本类都跑在主进程的同一个事件循环上，所有回调天然串行，
 * 因此内部状态（currentRunId / slash* 标志）不需要锁；但也正因如此，**任何在回调里抛出的异常
 * 都会打断 pi 的循环** —— 见文件头「异常边界」四道闸。
 */
export class PiInProcSession implements PiSessionEngine {
  /** 当前 AgentSession。fork / switchSession / newSession 会换实例，故不是 readonly。 */
  private session: AgentSession;
  private unsubscribe?: () => void;
  private stopped = false;

  /** 当前轮的 runId（Cortex 自造，prompt 时绑定）。事件回带它，renderer 据此丢弃迟到/串台事件。 */
  private currentRunId?: string;

  // 扩展命令收尾跟踪（见 EXT_COMMAND_FINALIZE_GRACE_MS）。语义与 pi-rpc.ts 逐条一致。
  private slashSawAgentEvent = false;
  private slashSawNotify = false;
  private slashFinalizeTimer?: ReturnType<typeof setTimeout>;
  /** 斜杠命令名 → 来源。undefined = 未就绪/拉取失败，此时 prompt() 退回纯宽限窗兜底（旧行为）。 */
  private slashCommandSources?: Map<string, RpcSlashCommandSource>;

  private readonly pump: ReturnType<typeof createPiEventPump>;

  constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly uiBridge: PiUiBridge,
    private readonly onEvent: (ev: PiSessionEvent, runId?: string) => void,
    private readonly uiSessionId: string,
    /**
     * 本会话 open 时的工作目录（`PiOpenRequest.cwd`，已过主进程 resolveSpawnCwd 归一）。
     * 恢复链路要用它压过 JSONL header 里的历史 cwd —— 见 `switchSession`。
     */
    private readonly cwd: string,
    /** 外部资源释放钩子，见 `PiInProcDeps.onDispose`。 */
    private readonly onDispose?: () => Promise<void> | void,
  ) {
    this.session = runtime.session;
    this.pump = createPiEventPump({
      onEvent: (ev, runId) => this.dispatchEvent(ev, runId),
      getRunId: () => this.currentRunId,
      isStopped: () => this.stopped,
      // 事件泵内部故障**不**上报 crashed：单条事件映射失败不代表会话不可用，
      // 上报 crashed 会让 pi-session.ts 摘除注册表条目，把一次可恢复的小故障放大成整会话失效。
      onFault: (err) => log.warn("pi 事件泵故障（会话继续）", { error: errText(err) }),
    });
  }

  /** 绑定/重绑当前 AgentSession（首次 open 与每次 fork/switch/new 之后各一次）。 */
  async rebind(): Promise<void> {
    this.session = this.runtime.session;
    // uiContext 的 cast 集中在这一处：见 ui-context.ts 关于「不逐个实现 TUI 专属成员」的说明。
    await this.session.bindExtensions({
      uiContext: this.uiBridge.context as ExtensionUIContext,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: async (options) => this.runtime.newSession(options),
        fork: async (entryId, forkOptions) => {
          const result = await this.runtime.fork(entryId, forkOptions);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await this.session.navigateTree(targetId, options ?? {});
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
        reload: async () => {
          await this.session.reload();
        },
      },
      // 扩展请求关停宿主：Cortex 的会话生命周期由 renderer 掌握，这里只记日志，不真的退进程
      //（旧路径 pi 子进程自行 exit → crashed；in-process 若照做就是把主进程杀了）。
      shutdownHandler: () => {
        log.warn("pi 扩展请求关闭会话（in-process 下忽略）", { uiSessionId: this.uiSessionId });
      },
      onError: (err) => {
        log.warn("pi 扩展错误", { event: err.event, error: String(err.error) });
      },
    });
    this.unsubscribe?.();
    this.unsubscribe = this.pump.attach(this.session);
  }

  // ── 事件出口 ────────────────────────────────────────────────────────────────────────

  /** 事件出口的唯一收口：顺带维护「扩展命令补发收尾」的取消条件。 */
  private dispatchEvent(ev: PiSessionEvent, runId?: string): void {
    if (isAgentTurnEvent(ev)) {
      this.slashSawAgentEvent = true;
      this.clearSlashFinalizeTimer();
    }
    this.onEvent(ev, runId);
  }

  /** notify 是 fire-and-forget，走事件通道而非对话框队列（与旧路径同决策）。 */
  private emitNotify(message: string, level: "info" | "warning" | "error"): void {
    this.slashSawNotify = true;
    this.dispatchEvent({ type: "notify", message, level }, this.currentRunId);
  }

  /** 供 `openPiInProcSession` 把 notify 出口接到 UI 桥上（构造顺序所迫，故留成内部方法）。 */
  notifySink(): (message: string, level: "info" | "warning" | "error") => void {
    return (message, level) => this.emitNotify(message, level);
  }

  // ── 命令边界 ────────────────────────────────────────────────────────────────────────

  /**
   * 命令包裹器（异常边界第 1 道闸）。
   * 任何抛出都转成 `{success:false}`，与旧路径「命令级失败」同义，绝不冒泡成主进程未捕获异常。
   */
  private async run(command: string, fn: () => Promise<unknown> | unknown): Promise<RpcResponse> {
    if (this.stopped) return fail(command, "pi 会话已停止退出");
    try {
      return ok(command, await fn());
    } catch (err) {
      log.warn("pi 命令失败", { command, error: errText(err) });
      return fail(command, errText(err));
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────────────

  /**
   * 就绪探测。in-process 下会话在 `openPiInProcSession` 返回时就已就绪，故这里是**同步事实**，
   * 不再轮询 `get_state`（旧路径冷启动 ~790ms 的等待随进程边界一起消失）。
   * 参数保留只为与 `PiRpcSession.ready()` 同签名，便于选路层不写分支。
   */
  async ready(): Promise<{ sessionId: string; sessionFile?: string }> {
    if (this.stopped) throw new Error("pi 会话已停止退出");
    const sessionId = this.session.sessionId;
    if (!sessionId) throw new Error("pi 会话就绪失败：缺少 sessionId");
    const sessionFile = this.session.sessionFile;
    return sessionFile ? { sessionId, sessionFile } : { sessionId };
  }

  /**
   * 拉取并缓存斜杠命令表。失败静默降级为「无缓存」—— 此时 prompt() 退回纯宽限窗兜底，
   * 与旧路径一致，绝不因为这一步失败而阻断会话可用性。
   */
  async loadSlashCommands(): Promise<void> {
    try {
      const resp = await this.getCommands();
      if (!resp.success) return;
      const list = (resp.data as { commands?: Array<{ name?: unknown; source?: unknown }> } | undefined)?.commands;
      if (!Array.isArray(list)) return;
      const map = new Map<string, RpcSlashCommandSource>();
      for (const c of list) {
        if (typeof c?.name !== "string" || typeof c?.source !== "string") continue;
        map.set(c.name, c.source as RpcSlashCommandSource);
      }
      this.slashCommandSources = map;
    } catch {
      // 保持 undefined，走宽限窗兜底。
    }
  }

  /** 主动停止：解订阅、解挂起对话框、释放 pi 运行时。幂等。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearSlashFinalizeTimer();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // 解锁所有挂起对话框：不解的话它们持有的 pi execute 栈会永久留在主进程里（异常边界第 4 道闸）。
    this.uiBridge.cancelAll();
    // dispose 会跑扩展的 session_shutdown 钩子，可能是异步的；失败不影响会话已被摘除的事实。
    void this.runtime.dispose().catch((err) => log.warn("pi 会话释放失败", { error: errText(err) }));
    // 调用方注入的外部资源释放（当前是 MCP 桥的 stdio 子进程与在途 HTTP）。
    // 放在引擎内部而不是让每个调用方包装 stop()：调用方那边停会话的路径有五六处
    //（重开 / 渲染端销毁 / ready 失败 / 主动关闭 / crashed / 编排 settle），逐处补调必漏一处，
    // 而漏掉的表现是连接静默泄漏、越积越多。这里是唯一收口。
    void Promise.resolve(this.onDispose?.()).catch((err) =>
      log.warn("pi 会话外部资源释放失败", { error: errText(err) }),
    );
    // scope 沿用 "pi"（AgentTraceEvent 的封闭联合，不为本次迁移扩张 IPC 契约 —— R1）；
    // 是哪条引擎路径由 summary 与 data.engine 区分。
    recordAgentTrace({
      scope: "pi",
      phase: "exit",
      summary: "pi in-process 会话停止",
      sessionId: this.uiSessionId,
      agent: "pi",
    });
  }

  // ── 提示与队列 ──────────────────────────────────────────────────────────────────────

  /**
   * 发一轮提示。
   *
   * 与旧路径同义：应答是**受理 ack**（毫秒级），不是任务完成；一轮 run 的结束由 `agent_end`
   * 事件（映射为 `{type:"result"}`）经事件流单独表达。in-process 下 ack 来自 pi 的
   * `preflightResult` 回调 —— 这正是 `pi --mode rpc` 自己用的那个钩子，语义逐字相同。
   *
   * 异常边界第 3 道闸：`session.prompt()` 是 fire-and-forget，ack 之后再 reject 就没人接住了
   *（→ 主进程 unhandledRejection + renderer 永久卡「思考中」）。故 ack 后的 reject 补发
   * `{type:"error"}` 作为终态（error 事件在渲染侧自带收尾路径）。
   */
  prompt(message: string, runId?: string, images?: PiImageContent[]): Promise<RpcResponse> {
    if (this.stopped) return Promise.resolve(fail("prompt", "pi 会话已停止退出"));
    if (runId !== undefined) this.currentRunId = runId;
    const isSlash = this.needsExtensionCommandFinalize(message);
    this.clearSlashFinalizeTimer();
    this.slashSawAgentEvent = false;
    this.slashSawNotify = false;
    const rid = runId ?? this.currentRunId;

    return new Promise<RpcResponse>((resolve) => {
      let settled = false;
      const settle = (resp: RpcResponse): void => {
        if (settled) return;
        settled = true;
        resolve(resp);
      };
      void this.session
        .prompt(message, {
          ...(images?.length ? { images } : {}),
          source: "rpc",
          preflightResult: (didSucceed) => {
            if (!didSucceed) return; // 失败路径紧跟着会 throw，由下面的 catch 统一结算
            settle(ok("prompt"));
            if (isSlash) this.scheduleExtensionCommandFinalize(rid);
          },
        })
        .then(() => {
          // 兜底：理论上每条路径都会调 preflightResult，但 pi 里存在一条 `if (!messages) return`
          // 的防御分支。真走到那里而不结算的话，renderer 的 invoke 会永久挂起。
          settle(ok("prompt"));
        })
        .catch((err: unknown) => {
          if (!settled) {
            settle(fail("prompt", errText(err)));
            return;
          }
          log.warn("pi 轮次在受理后失败（已补发 error 终态）", { error: errText(err) });
          this.dispatchEvent({ type: "error", error: errText(err) }, rid);
        });
    });
  }

  steer(message: string): Promise<RpcResponse> {
    return this.run("steer", () => this.session.steer(message));
  }

  followUp(message: string): Promise<RpcResponse> {
    return this.run("follow_up", () => this.session.followUp(message));
  }

  abort(): Promise<RpcResponse> {
    return this.run("abort", () => this.session.abort());
  }

  // ── 会话树 ──────────────────────────────────────────────────────────────────────────

  /** 从某条历史消息分叉出新会话文件。成功后必须 rebind（AgentSession 实例已被换掉）。 */
  fork(entryId: string): Promise<RpcResponse> {
    return this.run("fork", async () => {
      const result = await this.runtime.fork(entryId);
      if (!result.cancelled) await this.rebind();
      return { text: result.selectedText, cancelled: result.cancelled };
    });
  }

  getForkMessages(): Promise<RpcResponse> {
    return this.run("get_fork_messages", () => ({ messages: this.session.getUserMessagesForForking() }));
  }

  newSession(parentSession?: string): Promise<RpcResponse> {
    return this.run("new_session", async () => {
      const result = await this.runtime.newSession(parentSession ? { parentSession } : undefined);
      if (!result.cancelled) await this.rebind();
      return result;
    });
  }

  /**
   * 从磁盘 JSONL 恢复会话（崩溃/空闲/LRU/重启恢复）。cwd 缺失等由 run() 转成 success:false。
   *
   * **必须传 `cwdOverride`**：pi 的 `switchSession` 默认拿 JSONL header 里记的 cwd 重建运行时
   * （`sessionManager.getCwd()`），那是**会话文件创建当时**的目录。它与 Cortex 的真相不一致——
   * 用户可能已把会话挪到别的项目，历史档甚至可能是早年空 cwd 落在程序目录时写的。不覆盖的话，
   * 恢复后系统提示里的 `Current working directory` 就是个陈旧值，模型据此检索必然跑偏。
   * 单发路径早已显式传 cwd 防这一手（见 oneshot.ts 的 SessionManager.open 第三参），长驻会话
   * 此前漏了。
   */
  switchSession(sessionPath: string): Promise<RpcResponse> {
    return this.run("switch_session", async () => {
      const result = await this.runtime.switchSession(sessionPath, { cwdOverride: this.cwd });
      if (!result.cancelled) await this.rebind();
      return result;
    });
  }

  // ── 状态与配置 ──────────────────────────────────────────────────────────────────────

  /** 字段集合与 pi rpc-mode 的 `get_state` 逐条对齐（`sessionFile` 是恢复链路的关键字段）。 */
  getState(): Promise<RpcResponse> {
    return this.run("get_state", () => ({
      model: this.session.model,
      thinkingLevel: this.session.thinkingLevel,
      isStreaming: this.session.isStreaming,
      isCompacting: this.session.isCompacting,
      steeringMode: this.session.steeringMode,
      followUpMode: this.session.followUpMode,
      sessionFile: this.session.sessionFile,
      sessionId: this.session.sessionId,
      sessionName: this.session.sessionName,
      autoCompactionEnabled: this.session.autoCompactionEnabled,
      messageCount: this.session.messages.length,
      pendingMessageCount: this.session.pendingMessageCount,
    }));
  }

  getSessionStats(): Promise<RpcResponse> {
    return this.run("get_session_stats", () => this.session.getSessionStats());
  }

  getLastAssistantText(): Promise<RpcResponse> {
    return this.run("get_last_assistant_text", () => ({ text: this.session.getLastAssistantText() }));
  }

  /** 切模型。先在 `modelRuntime` 里按 provider+id 找，找不到就响亮失败——绝不让 pi 兜底换模型。 */
  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.run("set_model", async () => {
      const models = await this.session.modelRuntime.getAvailable();
      const model = models.find((m) => m.provider === provider && m.id === modelId);
      if (!model) throw new Error(`模型不存在: ${provider}/${modelId}`);
      await this.session.setModel(model);
      return model;
    });
  }

  setThinkingLevel(level: string): Promise<RpcResponse> {
    // level 由 renderer 传入，pi 的 ThinkingLevel 是字面量联合；越界值 pi 内部会 clamp 到模型能力，
    // 故这里只做类型穿透，不自建映射表（与 providers 侧「不维护 Cortex 自己的能力映射表」同原则）。
    return this.run("set_thinking_level", () =>
      this.session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]),
    );
  }

  compact(customInstructions?: string): Promise<RpcResponse> {
    return this.run("compact", () => this.session.compact(customInstructions));
  }

  /**
   * 运行时切工具集（旧路径没有的能力：pi 无对应 RPC 命令，切 plan 档必须重开会话）。
   * 这是 in-process 的一个用户可感知收益，接线在 U3/U6，本层先把能力露出来。
   */
  setActiveTools(toolWhitelist: string[] | undefined): Promise<RpcResponse> {
    return this.run("set_active_tools", () => applyActiveTools(this.session, toolWhitelist));
  }

  /** 可用斜杠命令表（含 source: extension|prompt|skill）。字段与 pi rpc-mode 的 `get_commands` 一致。 */
  getCommands(): Promise<RpcResponse> {
    return this.run("get_commands", () => {
      const commands: Array<{ name: string; description?: string; source: RpcSlashCommandSource }> = [];
      for (const cmd of this.session.extensionRunner.getRegisteredCommands()) {
        commands.push({ name: cmd.invocationName, description: cmd.description, source: "extension" });
      }
      for (const template of this.session.promptTemplates) {
        commands.push({ name: template.name, description: template.description, source: "prompt" });
      }
      for (const skill of this.session.resourceLoader.getSkills().skills) {
        commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill" });
      }
      return { commands };
    });
  }

  // ── 扩展 UI ─────────────────────────────────────────────────────────────────────────

  /** renderer 的对话框应答回填。停止后静默丢弃（与旧路径 `respondUi` 的 stopped 守卫同义）。 */
  respondUi(id: string, payload: PiUiResponsePayload): void {
    if (this.stopped) return;
    this.uiBridge.respond(id, payload);
  }

  // ── 扩展命令补发收尾（与 pi-rpc.ts 同源）──────────────────────────────────────────

  /**
   * 本次 prompt 是否需要「扩展命令补发收尾」跟踪。三态判定与 `PiRpcSession` 逐条一致：
   *   · 非 / 开头 → false（普通 prompt 走正常 agent_end 收尾）
   *   · 命中缓存且 source=prompt|skill → false（这两类会展开成真实 agent 轮次，有 agent_end）
   *   · 命中缓存且 source=extension，或缓存未就绪 / 不在缓存里 → true（保留宽限窗兜底）
   */
  private needsExtensionCommandFinalize(message: string): boolean {
    const name = slashCommandName(message);
    if (!name) return false;
    const source = this.slashCommandSources?.get(name);
    return source !== "prompt" && source !== "skill";
  }

  /**
   * 扩展命令 ack 落定时（此刻 pi 的 handler 已跑完）判定是否补发 result + settled：
   *   - 已见 notify（命令有输出）且未见 agent 活动 → 确证扩展命令，立即补发；
   *   - 否则给一段宽限等 agent 活动（防 `/skill:` `/template` 展开后的 ack→agent_start 竞态），
   *     仍无则补发（覆盖无 notify 输出的扩展命令）。
   */
  private scheduleExtensionCommandFinalize(rid?: string): void {
    if (this.slashSawAgentEvent || this.stopped) return;
    const finalize = (): void => {
      this.slashFinalizeTimer = undefined;
      if (this.slashSawAgentEvent || this.stopped) return;
      log.debug("扩展命令补发 result + settled 收尾", { sawNotify: this.slashSawNotify });
      // 这类 extension command 根本不会启动 SDK agent loop，因此 SDK 不会产生 agent_settled。
      // renderer 以 settled 作为唯一可释放 runId/审批代际的权威终态；只补 result 会让普通
      // slash command 永久保持 running。两帧必须同步同序发出，不能用 renderer 定时窗猜测。
      this.onEvent({ type: "result", willRetry: false }, rid);
      this.onEvent({ type: "settled" }, rid);
    };
    if (this.slashSawNotify) finalize();
    else this.slashFinalizeTimer = setTimeout(finalize, EXT_COMMAND_FINALIZE_GRACE_MS);
  }

  private clearSlashFinalizeTimer(): void {
    if (this.slashFinalizeTimer) {
      clearTimeout(this.slashFinalizeTimer);
      this.slashFinalizeTimer = undefined;
    }
  }
}

// ── 构造入口 ──────────────────────────────────────────────────────────────────────────

/**
 * 建一个 in-process pi 会话。等价于旧路径的 `spawnPiRpc(buildRpcArgs(req)) + new PiRpcSession(...)`。
 *
 * 用 `createAgentSessionRuntime`（而不是裸 `createAgentSession`）的理由：`fork` / `switch_session` /
 * `new_session` 三个命令会**替换** AgentSession 实例，只有 runtime 持有重建工厂才做得到。
 * 工厂内部仍然是 `createAgentSessionFromServices` → `createAgentSession`，与 pi CLI 同一条路。
 */
export async function openPiInProcSession(options: PiInProcOpenOptions): Promise<PiInProcSession> {
  const { request: req, onEvent, onUiRequest, askQuestionSentinel, jsReplSentinel, deps = {} } = options;
  const mod = await (deps.loadModule ?? loadPiCodingAgent)();

  const cwd = req.cwd;
  const agentDir = deps.agentDir ?? mod.getAgentDir();
  const whitelist = resolveToolWhitelist(req);
  const selection = deps.resolveModel ? await deps.resolveModel(req) : {};

  // 响亮告警而非静默兜底（KTD5）：renderer 指定了模型却没有解析器，pi 会退回自己的默认模型链，
  // 用户以为在用选定模型、实际不是 —— 这正是 0.1.52 那类事故的形态。
  if (req.model && !selection.model) {
    log.warn("pi in-process：未解析出模型，pi 将使用自身默认模型链", {
      requested: req.model,
      providerId: req.providerId,
    });
  }
  if (whitelist.nonBuiltin.length) {
    log.debug("pi 工具白名单含非内建工具（需 U3 的 customTools 注册后才存在）", {
      tools: whitelist.nonBuiltin,
    });
  }

  const sessionManager = deps.sessionDir
    ? mod.SessionManager.create(cwd, deps.sessionDir)
    : mod.SessionManager.create(cwd);

  // 每次 cwd 切换 / 会话替换都会重跑这个工厂（fork / switch_session / new_session），
  // 因此上面解析出来的模型与工具白名单必须闭包捕获，不能只在首次构造时用一次。
  const createRuntime: CreateAgentSessionRuntimeFactory = async (factoryOptions) => {
    const services = await mod.createAgentSessionServices({
      cwd: factoryOptions.cwd,
      agentDir: factoryOptions.agentDir,
      ...(selection.modelRuntime
        ? { modelRuntime: selection.modelRuntime as Parameters<typeof mod.createAgentSessionServices>[0]["modelRuntime"] }
        : {}),
      resourceLoaderOptions: {
        // ↓ `--no-extensions`：只注入 Cortex 自己那批能力，绝不自动发现并执行用户目录里的任意扩展。
        noExtensions: true,
        // ↓ `--no-skills`：useOwnSkills===true 才放开 pi 原生 skill 发现（与 claude/codex 对齐）。
        noSkills: req.useOwnSkills !== true,
        // ↓ 逐个 `--skill <p>`：无论上面的开关如何，Cortex 已启用集合始终显式注入。
        ...(req.skillPaths?.length ? { additionalSkillPaths: req.skillPaths } : {}),
        // ↓ `--append-system-prompt`：pi 侧是数组，拼接后追加到系统提示尾部。
        ...(req.appendSystemPrompt ? { appendSystemPrompt: [req.appendSystemPrompt] } : {}),
        ...(deps.extensionFactories?.length
          ? {
              extensionFactories: deps.extensionFactories as NonNullable<
                Parameters<typeof mod.createAgentSessionServices>[0]["resourceLoaderOptions"]
              >["extensionFactories"],
            }
          : {}),
        // ↓ 逐个 `-e <path>`：磁盘上已安装的第三方 extension（如 pi-computer-use）。
        // 与上面的 noExtensions 并存——它屏蔽的是自动发现，显式路径照常加载（见 PiInProcDeps 注释）。
        ...(deps.additionalExtensionPaths?.length
          ? { additionalExtensionPaths: deps.additionalExtensionPaths }
          : {}),
      },
    });
    const created = await mod.createAgentSessionFromServices({
      services,
      sessionManager: factoryOptions.sessionManager,
      ...(factoryOptions.sessionStartEvent ? { sessionStartEvent: factoryOptions.sessionStartEvent } : {}),
      ...(selection.model
        ? { model: selection.model as Parameters<typeof mod.createAgentSessionFromServices>[0]["model"] }
        : {}),
      ...(req.thinkingLevel
        ? {
            thinkingLevel: req.thinkingLevel as Parameters<
              typeof mod.createAgentSessionFromServices
            >[0]["thinkingLevel"],
          }
        : {}),
      // ↓ `--tools a,b,c`：有白名单才收窄；缺省 = pi 默认（read/bash/edit/write + 扩展工具）。
      ...(whitelist.tools ? { tools: whitelist.tools } : {}),
      ...(deps.customTools?.length ? { customTools: deps.customTools } : {}),
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await mod.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });

  // 诊断（扩展加载失败 / provider 注册失败 / settings 解析错误）不阻断会话，但必须可见：
  // 静默丢弃会让「某个能力莫名不见了」变成无从下手的问题。
  for (const d of runtime.diagnostics) {
    if (d.type === "error") log.error("pi 会话诊断", { message: d.message });
    else log.warn("pi 会话诊断", { message: d.message });
  }
  if (runtime.modelFallbackMessage) {
    log.warn("pi 模型回退", { message: runtime.modelFallbackMessage });
  }

  // UI 桥与会话互相引用（桥要把 notify 交给会话、会话要把应答交给桥）：用一个后填的槽打破循环。
  // 槽为空的那段窗口内不可能有 notify —— pi 要等 `bindExtensions()` 才拿得到 uiContext，
  // 而那一步在 `session.rebind()` 里，晚于填槽。
  const notifySlot: { emit?: (message: string, level: "info" | "warning" | "error") => void } = {};
  const uiBridge = createPiUiBridge({
    ...(onUiRequest ? { onUiRequest } : {}),
    onNotify: (message, level) => notifySlot.emit?.(message, level),
    ...(askQuestionSentinel ? { askQuestionSentinel } : {}),
    ...(jsReplSentinel ? { jsReplSentinel } : {}),
  });

  const session = new PiInProcSession(runtime, uiBridge, onEvent, req.uiSessionId, cwd, deps.onDispose);
  notifySlot.emit = session.notifySink();
  // 必须早于 rebind：session_start handler 本身可能等待 UI 应答，调用方需先
  // 拿到 respondUi 句柄才能解锁它。此回调不表示 open 已完成，权威就绪点仍是下方 await。
  options.onSessionCreated?.(session);
  await session.rebind();

  recordAgentTrace({
    scope: "pi",
    phase: "open",
    summary: "pi in-process 会话建立",
    sessionId: req.uiSessionId,
    agent: "pi",
    data: {
      cwd,
      model: req.model ?? "(默认)",
      providerId: req.providerId,
      toolWhitelist: whitelist.tools?.length ?? 0,
      // 引擎收敛后 in-process 会话只剩 gateway worker 内这一种宿主，不再有选路来源可记。
      engine: "inproc",
    },
  });

  return session;
}
