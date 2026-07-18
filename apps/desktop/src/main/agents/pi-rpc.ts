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

import { normalizePiTodos, TODO_TOOL_NAME } from "./pi-extensions";
import { resolvePiBinary } from "./pi-locate";
import { safeId } from "./pi-providers";
import { recordAgentTrace } from "../ipc/agent-trace";
import { createLogger } from "../log";
import type {
  AskQuestionEnvelope,
  AskQuestionGroup,
  AskQuestionOption,
  PiOpenRequest,
  PiSessionEvent,
  PiUiRequest,
  PiUiResponsePayload,
} from "../ipc/types";

// pi RPC 管线盲区观测 logger(U4):命令超时 / 未产终态 / 扩展命令补发 / crashed 等
// 易静默卡死的节点在此落盘。埋点失败 try/catch 吞掉,绝不阻断 RPC 主流程(R14)。
const log = createLogger("pi-rpc");

// mapPiEvent 中已知会出现的 message_end.stopReason:error/aborted 映射为 error 事件,
// stop/length/toolUse 正常收尾(终态由 turn-end / result 表达,故 return null)。其余取值
// 视为「未映射」——可能是 pi 协议漂移引入的新 stopReason,会落入「无终态」黑洞,需可观测。
const KNOWN_STOP_REASONS = new Set(["error", "aborted", "stop", "length", "toolUse"]);

// 从工具入参里取一段可读 detail（命令 / 路径 / 模式 / URL），过长截断。与 pi.ts 对齐。
function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const candidate = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url;
  if (typeof candidate !== "string") return undefined;
  return candidate.length > 80 ? candidate.slice(0, 80) + "…" : candidate;
}

// 工具输出截断上限(与 claude/codex adapter 同值):防超大输出撑爆 IPC 与渲染端内存。
const MAX_TOOL_OUTPUT = 8_000;

// 归一化 tool_execution_end.result 为展示用文本:string 原样;{content:[{type:"text",text}]}
// (AgentToolResult 形态)拼接 text 块;其余 JSON 序列化兜底。超限截断。
function normalizeToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      text = content
        .map((b) => {
          const block = b as Record<string, unknown>;
          return block?.type === "text" && typeof block.text === "string" ? block.text : "";
        })
        .filter(Boolean)
        .join("\n");
    } else {
      try {
        text = JSON.stringify(result);
      } catch {
        text = String(result);
      }
    }
  }
  // 空串或空对象序列化("{}")没有展示价值,视作无输出。
  if (!text || text === "{}") return undefined;
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "…" : text;
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
 * text_start、text_end、toolcall_start/delta/end、auto_retry_end、response、以及 toolUse 中间收尾的
 * message_end）返回 null。run 失败的 message_end（stopReason=error|aborted）映射为 error 事件。
 * 正常最终 message_end（stop/length）也映射为 result，兜住 pi 偶发缺 agent_end 的终态。
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
      // 100-113 同源）。toolUse 是工具调用中间边界,不能收尾;stop/length 是最终边界,
      // 也产出 result,兜住 pi 偶发缺 agent_end 时 renderer 永久卡 running 的情况。
      const msg = o.message as Record<string, unknown> | undefined;
      const stopReason = msg?.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        const error =
          (typeof msg?.errorMessage === "string" ? msg.errorMessage : undefined) ??
          diagnosticsError(msg?.diagnostics) ??
          String(stopReason);
        return { type: "error", error };
      }
      // stop/length 是最终边界,产出 result,兜住 pi 偶发缺 agent_end 时 renderer 永久卡 running。
      if (stopReason === "stop" || stopReason === "length") {
        return { type: "result", willRetry: false };
      }
      // 盲区补点(R10):非空的未知 stopReason → 不产任何终态事件,renderer 可能永久卡「思考中」。
      // 记录原始值便于定位 pi 协议漂移;已知值(error/aborted/stop/length/toolUse)与缺省静默,不噪声。
      if (stopReason != null && !KNOWN_STOP_REASONS.has(String(stopReason))) {
        try {
          log.warn("pi message_end 未映射的 stopReason(未产终态)", { stopReason });
        } catch {
          /* 日志失败不影响映射 */
        }
      }
      return null;
    }
    case "tool_execution_start": {
      if (typeof o.toolName !== "string" || typeof o.toolCallId !== "string") return null;
      // 任务清单工具特判:todo_write(pi-todo extension)不产 tool-start(避免过程流噪音),
      // 改产 todo 整表快照事件;对应 tool_execution_end 在下方分支被吞掉。空清单丢弃。
      if (o.toolName === TODO_TOOL_NAME) {
        const todos = normalizePiTodos(o.args);
        return todos.length > 0 ? { type: "todo", todos } : null;
      }
      const out: Extract<PiSessionEvent, { type: "tool-start" }> = {
        type: "tool-start",
        name: o.toolName,
        toolCallId: o.toolCallId,
      };
      const detail = toolDetail(o.args);
      if (detail) out.detail = detail;
      // 完整调用参数(运行过程详情视图展示)。
      if (o.args !== undefined) out.input = o.args;
      return out;
    }
    case "tool_execution_end": {
      if (typeof o.toolName !== "string" || typeof o.toolCallId !== "string") return null;
      // todo_write 的 end 帧吞掉:start 侧已转成 todo 事件,无 tool-start 可配对。
      if (o.toolName === TODO_TOOL_NAME) return null;
      const out: Extract<PiSessionEvent, { type: "tool-end" }> = {
        type: "tool-end",
        name: o.toolName,
        toolCallId: o.toolCallId,
        isError: !!o.isError,
      };
      // 工具输出正文(截断后透出,运行过程详情视图展示)。
      const output = normalizeToolResult(o.result);
      if (output !== undefined) out.output = output;
      return out;
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

// 入站信封校验（安全边界）:对 pi stdout 携带的 askquestion 信封做结构 + 尺寸/数量上限校验(与给
// LLM 的 outbound schema 对称),越界/畸形返回 null（调用方退化为裸 input 透传 + 诊断,防超大/恶意入站)。
const ASKQ_MAX_GROUPS = 12;
const ASKQ_MAX_OPTIONS = 3;
const ASKQ_MAX_STR = 4000;
export function sanitizeAskQuestionEnvelope(parsed: unknown): AskQuestionEnvelope | null {
  if (!parsed || typeof parsed !== "object") return null;
  const groupsRaw = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0 || groupsRaw.length > ASKQ_MAX_GROUPS) return null;
  const groups: AskQuestionGroup[] = [];
  for (let i = 0; i < groupsRaw.length; i++) {
    const g = groupsRaw[i] as Record<string, unknown> | null;
    if (!g || typeof g !== "object") return null;
    const optionsRaw = Array.isArray(g.options) ? g.options.slice(0, ASKQ_MAX_OPTIONS) : [];
    const options: AskQuestionOption[] = optionsRaw.map((o) => {
      const oo = (o ?? {}) as Record<string, unknown>;
      const opt: AskQuestionOption = {
        label: typeof oo.label === "string" ? oo.label.slice(0, ASKQ_MAX_STR) : String(oo.label ?? ""),
      };
      if (typeof oo.description === "string") opt.description = oo.description.slice(0, ASKQ_MAX_STR);
      return opt;
    });
    const allowCustom = !!g.allowCustom;
    if (options.length === 0 && !allowCustom) return null; // 组不可作答 → 拒绝
    // 推荐项排到第一个:把 recommended 选项移到 options[0]、recommended 归一为 0(展示时推荐始终最前;
    // 答案回写的是 label 而非下标,重排不影响回传 pi 的语义)。
    let recommended =
      typeof g.recommended === "number" && g.recommended >= 0 && g.recommended < options.length
        ? g.recommended
        : undefined;
    let finalOptions = options;
    if (recommended != null && recommended > 0) {
      finalOptions = [options[recommended]!, ...options.filter((_, k) => k !== recommended)];
      recommended = 0;
    }
    const group: AskQuestionGroup = {
      id: `g${i}`, // host 不信任入站 id:始终按位置重写,杜绝重复 id 导致的渲染 key 冲突 / 跨组答案污染
      question: typeof g.question === "string" ? g.question.slice(0, ASKQ_MAX_STR) : "",
      options: finalOptions,
      allowCustom,
    };
    if (typeof g.header === "string") group.header = g.header.slice(0, ASKQ_MAX_STR);
    if (recommended != null) group.recommended = recommended;
    groups.push(group);
  }
  return { groups };
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
  // 插件管理:--no-skills 随 useOwnSkills gate（与单发 pi.ts / claude adapter 对齐）。
  //   · useOwnSkills!==true → 加 --no-skills 关掉 pi 原生自动发现;
  //   · useOwnSkills===true → 省略,放开 pi 自身原生 skill 发现(~/.pi/agent/skills、~/.agents/skills、
  //     项目 .pi/skills / .agents/skills),让 pi 用「各自原生目录」,与 claude/codex 一致。
  // 无论开关,Cortex 已启用集合仍逐个 --skill 附加注入（实测 --no-skills 与显式 --skill 共存）。
  if (req.useOwnSkills !== true) args.push("--no-skills");
  for (const p of req.skillPaths ?? []) args.push("--skill", p);
  // 运行模式 plan 档:只读工具白名单（renderer 由 permissionMode 派生为 toolWhitelist）。--tools 是
  // 全局 CLI flag,与 --mode rpc 正交,可与 --no-skills/--skill/-e 共存;缺省不传 = 全工具可用
  // （accept-edits/full-auto 不收窄工具,靠审批 extension 区分）。pi 无运行时改工具集命令,故切到
  // plan 需重开会话(由发送层的模式指纹判定)。
  if (req.toolWhitelist?.length) args.push("--tools", req.toolWhitelist.join(","));
  // extension:provider（piExtensionPath）+ 阶段3 审批/样例（extraExtensionPaths）+ 扩展市场
  // 已启用扩展（extensionPaths,U3）多 `-e` 共存（spike 已证 --no-extensions 与多个显式 -e 共存）。
  // 各加一个 -e,`-a` 信任只加一次（实测 -a 整批信任,无逐扩展粒度——UI 信任门是唯一逐扩展强制点）。
  const exts = [
    req.piExtensionPath,
    ...(req.extraExtensionPaths ?? []),
    ...(req.extensionPaths ?? []),
  ].filter((p): p is string => !!p);
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
// 返回强杀 timer 供进程正常退出后 clearTimeout,避免每次 kill 都空等 3s 占用（防泄漏）。
function killWithTimeout(soft: () => void, pid: number | undefined): ReturnType<typeof setTimeout> {
  soft();
  return setTimeout(() => {
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
  const cmd = resolvePiBinary();
  recordAgentTrace({
    scope: "pi-rpc",
    phase: "spawn",
    summary: "pi rpc spawn",
    agent: "pi",
    data: { cmd, cwd: opts.cwd, argCount: args.length },
  });
  const child = spawn(cmd, args, {
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
    recordAgentTrace({
      scope: "pi-rpc",
      phase: "stderr",
      summary: "pi rpc stderr",
      agent: "pi",
      data: { chunk },
    });
  });
  // 兜底强杀 timer:进程正常 close 后清掉,避免空等 3s 占用（防泄漏）。
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  child.on("close", (code) => {
    if (killTimer) clearTimeout(killTimer);
    recordAgentTrace({
      scope: "pi-rpc",
      phase: "exit",
      summary: `pi rpc exit ${code ?? "null"}`,
      agent: "pi",
      data: { code, stderrTail: stderrTail.trim() || undefined },
    });
  });
  child.on("error", (err) => {
    recordAgentTrace({
      scope: "pi-rpc",
      phase: "error",
      summary: "pi rpc spawn error",
      agent: "pi",
      data: { error: err.message },
    });
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
    kill: () => {
      killTimer = killWithTimeout(() => child.kill("SIGTERM"), child.pid);
    },
  };
}

// pi RPC prompt 命令的图片内容块（多模态:base64 + mime,协议内置 images 字段)。
export interface PiImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
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
// 扩展命令(/cmd)收尾宽限:pi 对扩展命令即时执行后提前返回、不跑 agent（无 agent_end）。response
// 落定后若未见 agent 活动,给这段窗口等 agent_start（防 /skill: /template 展开后的 response→agent_start
// 竞态误判),仍无则补发 result 收尾,避免 renderer 永久卡「思考中」。
const EXT_COMMAND_FINALIZE_GRACE_MS = 1_500;
// 「agent 真在跑一轮」的事件类型:出现任一即说明不是纯扩展命令,无需补发收尾。
const AGENT_TURN_EVENT_TYPES = new Set<PiSessionEvent["type"]>([
  "text",
  "reasoning",
  "tool-start",
  "tool-end",
  "turn-end",
  "result",
  "error", // 错误事件自带收尾路径,出现即不补发
]);

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
  private exitError?: Error;
  private stopped = false;
  // 阶段4 代际:当前轮的 runId（Cortex 自造,prompt 时绑定）。事件回带它,renderer 据此守卫
  // 丢弃迟到/串台事件（崩溃重开/editResend 重入时旧轮事件落入新轮）。
  private currentRunId?: string;
  // 扩展命令收尾跟踪（见 EXT_COMMAND_FINALIZE_GRACE_MS）:本轮是否 / 前缀、是否见过 agent 活动 /
  // notify 输出,以及待触发的补发收尾定时器。
  private slashSawAgentEvent = false;
  private slashSawNotify = false;
  private slashFinalizeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transport: RpcTransport,
    private readonly onEvent: (ev: PiSessionEvent, runId?: string) => void,
    // extension 经 ctx.ui.* 发起的 UI 请求（独立于事件流;阶段3 用于工具确认弹窗）。
    private readonly onUiRequest?: (req: PiUiRequest) => void,
    // askquestion 借道:每会话高熵 sentinel。handleLine 检出 input.title 命中它 → 归一为 method:"askquestion"。
    private readonly askQuestionSentinel?: string,
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
    // 单行长度上限保护:异常超长单行（无换行）会无限撑大 buf,超阈值丢弃溢出部分（防泄漏）。
    if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-1_000_000);
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
    // extension UI 请求（pi → host）。其中 notify / setStatus 是 fire-and-forget（pi 不等回写）:
    // 扩展命令的输出只走 notify。把 notify 转成事件呈现（而非塞进需回写的对话框队列,否则永不显示);
    // setStatus 在 RPC 下无对应 UI,丢弃。其余（confirm/select/input/askquestion）才是需 host 回写的对话框。
    if (obj?.type === "extension_ui_request" && typeof obj.id === "string") {
      if (obj.method === "notify") {
        this.slashSawNotify = true;
        const level = obj.notifyType === "warning" || obj.notifyType === "error" ? obj.notifyType : "info";
        this.onEvent({ type: "notify", message: String(obj.message ?? ""), level }, this.currentRunId);
        return;
      }
      if (obj.method === "setStatus") return; // fire-and-forget,无 UI 承接,丢弃
      this.onUiRequest?.(this.normalizeUiRequest(obj));
      return;
    }
    const ev = mapPiEvent(obj);
    if (ev) {
      // 见到 agent 真在跑一轮的事件 → 取消扩展命令补发收尾（这是普通 prompt / 展开后的 /skill: 等）。
      if (AGENT_TURN_EVENT_TYPES.has(ev.type)) {
        this.slashSawAgentEvent = true;
        if (this.slashFinalizeTimer) {
          clearTimeout(this.slashFinalizeTimer);
          this.slashFinalizeTimer = undefined;
        }
      }
      this.onEvent(ev, this.currentRunId);
    }
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

  // 把「带本会话 sentinel 的 input 请求」归一为 askquestion 富信封;否则原样返回（裸 method 不变,
  // 既有 confirm/select/input 行为不回归）。sentinel 为每会话高熵 token,LLM 无法在裸 input 的 title
  // 里伪造;解析/越界失败 → 可观测诊断 + 透传（由 renderer 的 cancelled 兜底),不静默吞,便于 pi 版本漂移定位。
  private normalizeUiRequest(obj: Record<string, unknown>): PiUiRequest {
    const sentinel = this.askQuestionSentinel;
    if (sentinel && obj.method === "input" && typeof obj.title === "string" && obj.title.startsWith(sentinel)) {
      const json = obj.title.slice(sentinel.length);
      try {
        const envelope = sanitizeAskQuestionEnvelope(JSON.parse(json));
        if (envelope) {
          return { type: "extension_ui_request", id: obj.id as string, method: "askquestion", envelope };
        }
        log.warn("[pi-askquestion] 信封校验失败(空/越界/不可作答),透传为裸 input");
      } catch {
        log.warn("[pi-askquestion] 信封 JSON 解析失败,透传为裸 input");
      }
    }
    return obj as unknown as PiUiRequest;
  }

  /** 发一条命令,等带相同 id 的 response。超时或进程已退出则 reject。 */
  send(
    command: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    opts: { warnOnTimeout?: boolean } = {},
  ): Promise<RpcResponse> {
    if (this.exited) return Promise.reject(new Error("pi 会话已退出"));
    const id = `req_${++this.reqId}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 盲区补点(R10):命令级超时无终态事件,易表现为 renderer 静默卡死。记录命令类型 +
        // 超时阈值便于定位是 pi 未应答还是阈值过短。仅观测,不改 reject 行为。
        if (opts.warnOnTimeout !== false) {
          try {
            log.warn("pi 命令超时", { command: String(command.type), timeoutMs });
          } catch {
            /* 日志失败不影响 reject */
          }
        }
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
    const readyExitError = () =>
      this.exitError ? new Error(`pi 进程在就绪前退出: ${this.exitError.message}`) : new Error("pi 进程在就绪前退出");
    for (let i = 0; i < tries; i++) {
      if (this.exited) throw readyExitError();
      try {
        // 单次探测超时是冷启动期间的预期轮询信号，不应冒充命令故障告警；只有整个 ready
        // 尝试耗尽才是真正的会话就绪失败。
        const resp = await this.send({ type: "get_state" }, intervalMs, { warnOnTimeout: false });
        const data = resp.success ? (resp.data as { sessionId?: string; sessionFile?: string } | undefined) : undefined;
        if (data?.sessionId) return { sessionId: data.sessionId, sessionFile: data.sessionFile };
        // 已应答但暂无 sessionId:小睡一轮再试,避免无间隔忙轮询烧光 tries。
        await new Promise((r) => setTimeout(r, intervalMs));
      } catch {
        if (this.exited) throw readyExitError();
        // get_state 超时（≈intervalMs）= 进程未就绪,直接重试（超时本身已构成间隔）。
      }
    }
    try {
      log.warn("pi 会话就绪超时", { tries, intervalMs });
    } catch {
      /* 日志失败不影响 reject */
    }
    throw new Error("pi 会话就绪超时");
  }

  // ── 命令封装（均返回应答 Promise）─────────────────────────────────────
  // 注:prompt 的 response 是 preflight 受理后的即时 ack（毫秒级，非任务完成）;一轮 run 的
  // 结束由 agent_end 事件（映射为 {type:"result"}）经事件流单独表达。故 prompt 用默认短超时
  // 即可（与官方 RpcClient 一致），只覆盖「受理」这一步。compact 的 response 才是 await 压缩完成。
  // runId（Cortex 自造）在写 stdin prompt 时同步绑定,确保首条 agent_start 事件已带新 runId
  // （pi 不参与;steer/abort 不换 runId,其事件仍归属当前轮）。
  prompt(message: string, runId?: string, images?: PiImageContent[]): Promise<RpcResponse> {
    if (runId !== undefined) this.currentRunId = runId;
    // 扩展命令(/cmd)由 pi 即时执行后提前返回、不跑 agent → 永不发 agent_end,renderer 会永久卡
    // 「思考中」。仅对 / 前缀重置跟踪并在 response 落定后判定是否补发收尾;普通 prompt 零影响。
    const isSlash = message.trimStart().startsWith("/");
    if (this.slashFinalizeTimer) {
      clearTimeout(this.slashFinalizeTimer);
      this.slashFinalizeTimer = undefined;
    }
    this.slashSawAgentEvent = false;
    this.slashSawNotify = false;
    const rid = runId ?? this.currentRunId;
    // 多模态:图片走 prompt 命令的协议内置 images 字段(base64),非塞进 message 字符串。
    const p = this.send({ type: "prompt", message, ...(images?.length ? { images } : {}) });
    if (isSlash) {
      void p.then(
        (resp) => {
          if (resp?.success) this.scheduleExtensionCommandFinalize(rid);
        },
        () => undefined, // 失败由 send 的 reject 走既有错误路径
      );
    }
    return p;
  }

  // 扩展命令 prompt 的 response 在 pi 跑完 handler 后才落定（故此刻命令已结束）。判定:
  //  - 已见 notify（命令有输出）且未见 agent 活动 → 确证扩展命令,立即补发 result 收尾;
  //  - 否则给一段宽限等 agent_start（防 /skill: /template 展开后的 response→agent_start 竞态）,
  //    仍无 agent 活动则补发（覆盖无 notify 输出的扩展命令）。补发的 result 让 renderer 正常收尾。
  private scheduleExtensionCommandFinalize(rid?: string): void {
    if (this.slashSawAgentEvent || this.stopped || this.exited) return;
    const finalize = (): void => {
      this.slashFinalizeTimer = undefined;
      if (this.slashSawAgentEvent || this.stopped || this.exited) return;
      // 盲区补点(R10):扩展命令(/cmd)无 agent_end,这里补发 result 收尾。记录补发触发便于
      // 区分「真扩展命令收尾」与「漏发 agent_end 的 bug」(sawNotify 反映命令是否有输出)。
      try {
        log.debug("扩展命令补发 result 收尾", { sawNotify: this.slashSawNotify });
      } catch {
        /* 日志失败不影响补发 */
      }
      this.onEvent({ type: "result", willRetry: false }, rid);
    };
    if (this.slashSawNotify) finalize();
    else this.slashFinalizeTimer = setTimeout(finalize, EXT_COMMAND_FINALIZE_GRACE_MS);
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
    if (this.slashFinalizeTimer) {
      clearTimeout(this.slashFinalizeTimer);
      this.slashFinalizeTimer = undefined;
    }
    this.rejectAllPending(new Error("pi 会话已停止退出"));
    this.transport.kill();
  }

  // close 与 error 可能先后到达（spawn 失败时尤甚）:用 exited 去重,确保终止只处理一次
  // （rejectAllPending 与 crashed 各最多一次,不依赖下游摘除注册表的时序）。
  private handleExit(code: number | null, stderrTail?: string): void {
    if (this.exited) return;
    this.exited = true;
    const detail =
      code === 0 || code === null ? undefined : stderrTail ? `退出码 ${code}: ${stderrTail}` : `退出码 ${code}`;
    this.exitError = new Error(detail ?? `code=${code}`);
    this.rejectAllPending(this.exitError);
    if (!this.stopped) {
      // 盲区补点(R10):非主动停止的退出 = 崩溃,记录退出码 + stderr 尾便于复盘。
      try {
        log.warn("pi 会话崩溃退出", { code, detail });
      } catch {
        /* 日志失败不影响 crashed 上报 */
      }
      this.onEvent({ type: "crashed", error: detail });
    }
  }

  private handleError(err: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitError = err;
    this.rejectAllPending(err);
    if (!this.stopped) {
      // 盲区补点(R10):spawn/管道级错误,记录 error 信息。
      try {
        log.warn("pi 会话错误退出", { error: err.message });
      } catch {
        /* 日志失败不影响 crashed 上报 */
      }
      this.onEvent({ type: "crashed", error: err.message });
    }
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
