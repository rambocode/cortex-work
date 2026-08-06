// pi 引擎共享的协议形状与事件归一化（原 `agents/pi-rpc.ts` 的存留部分）。
//
// 历史：这些符号最初诞生在「bun 二进制 + `--mode rpc` 手抄 JSONL 协议」的 `pi-rpc.ts` 里。
// binary 路径删除后，事件语义与应答形状仍是三处消费方的共同契约：
//   · `pi-inproc/session.ts` / `events.ts` —— in-process 引擎（gateway worker 内跑的就是它）；
//   · `pi-gateway/client.ts` —— 主进程侧的 gateway 客户端（`RpcResponse` 是跨进程应答形状）；
//   · `pi-events.contract.test.ts` —— 守住「pi AgentSessionEvent → PiSessionEvent」的映射语义。
// `RpcResponse` 这个名字保留：`pi-session.ts` 的 `command()` 与渲染端都按 `{success,data,error}`
// 解包，改名等于动 IPC 契约（R1）。

import { normalizePiTodos, TODO_TOOL_NAME } from "../pi-extensions";
import { ARTIFACTS_TOOL_NAME, type ArtifactDetails } from "./artifacts-tool";
import { createLogger } from "../../log";
import type {
  AskQuestionEnvelope,
  AskQuestionGroup,
  AskQuestionOption,
  JsReplEnvelope,
  PiSessionEvent,
} from "../../ipc/types";

const log = createLogger("pi-events");

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
 * 从 prompt 文本里取斜杠命令名（不含前导 /）。非 / 开头返回 undefined。
 * 只切到首个空白，`/foo bar` → `foo`；与 get_commands 回传的 `name`（无前导 /）同形，可直接比对。
 */
export function slashCommandName(message: string): string | undefined {
  const s = message.trimStart();
  if (!s.startsWith("/")) return undefined;
  const name = s.slice(1).split(/\s/, 1)[0];
  return name || undefined;
}

// turn_end / message_end 的 usage 归一化（input/output token 数）。
function piTurnUsage(value: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = typeof usage.input === "number" ? usage.input : undefined;
  const outputTokens = typeof usage.output === "number" ? usage.output : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

/**
 * 把 pi 的 AgentSessionEvent 映射为归一化 PiSessionEvent。
 * 无状态纯函数:无法识别 / 需忽略的事件（agent_start、turn_start、message_start、
 * text_start、text_end、toolcall_start/delta/end、auto_retry_end、response、以及 toolUse 中间收尾的
 * message_end）返回 null。run 失败的 message_end（stopReason=error|aborted）映射为 error 事件。
 * 正常最终 message_end（stop/length）也映射为 result，兜住 pi 偶发缺 agent_end 的终态。
 *
 * pi 0.82.1 新增、此处**有意不映射**的事件（0.79.2→0.82.1 协议 diff 结论，与 pi.ts 的
 * IGNORED_FRAME_TYPES 同源，改动时两边同步）：
 *   · entry_appended        —— pi session JSONL 逐条追加；Cortex 自持消息流,不据此重建。
 *   · bash_execution_update —— bash 输出增量 {id?, delta}；当前只取 tool_execution_end 的最终结果,
 *                              日后做工具行实时输出时从这里接。
 *   · summarization_retry_scheduled / _attempt_start / _finished —— 压缩与分支摘要的重试链。
 *     已知限制:压缩期重试对用户不可见。复用现有 retry 通道会有副作用——手动 /compact 时没有活跃
 *     run,setPiRuntime 的 retry 状态没有 result 来清理,会永久残留在 UI 上。要做需配套
 *     _finished 的清理路径,超出当时升级范围。
 * agent_settled 已映射（见下方 case），是唯一被消费的新事件。
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
      // 防御性:实测 pi 0.79.2 的错误不走这里（走 message_end，见下）。0.82.1 的 AgentEvent 联合
      // 未变（已 diff），故该结论沿用;保留分支以防协议变体。
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
      // 同源）。toolUse 是工具调用中间边界,不能收尾;stop/length 是最终边界,
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
        const usage = piTurnUsage(msg?.usage);
        return { type: "result", willRetry: false, ...(usage ? { usage } : {}) };
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
      // 任务清单工具特判:todo_write 不产 tool-start(避免过程流噪音),改产 todo 整表快照事件;
      // 对应 tool_execution_end 在下方分支被吞掉。空清单丢弃。
      if (o.toolName === TODO_TOOL_NAME) {
        const todos = normalizePiTodos(o.args);
        return todos.length > 0 ? { type: "todo", todos } : null;
      }
      // artifacts 工具特判（todo 同款判例）:start 帧吞掉,end 帧从 result.details 派生 artifact
      // 事件——过程流里的「产物卡片」由渲染端从 artifact 事件折叠,不走 tool-start/tool-end。
      if (o.toolName === ARTIFACTS_TOOL_NAME) return null;
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
      // artifacts 工具:成功变更 → artifact 事件（快照在 result.details,这是对 pi 0.82.1
      // 「emitToolExecutionEnd 原样透传 AgentToolResult.details」的依赖,contract 测试锁死;
      // pi 升级若剥离 details,兜底方案见 artifacts-tool.ts 文件头）。失败(isError)或无快照
      // (get / 形状漂移)一律吞掉——产物状态没变,不能发事件。逐字段重建保证结构可克隆。
      if (o.toolName === ARTIFACTS_TOOL_NAME) {
        if (o.isError) return null;
        const details = (o.result as { details?: Partial<ArtifactDetails> } | null | undefined)?.details;
        const artifact = details?.artifact;
        if (!artifact || typeof artifact.filename !== "string") return null;
        if (artifact.action !== "create" && artifact.action !== "update" && artifact.action !== "delete") return null;
        const out: Extract<PiSessionEvent, { type: "artifact" }> = {
          type: "artifact",
          action: artifact.action,
          filename: artifact.filename,
        };
        if (typeof artifact.content === "string") out.content = artifact.content;
        return out;
      }
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
    case "turn_end": {
      const message = o.message as Record<string, unknown> | undefined;
      const usage = piTurnUsage(message?.usage);
      return { type: "turn-end", ...(usage ? { usage } : {}) };
    }
    case "agent_end":
      return { type: "result", willRetry: !!o.willRetry };
    // pi 0.82.1 新增:agent 完全静默（无活跃 run / 重试 / 自动压缩 / 排队续跑）的权威终态。
    // 正常轮次里 agent_end 已先产 result,此事件是纯冗余;真正价值在异常路径——pi 漏发
    // agent_end 时它是最后一道终态保险,渲染侧据此收尾而非干等宽限（见 messages.ts 的 settled 分支）。
    case "agent_settled":
      return { type: "settled" };
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

// 入站信封校验（安全边界）:对 askquestion 信封做结构 + 尺寸/数量上限校验(与给 LLM 的
// outbound schema 对称),越界/畸形返回 null（调用方退化为裸 input 透传 + 诊断,防超大/恶意入站)。
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

// javascript_repl 入站信封校验（askquestion 同款安全边界）:结构 + 尺寸上限,越界/畸形返回 null
// （调用方退化为裸 input 透传 + 诊断）。code 上限与工具侧 JS_REPL_MAX_CODE_BYTES 对称。
const JSREPL_MAX_TITLE = 500;
const JSREPL_MAX_CODE = 256 * 1024;
export function sanitizeJsReplEnvelope(parsed: unknown): JsReplEnvelope | null {
  if (!parsed || typeof parsed !== "object") return null;
  const { title, code } = parsed as { title?: unknown; code?: unknown };
  if (typeof code !== "string" || !code || code.length > JSREPL_MAX_CODE) return null;
  return {
    title: typeof title === "string" ? title.slice(0, JSREPL_MAX_TITLE) : "",
    code,
  };
}

// pi prompt 命令的图片内容块（多模态:base64 + mime）。
export interface PiImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

// 命令应答形状（{type:"response", command, success, data|error}）。三个引擎实现共用,
// `ipc/pi-session.ts` 的 command() 按它解包并把失败转成 IPC rejection——渲染端契约的根。
// 斜杠命令来源（镜像 pi rpc-types.d.ts 的 RpcSlashCommand.source）。只有 extension 来源的命令
// 由 pi 即时执行、不跑 agent（无 agent_end）;prompt / skill 会展开成真实 agent 轮次。
export type RpcSlashCommandSource = "extension" | "prompt" | "skill";

export interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
