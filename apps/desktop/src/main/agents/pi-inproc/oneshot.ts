// pi **单发路径**的 in-process 引擎（迁移计划 U5；引擎收敛后是单发的**唯一**路径）。
// 语义对应历史上二进制路径的 `spawn(<pi 二进制> --mode json -p … <prompt>)`：
// 一次调用 = 一轮对话 = 一次「进程」生命周期。
//
// ── 为什么长成「AgentProcess 垫层」而不是新写一条事件管线 ────────────────────────────────
// `ipc/cli.ts` 的流式管线（行缓冲 → `parseLineEvents` → `cli:event` → 看门狗 / 安全重试 /
// trace / 委派清理）对 claude / codex / pi 三家通用，整整 250 行且全是踩过坑攒出来的行为。
// 单发切 in-process 时，最不容易出错的做法是**只换掉产生 stdout 的那一端**：
//   本模块伪装成一个 `AgentProcess`，其 `stdout` 逐行吐出与 `pi --mode json` **逐字节同形**的
//   JSONL，交给 `piDef.parseLine` 原样解析。
// 于是：
//   · `CliStreamEvent` 契约天然不变 —— 事件仍由同一个 `parseLine` 产出，一行代码都没改；
//   · 那条 ⚠️ 陷阱（provider 失败仍 exit 0、错误只体现在最后一条 assistant `message_end` 的
//     `stopReason:"error"` 上）**自动继承**：result 依旧由 `parseLine` 从 message_end 发出，
//     本模块的退出码同样恒为 0，不会替 pi 「补」一个进程级失败信号去覆盖它（KTD5）；
//   · 取消 / 看门狗 / 安全重试 / stderr 归集 / delegate 清理全部零改动；
//   · `cli.ts` 的改动只有三处「选路一行」，不会把那个已 1500+ 行的文件撑得更大。
// 这条「事件对象 → JSON 行 → 再解析」的往返确实多一次序列化，但 pi 自己的 print-mode 就是
// `writeRawStdout(JSON.stringify(event))`（已核 0.82.1 `modes/print-mode.js`），我们只是把
// 同一个字符串在进程内交接。灰度期用这点开销换「行为逐字节可比」，是划算的。
//
// ── 这条路上的安全红线：**绝不注入 Computer Use** ──────────────────────────────────────
// `capabilities/computer-use/inject.ts` 的五门控里有一条产品级约束：只在**聊天 RPC 路径**注入。
// 单发路径（ask 追问 / 定时任务 / 编排子会话 / 委派子 agent）没有审批 UI，审批钩子在那里失效 ——
// 在无人看着的定时任务里放开鼠标键盘，等于让 Agent 无监督地操作用户电脑。
// 本模块因此：
//   1. **不 import** `capabilities/computer-use/*` 的任何东西（有守卫测试读源码断言，见 oneshot.test.ts）；
//   2. 能力来源只有调用方经 `PiOneShotOptions` 显式注入的 MCP 桥（native 注册）与 todo 工具——
//      **不再加载任何磁盘 extension**。旧路径经 `-e` 加载 cli.ts 落盘的桥接 .js，binary 删除后
//      落盘生成器（writeMcpBridgeExtension / writeTodoExtension）一并删除，`req.extraExtensionPaths`
//      （渲染端可传的 IPC 字段）在本模块被完全忽略，「主进程执行任意 JS」的入口从根上消失。
//
// ── 进程隔离消失后的异常边界 ───────────────────────────────────────────────────────────
// 二进制路径下 pi 崩溃只死一个子进程；in-process 后未捕获异常会打到主进程，且多个单发可以并发
// （委派 fanout / 编排子会话）。本模块的三道闸：
//   1. 事件回调 `emit()` **永不抛** —— 它跑在 pi 的 agent loop 栈上，抛出会打断整轮对话；
//   2. 整个 run 包在 try/catch/finally 里，失败转成「stderr + 非零退出码」或「onError」，
//      与子进程的两种失败形态一一对应；
//   3. `finally` 里恒调 `runtime.dispose()`，一个单发失败不会给主进程留下悬挂的 agent loop。
//
// ── KTD1 / KTD2 ────────────────────────────────────────────────────────────────────────
// 三个 pi 包是纯 ESM、主进程被打成 CJS，加载一律经 `runtime.ts` 的 `loadPiCodingAgent()`
//（变量 specifier + `@vite-ignore`）。本文件只用 `import type` 引 pi 的类型（编译期擦除），
// 且**不含 top-level await**（rollup 对 CJS 输出直接拒绝，构建期即失败）。

import { readFileSync } from "fs";
import { PassThrough } from "stream";

import type {
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createTodoTool } from "./native-hooks";
import { loadPiCodingAgent, type PiCodingAgentModule } from "./runtime";
import { planToolWhitelist, validatePiImages } from "../pi";
import { createMcpInProcTools } from "../pi-mcp-inproc";
import type { BridgeServer } from "../pi-mcp-bridge";
import { getPiInprocModelRuntime, resolvePiInprocModel } from "../../providers/pi-inproc-models";
import { createLogger } from "../../log";
import type { AgentProcess } from "../../ipc/cli";
import type { CliStartRequest } from "../../ipc/types";

const log = createLogger("pi-inproc-oneshot");

/** 中断后仍不收敛的兜底时限。对应二进制路径「SIGTERM 后 3s 再 SIGKILL」那道兜底。 */
const ABORT_GRACE_MS = 3_000;

/** pi 的多模态图片块（结构与 pi-ai 的 `ImageContent` 一致；此处只做结构化描述，不引运行时依赖）。 */
interface PiImageContentBlock {
  type: "image";
  data: string; // base64
  mimeType: string;
}

// ── 入口选项 ──────────────────────────────────────────────────────────────────────────

/**
 * 单发的能力注入选项。引擎收敛后没有选路开关：pi 的单发**只有**本模块这一条路，
 * 调用方（cli:start / cli:oneshot / ask / automation / workflow-headless / delegate 子 agent）
 * 按各自语义决定注入哪些能力——缺省一律「裸跑」，与旧 spawn 路径不带 `-e` 时的行为同义。
 */
export interface PiOneShotOptions {
  cwd: string;
  /**
   * 要桥接的 MCP server（delegate / design-delegate / slides / research / media-gen / loop）。
   * 只有 `cli:start` 的聊天单发填充；原生注册取代旧的「落盘桥接 .js + `-e`」交付形态。
   * stdio 子进程与在途 HTTP 由本模块在单发收尾时统一释放（见 runOneShot 的 finally）。
   */
  bridgeServers?: BridgeServer[];
  /**
   * 是否注册 todo_write 工具。仅 `cli:start` 聊天单发（非 design:/slides:/writing: 编排流）
   * 为 true，对齐旧 writeTodoExtension 的注入范围；其余单发路径不渲染 todo 卡，注入只会
   * 让模型白调工具。
   */
  todoTool?: boolean;
}

// ── AgentProcess 垫层 ─────────────────────────────────────────────────────────────────

/**
 * 伪装成子进程的 in-process 单发运行。语义逐条对齐 `wrapChild()` 包出来的真实 `AgentProcess`：
 *   · `stdout` —— 逐行 JSONL，与 `pi --mode json` 同形；
 *   · `stderr` —— 失败原因文本，`cli.ts` 收进 `stderrTail` 作为退出错误；
 *   · `onExit(code)` —— **stdout 读完之后**才触发（真子进程的 `close` 语义），否则最后几行事件
 *     会在 `cli.ts` 收尾清理监听器时被丢掉；
 *   · `onError(err)` —— 只用于「相当于 spawn 失败」的场景（pi 运行时加载不出来 / 会话建不起来），
 *     此时一行 stdout 都没产生过，与二进制路径的 ENOENT 形态一致；
 *   · `kill()` —— `session.abort()`，退出码用 `null` 冒充被信号杀死，让 `cli.ts` 的取消判定
 *     （`code === null`）与二进制路径走同一条分支。
 *   · `pid` —— 恒 `undefined`：没有进程。`cli.ts` 只在日志里用它。
 */
class PiOneShotProcess implements AgentProcess {
  readonly pid = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  private exitCb?: (code: number | null) => void;
  private errorCb?: (err: Error) => void;
  /** 终态载荷。先落这里再异步冲刷，避免「回调还没注册就终态了」而丢事件。 */
  private pending?: { kind: "exit"; code: number | null } | { kind: "error"; err: Error };
  private settled = false;
  private killed = false;
  /** 由 run 填入的中断钩子（`AgentSession.abort`）。会话建起来之前为空。 */
  private abortHook?: () => void;
  private abortTimer?: ReturnType<typeof setTimeout>;

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
    this.flush();
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
    this.flush();
  }

  /**
   * 取消。与真实 `kill()` 同义：先请 pi 停下（`abort()`），若它迟迟不收敛就强制结算 ——
   * 对应二进制路径「SIGTERM 先礼、3s 后 SIGKILL」的兜底。不加这道兜底的话，一个卡在
   * 上游长连接里的单发会让渲染端永远等不到 `cli:exit`。
   */
  kill(): void {
    if (this.killed || this.settled) return;
    this.killed = true;
    try {
      this.abortHook?.();
    } catch (err) {
      log.warn("pi 单发中断失败（已按取消结算）", { error: errText(err) });
    }
    this.abortTimer = setTimeout(() => this.finishExit(null), ABORT_GRACE_MS);
  }

  /** 是否已被取消。run 用它决定最终退出码（取消 → null，模拟被信号杀死）。 */
  isKilled(): boolean {
    return this.killed;
  }

  setAbortHook(fn: () => void): void {
    this.abortHook = fn;
  }

  /**
   * 推一行 JSONL。序列化失败（活对象里混进循环引用等）只丢这一行并记日志 ——
   * 丢一条事件远好过让异常冒进 pi 的 agent loop 把整轮对话打断。
   */
  pushEvent(event: unknown): void {
    if (this.settled) return;
    let line: string;
    try {
      line = JSON.stringify(event);
    } catch (err) {
      log.warn("pi 单发事件无法序列化（已丢弃该事件）", {
        error: errText(err),
        rawType: (event as { type?: unknown } | null)?.type,
      });
      return;
    }
    this.stdout.write(`${line}\n`);
  }

  /** 写 stderr（`cli.ts` 归集为 `stderrTail`，非零退出时作为错误文案）。 */
  pushStderr(text: string): void {
    if (this.settled) return;
    this.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** 正常收尾：关流，等 stdout 被读完后再报退出码。 */
  finishExit(code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.stderr.end();
    // 'end' 只在可读端被消费完后才触发，这正是我们要的「stdout 读完再 exit」语义。
    this.stdout.once("end", () => this.settle({ kind: "exit", code }));
    this.stdout.end();
    // 兜底：万一调用方没接 stdout（`readableFlowing !== true` = 既没有 data 监听也没有 pipe），
    // 'end' 永不触发 → 渲染端永远等不到 cli:exit。此时主动 resume 把数据排干。
    if (this.stdout.readableFlowing !== true) this.stdout.resume();
    if (this.stderr.readableFlowing !== true) this.stderr.resume();
  }

  /** spawn 级失败：一行 stdout 都没有过，走 `onError`（与二进制路径的 ENOENT 同形）。 */
  finishError(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.stdout.end();
    this.stderr.end();
    this.settle({ kind: "error", err });
  }

  private settle(payload: NonNullable<PiOneShotProcess["pending"]>): void {
    this.pending = payload;
    // 恒异步：调用方（cli.ts）在 startAgentProcess 返回后**同步**注册 onError/onExit，
    // 同步回调会在注册完成前就跑掉一半收尾逻辑。
    setImmediate(() => this.flush());
  }

  private flush(): void {
    const payload = this.pending;
    if (!payload) return;
    if (payload.kind === "error") {
      if (!this.errorCb) return;
      this.pending = undefined;
      this.errorCb(payload.err);
      return;
    }
    if (!this.exitCb) return;
    this.pending = undefined;
    this.exitCb(payload.code);
  }
}

/** 起一次 in-process 单发（pi 单发的唯一入口）。返回的对象立即可用，真正的运行在后台推进。 */
export function startPiInProcOneShot(req: CliStartRequest, opts: PiOneShotOptions): AgentProcess {
  const proc = new PiOneShotProcess();
  // 刻意不 await：调用方期待的是「spawn 立即返回一个句柄」。所有失败路径都在 runOneShot
  // 内部收敛成 finishExit / finishError，故这里的 catch 只是最后一道防线（绝不允许
  // 变成 unhandledRejection —— in-process 后那会直接打到主进程）。
  void runOneShot(req, opts, proc).catch((err: unknown) => {
    log.error("pi 单发运行未捕获异常", { error: errText(err) });
    proc.finishError(err instanceof Error ? err : new Error(String(err)));
  });
  return proc;
}

// ── 运行主体 ──────────────────────────────────────────────────────────────────────────

async function runOneShot(req: CliStartRequest, opts: PiOneShotOptions, proc: PiOneShotProcess): Promise<void> {
  const cwd = opts.cwd;
  let runtime: AgentSessionRuntime | undefined;
  // MCP 桥的释放钩子：stdio 子进程与在途 HTTP 不随会话对象被 GC，单发结束必须显式释放。
  let disposeMcp: (() => Promise<void>) | undefined;
  // 「已开始产出」的分界线：越过它之后的失败按「进程跑起来了但失败了」处理（stderr + 非零码），
  // 之前的失败按「spawn 失败」处理（onError）。这条线与二进制路径的 ENOENT / 非零退出一一对应。
  let started = false;

  try {
    const mod = await loadPiCodingAgent();
    // 图片校验必须在建会话之前：错误码/文案与二进制路径逐字相同（见 validatePiImages），
    // 且要在「什么都还没发生」时抛出，让上层拿到干净的 rejection。
    const images = readImageContents(req);
    const sessionManager = await openOneShotSessionManager(mod, cwd, req.resumeSessionId);
    const selection = await resolveOneShotModel(mod, req);
    // `--tools a,b,c`：只有 plan 只读档有意义。json 单发无 UI、审批钩子失效，
    // accept-edits / full-auto 在单发下等价（不收窄工具），与 `piDef.buildArgs` 同一判定。
    const tools = req.permissionMode === "plan" ? planToolWhitelist(req) : undefined;

    // 能力注入（取代旧的落盘 .js + `-e`）：todo 工具与 MCP 桥都以原生对象进 customTools。
    // MCP 单 server 失败只跳过该 server（createMcpInProcTools 内部保证不抛），整体失败降级为无桥。
    const customTools: ToolDefinition[] = [];
    if (opts.todoTool) customTools.push(createTodoTool());
    if (opts.bridgeServers?.length) {
      try {
        const bridge = await createMcpInProcTools(opts.bridgeServers);
        customTools.push(...bridge.tools);
        disposeMcp = () => bridge.dispose();
        if (bridge.failed.length) {
          log.warn(`pi 单发 MCP 接入失败 ${bridge.failed.length} 个: ${bridge.failed.map((f) => f.id).join("、")}`);
        }
      } catch (err) {
        log.warn("pi 单发 MCP 桥整体失败,本轮无 MCP 工具", { error: errText(err) });
      }
    }

    runtime = await createOneShotRuntime(mod, {
      cwd,
      req,
      sessionManager,
      selection,
      customTools,
      tools,
    });

    const session = runtime.session;

    // 第一行与 `pi --mode json` 完全一致：session header（`{type:"session", id, cwd, …}`），
    // 由 `piDef.parseLine` 映射成 `{type:"init", sessionId}`。渲染端靠它记住可续接的会话 id，
    // 漏发会让「编辑重发 / 续聊」静默退化成每轮新建会话。
    started = true;
    const header = sessionManager.getHeader();
    if (header) proc.pushEvent(header);

    // 事件泵。`AgentSession._emit()` 对监听器**没有** try/catch（已核 0.82.1 源码），
    // 这里抛出会直接打断 pi 的 agent loop —— 故 pushEvent 内部自带兜底，这层再包一次。
    const unsubscribe = session.subscribe((event: unknown) => {
      try {
        proc.pushEvent(event);
      } catch (err) {
        log.warn("pi 单发事件推送失败（已隔离，不影响 agent loop）", { error: errText(err) });
      }
    });
    proc.setAbortHook(() => {
      void session.abort();
    });

    try {
      // 与 print-mode 的调用逐条对齐：只发一条 initialMessage，不传 `source`
      //（print-mode 同样用默认值），images 走 SDK 原生入参而非 `@<path>` 文件参数。
      //
      // 二进制路径要给以 `@` 开头的 prompt 加一个前导空格（`escapeLeadingAt`），因为 pi 的
      // argv 解析会把 `@张三 …` 当成文件参数吞掉。in-process 没有 argv 这一层，
      // 故**原样传入**——少一个历史包袱，对模型而言两者无语义差异。
      await session.prompt(req.prompt, images.length ? { images } : undefined);
    } finally {
      unsubscribe();
    }

    // 退出码恒 0（除非被取消）。这正是那条 ⚠️ 陷阱的 in-process 版：provider 失败不体现在
    // 退出码上，只体现在最后一条 assistant `message_end` 的 `stopReason:"error"` 里，
    // 由 `piDef.parseLine` 发成 `{type:"result", ok:false}`。若在这里替 pi「补」一个非零码，
    // `cli.ts` 会把它当成可安全重试的失败而重跑一轮，用户会看到重复的失败提示（KTD5）。
    proc.finishExit(proc.isKilled() ? null : 0);
  } catch (err) {
    const message = errText(err);
    if (!started) {
      // 相当于 spawn 失败：pi 运行时加载不出来 / 模型解析不出来 / 会话建不起来。
      log.error("pi 单发启动失败", { error: message });
      proc.finishError(err instanceof Error ? err : new Error(message));
    } else {
      // 相当于「进程跑起来后失败」：错误文本走 stderr，退出码 1（与 print-mode 的
      // `catch { console.error(...); return 1; }` 同形）。
      log.error("pi 单发执行失败", { error: message });
      proc.pushStderr(message);
      proc.finishExit(proc.isKilled() ? null : 1);
    }
  } finally {
    // 进程边界消失后，不 dispose 就等于把这一轮的 agent loop、扩展与 MCP 连接永久留在主进程里。
    // 并发单发场景（委派 fanout / 编排子会话）尤其致命，故无论成败恒执行。
    if (runtime) {
      await runtime.dispose().catch((err: unknown) => {
        log.warn("pi 单发会话释放失败", { error: errText(err) });
      });
    }
    // MCP 桥独立释放：它不归 runtime 管（native 注入的 customTools 只是函数），漏掉即
    // stdio 子进程与在途 HTTP 随单发累积泄漏。
    if (disposeMcp) {
      await disposeMcp().catch((err: unknown) => {
        log.warn("pi 单发 MCP 桥释放失败", { error: errText(err) });
      });
    }
  }
}

// ── 会话构造 ──────────────────────────────────────────────────────────────────────────

interface OneShotRuntimeInput {
  cwd: string;
  req: CliStartRequest;
  sessionManager: SessionManager;
  selection: OneShotModelSelection;
  /** 原生注入的自定义工具（todo_write + MCP 桥），取代旧「落盘 .js + `-e`」交付形态。 */
  customTools: ToolDefinition[];
  tools?: string[];
}

/**
 * 建单发用的 `AgentSessionRuntime`。工厂内容逐条镜像 pi CLI 的 `main.js` + `print-mode.js`，
 * 每个 `buildArgs` 里的 flag 在这里都有对应物：
 *
 * | `piDef.buildArgs` 的 flag        | in-process 对应                                        |
 * |----------------------------------|--------------------------------------------------------|
 * | `--mode json -p`                 | 无：本模块直接订阅事件并 `JSON.stringify` 成 stdout 行 |
 * | `--no-extensions`                | `resourceLoaderOptions.noExtensions = true`            |
 * | `-e <path>` / `-a`               | `customTools`（原生对象注入，信任门 `-a` 不再需要，见下）|
 * | `--no-skills`                    | `noSkills = req.useOwnSkills !== true`                 |
 * | `--skill <p>`                    | `additionalSkillPaths`                                 |
 * | `--tools a,b,c`                  | `tools`（仅 plan 档）                                   |
 * | `--provider` / `--model`         | `modelRuntime` / `model`（见 resolveOneShotModel）      |
 * | `--session <id>`                 | `SessionManager.open/create`（见 openOneShotSessionManager）|
 * | `--append-system-prompt <s>`     | `resourceLoaderOptions.appendSystemPrompt: [s]`        |
 *
 * `-a`（`projectTrustOverride`）在这条路上无对应物也不需要：项目信任只闸**项目本地** `.pi/` 资源，
 * 而我们恒开 `noExtensions`，那些资源压根不加载；我们自己那批能力以原生 `customTools` 注入，
 * 不受信任门约束。二进制路径当年加 `-a` 是为了避免交互式信任提问卡住无 TTY 的子进程。
 *
 * 用 `createAgentSessionRuntime`（而非裸 `createAgentSession`）只为两件事：
 * 拿到规范的 `dispose()`，以及给 `bindExtensions` 提供 `commandContextActions` —— 与 print-mode 同构。
 */
async function createOneShotRuntime(
  mod: PiCodingAgentModule,
  input: OneShotRuntimeInput,
): Promise<AgentSessionRuntime> {
  const { cwd, req, sessionManager, selection, customTools, tools } = input;
  const agentDir = mod.getAgentDir();

  const createRuntime: CreateAgentSessionRuntimeFactory = async (factoryOptions) => {
    const services = await mod.createAgentSessionServices({
      cwd: factoryOptions.cwd,
      agentDir: factoryOptions.agentDir,
      modelRuntime: selection.modelRuntime,
      resourceLoaderOptions: {
        // ↓ `--no-extensions`：单发不加载任何磁盘扩展，绝不自动发现并执行用户目录里的
        //   任意扩展 —— in-process 下那等于在主进程里跑未经审计的代码。
        noExtensions: true,
        // ↓ `--no-skills`：useOwnSkills===true 才放开 pi 原生 skill 发现（与 claude/codex 对齐）。
        noSkills: req.useOwnSkills !== true,
        ...(req.skillPaths?.length ? { additionalSkillPaths: req.skillPaths } : {}),
        ...(req.appendSystemPrompt ? { appendSystemPrompt: [req.appendSystemPrompt] } : {}),
      },
    });
    const created = await mod.createAgentSessionFromServices({
      services,
      sessionManager: factoryOptions.sessionManager,
      ...(factoryOptions.sessionStartEvent ? { sessionStartEvent: factoryOptions.sessionStartEvent } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      ...(tools ? { tools } : {}),
      ...(customTools.length ? { customTools } : {}),
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await mod.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });

  // 诊断（扩展加载失败 / provider 注册失败 / settings 解析错误）不阻断本轮，但必须可见：
  // 静默丢弃会让「委派工具莫名不见了」变成无从下手的问题。
  for (const d of runtime.diagnostics) {
    if (d.type === "error") log.error("pi 单发会话诊断", { message: d.message });
    else log.warn("pi 单发会话诊断", { message: d.message });
  }

  // ⚠️ `bindExtensions` **不传 `uiContext`** —— 这是单发路径「无审批 UI」的落点，与 print-mode
  // 逐条一致（它同样只传 mode / commandContextActions / onError）。传了就等于给单发路径接上
  // 一个没有真实用户在看的审批回路，比不接更危险。
  await runtime.session.bindExtensions({
    mode: "json",
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      newSession: async (options) => runtime.newSession(options),
      fork: async (entryId, forkOptions) => {
        const result = await runtime.fork(entryId, forkOptions);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await runtime.session.navigateTree(targetId, options ?? {});
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
      reload: async () => {
        await runtime.session.reload();
      },
    },
    onError: (err) => {
      log.warn("pi 单发扩展错误", { event: err.event, error: String(err.error) });
    },
  });

  return runtime;
}

/**
 * `--session <id>` 的 in-process 对应物。
 *
 * pi CLI 在 id 找不到时是 `process.exit(1)`（无任何 JSON 输出 → 上层只看到一次空退出，正是
 * `pi.ts` 文件头记的那种「管线只看到空退出」的失败形态）。这里刻意**更宽容**：找不到就用该 id
 * 新建一个会话，等价于 CLI 的 `--session-id` 语义。理由是 `resumeSessionId` 来自渲染端持久化的
 * 会话记录，用户换机 / 清过 `~/.pi` 之后它必然对不上，而那时用户想要的显然是「接着聊」，
 * 不是「整轮静默失败」。
 */
async function openOneShotSessionManager(
  mod: PiCodingAgentModule,
  cwd: string,
  resumeSessionId: string | undefined,
): Promise<SessionManager> {
  const id = resumeSessionId?.trim();
  if (!id) return mod.SessionManager.create(cwd);
  const local = await mod.SessionManager.list(cwd);
  // 匹配顺序与 pi 的 `resolveSessionPath` 一致：先精确 id，再前缀。
  const match = local.find((s) => s.id === id) ?? local.find((s) => s.id.startsWith(id));
  if (match) return mod.SessionManager.open(match.path);
  log.warn("pi 单发续接：本地无此会话，改为以该 id 新建", { sessionId: id, cwd });
  return mod.SessionManager.create(cwd, undefined, { id });
}

// ── 模型与 Provider ───────────────────────────────────────────────────────────────────

interface OneShotModelSelection {
  /** 恒有值：它承载的是**整个注册表**（自定义 Provider + baseUrl 覆盖），不只被选中的那一个。 */
  modelRuntime: Awaited<ReturnType<typeof getPiInprocModelRuntime>>;
  /** 解析不出时留空，交给 pi 自己的默认模型链（与二进制路径不下发 `--model` 时同义）。 */
  model?: Parameters<PiCodingAgentModule["createAgentSessionFromServices"]>[0]["model"];
}

/**
 * `--provider` / `--model` 的 in-process 对应物。
 *
 * ⚠️ 这里**不用** `req.piExtensionPath`（`writePiExtension` 生成的 provider 扩展）。那个文件里
 * 的 apiKey 是 `$CORTEX_PI_KEY` 占位符，靠 `spawnEnvFor` 注入子进程环境变量才拿得到真值 ——
 * 进程边界一删就没有「子进程环境」这回事了，照旧加载只会得到一个空密钥的 provider，
 * 表现为「配置好了却报未认证」。改走 `providers/pi-inproc-models.ts` 的原生注册表（U3），
 * 密钥在请求那一刻从 safeStorage 金库解出，全程不落盘。
 *
 * `providerId` 的来源有两处：`cli:start` / `cli:oneshot` 直接给 `req.providerId`；
 * 委派子 agent 只继承了 `req.provider`（`runDelegateSubAgent` 不设 providerId），故要兜到
 * `req.provider.id` —— 它就是 `safeId(providerId)`，`resolvePiInprocModel` 内部会再 safeId 一次，幂等。
 */
async function resolveOneShotModel(
  mod: PiCodingAgentModule,
  req: CliStartRequest,
): Promise<OneShotModelSelection> {
  const providerId = (req.providerId ?? req.provider?.id)?.trim();
  if (providerId) {
    // 解析失败时**响亮抛错**（PiInprocProviderError），绝不退回 pi 的默认模型链：
    // 那会让用户以为在用选定的供应商、实际不是（0.1.52 那类事故的形态）。
    return resolvePiInprocModel({ providerId, modelId: req.model });
  }

  const modelRuntime = await getPiInprocModelRuntime();
  if (!req.model) return { modelRuntime };
  // 无 provider 时按 pi CLI 的 `--model <pattern>` 语义解析（支持 `provider/model` 与模糊匹配）。
  const resolved = mod.resolveCliModel({ cliModel: req.model, modelRuntime });
  if (resolved.error) log.warn("pi 单发模型解析失败，改用 pi 默认模型链", { model: req.model, error: resolved.error });
  else if (resolved.warning) log.warn("pi 单发模型解析告警", { model: req.model, warning: resolved.warning });
  return resolved.model ? { modelRuntime, model: resolved.model } : { modelRuntime };
}

// ── 图片 ──────────────────────────────────────────────────────────────────────────────

/**
 * `@<path>` 文件参数的 in-process 对应物：校验 → 读字节 → base64 → SDK 的 `prompt(msg, { images })`。
 *
 * 校验完全复用 `validatePiImages`（张数上限 / 存在 / 非空 / 可读 / 魔数嗅探 / 声明 MIME 比对），
 * 故两条路对同一张坏图给出**逐字相同**的 `PiImageArgError`。这一步刻意保持同步且在建会话之前，
 * 让「图片有问题」在什么都还没发生时就抛出去。
 *
 * 已知差异（有意为之，非疏漏）：二进制路径下 pi 的 `file-processor.js` 会对超限图片做自动缩放
 *（`resizeImage`，默认 2000×2000 / 4.5MB base64），in-process 这里**不缩放**，原样投递。
 * 理由：缩放要拉起 photon WASM，失败时 pi 的行为是把整张图换成 `[Image omitted: …]` ——
 * 那正是本仓明令禁止的静默丢图。Cortex 写侧已有 5MB 硬上限（`ipc/image.ts` 的 `MAX_IMAGE_BYTES`），
 * 且已发布的 pi RPC 聊天路径（`ipc/pi-session.ts` 的 `buildPiImages`）同样是原样 base64 投递，
 * 本路径与它对齐。若日后要补缩放，接入点是 pi 导出的 `resizeImage`，并且**必须**在其返回 null
 * 时回退到原图而不是丢图。
 */
function readImageContents(req: CliStartRequest): PiImageContentBlock[] {
  return validatePiImages(req.images).map((img) => ({
    type: "image" as const,
    data: readFileSync(img.path).toString("base64"),
    mimeType: img.mimeType,
  }));
}

// ── 工具 ──────────────────────────────────────────────────────────────────────────────

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
