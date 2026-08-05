// pi（@earendil-works/pi-coding-agent）内置兜底 agent 的 CLI adapter。
// 命令形态（0.79.2 实测建立;flag 集合已复核至 0.82.1——dist/cli/args.js 里下列 flag 全部仍在、
// 无签名变更。pi 已 bun 编译成自包含二进制,由 cli.ts 经 spawn 执行）：
//   <pi 二进制> --mode json -p --no-extensions
//             [--no-skills] [--skill p] [--tools read,grep,find,ls (plan 只读)]
//             [--model m] [--session id] [--append-system-prompt s] [@image ...] <prompt>
//   · adapter 产出 cmd=pi 二进制路径（resolvePiBinary）+ args；cli.ts 对三种 agent 统一 spawn。
//   · -p 是非交互布尔 flag,prompt 不是它的值,而是命令行最后一个位置参数。
//   · `@<path>` 是 pi 原生的文件参数（图片经魔数嗅探转成 initialImages）,详见 buildPiImageArgs。
//   · --no-extensions 纯净启动；--no-skills 默认禁用 skills（useOwnSkills=true 时省略,
//     与 claude adapter 对齐）；pi 原生支持 --append-system-prompt。
// --mode json 输出 JSONL,每行一个事件：
//   {type:"session",id}                                              → init
//   {type:"message_update",assistantMessageEvent:{type:"text_delta",delta}} → text 增量
//   {type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta}} → thinking 增量
//   {type:"tool_execution_start",toolCallId,toolName,args}           → tool start
//   {type:"tool_execution_end",toolCallId,toolName,result,isError}   → tool end
//   {type:"message_end",message:{role:"assistant",stopReason,...}}   → 收尾(result)
//   另有 agent_start/turn_start/turn_end/agent_end/message_start 等,一律忽略;
//   message_update 的 text/thinking start-end、toolcall_* 子帧与 user 回显的 message_end
//   也是已知忽略(见 isIgnoredFrame),与 pi-rpc.ts mapPiEvent 的忽略清单同源。
// ⚠️ 陷阱：provider 失败时进程仍 exit 0,错误只体现在 message_end 的 stopReason:"error"
//    + errorMessage/diagnostics 上。故 result 由最后一条 assistant message_end 发出,
//    agent_end 不发,避免覆盖掉这条错误结果。
//
// ── in-process 单发（迁移计划 U5，灰度开关打开时）─────────────────────────────────────
// `agents/pi-inproc/oneshot.ts` 在主进程内直接跑 `createAgentSession`,并把
// `AgentSession.subscribe()` 的事件 `JSON.stringify` 成**与上面完全同形**的 JSONL 行,
// 交给下面这个 `parseLine` 原样解析 —— 所以 `CliStreamEvent` 契约与那条 ⚠️ 陷阱的处理
// （result 只由最后一条 assistant message_end 发出）在两条路上是同一份代码，不会漂移。
// 本文件里被那条路复用的两个纯函数是 `validatePiImages`（图片校验）与 `planToolWhitelist`。

import { closeSync, openSync, readSync, statSync } from "fs";

import { normalizePiTodos, TODO_TOOL_NAME } from "./pi-extensions";
import { resolvePiBinary } from "./pi-locate";
import { safeId } from "./pi-providers";
import { PI_PLAN_TOOL_WHITELIST, type CliImageRef, type CliStartRequest, type CliStreamEvent } from "../ipc/types";
import type { AgentDef } from "./index";

function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const candidate = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url;
  if (typeof candidate !== "string") return undefined;
  return candidate.length > 80 ? candidate.slice(0, 80) + "…" : candidate;
}

// 拼接 message_end 里 assistant content 的 text 块为完整文本。
function joinText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text || undefined;
}

const MAX_TOOL_OUTPUT = 8_000;

// 单发 pi 同样会产 tool_execution_end；此前只映射 start，导致失败工具在 UI 中也被提前标绿，
// 并触发 parse 的“未映射帧”巨量日志。输出规则与 pi-rpc 保持一致。
function normalizeToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      text = content
        .map((block) => {
          const item = block as Record<string, unknown>;
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
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
  if (!text || text === "{}") return undefined;
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}…` : text;
}

// diagnostics 最后一项里的错误信息（provider_transport_failure 等）。
function diagnosticsError(diagnostics: unknown): string | undefined {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return undefined;
  const last = diagnostics[diagnostics.length - 1] as Record<string, unknown> | undefined;
  const err = last?.error as Record<string, unknown> | undefined;
  return typeof err?.message === "string" ? err.message : undefined;
}

function piUsageEvent(value: unknown): Extract<CliStreamEvent, { type: "usage" }> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = typeof usage.input === "number" ? usage.input : undefined;
  const outputTokens = typeof usage.output === "number" ? usage.output : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { type: "usage", inputTokens, outputTokens };
}

function safeDelegateToolId(id: string): string {
  const s = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "role";
}

/**
 * plan 只读档的工具白名单 = pi 官方只读配方 + 本轮委派协作者的 `ask_<id>` 工具。
 * 导出供 in-process 单发路径（`pi-inproc/oneshot.ts`）复用：两条路的白名单必须同源，
 * 否则切开关后「plan 档能用哪些工具」会悄悄不一致。
 */
export function planToolWhitelist(req: CliStartRequest): string[] {
  const delegateTools = (req.delegateRoles ?? []).map((role) => `ask_${safeDelegateToolId(role.id)}`);
  return [...PI_PLAN_TOOL_WHITELIST, ...delegateTools];
}

// agent_start/turn_start/turn_end/agent_end/message_start:已评审过、故意忽略的帧(见文件头
// 注释第 15/150-151 行),不是 parseLineEvents 盲区补点想告警的"新协议漂移",故声明进
// ignoredFrameTypes,让盲区补点跳过它们,不刷屏。
//
// 后半段是 pi 0.82.1 新增、单发路径不消费的帧（0.79.2→0.82.1 协议 diff 结论）。必须显式列出:
// 漏列会让盲区补点对每轮都打「未映射帧」,把真正的协议漂移信号淹掉。逐条理由——
//   · agent_settled  : 单发是一次性调用,result 已由最后一条 message_end 产出,静默信号无处可用
//                      （RPC 路径不同,见 pi-rpc.ts 的 settled 分支）。
//   · entry_appended : pi 侧 session JSONL 的逐条追加。Cortex 自持消息流(chat.ts),不用它重建。
//   · bash_execution_update : bash 输出增量。当前只在 tool_execution_end 取最终结果;若日后要做
//                      工具行的实时输出,这是接入点（{id?, delta}）。
//   · summarization_retry_* : 压缩 / 分支摘要的重试链（0.82.1 起摘要调用也吃 settings.retry 预算）。
//                      已知限制:压缩期的重试目前对用户不可见——单发路径本就不展示压缩过程,
//                      RPC 路径的可见性要接 retry/compaction 状态机,超出本次升级范围,另行评估。
const IGNORED_FRAME_TYPES = new Set([
  "agent_start",
  "turn_start",
  "turn_end",
  "agent_end",
  "message_start",
  "agent_settled",
  "entry_appended",
  "bash_execution_update",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
]);

// message_update 里已知无归一化映射的子事件:text/thinking 的 start-end 只是流边界标记,
// toolcall_* 增量已由顶层 tool_execution_start 帧覆盖。与 pi-rpc.ts mapPiEvent 的忽略清单同源。
// (text_delta/thinking_delta 会产事件,不在此列。)
const IGNORED_MESSAGE_UPDATE_SUBTYPES = new Set([
  "text_start",
  "text_end",
  "thinking_start",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
]);

// ── 图片投递（`@<path>` 文件参数） ────────────────────────────────────────────
//
// pi CLI 原生支持 `@<path>`:cli/args.js:171-173 `else if (arg.startsWith("@")) fileArgs.push(arg.slice(1))`
// —— 按前缀解析,与 argv 位置无关（但**不能紧跟在值型 flag 之后**,因为 --skill/--model 一类
// 是无条件吃掉下一个 arg 的等值判断分支）。随后 cli/file-processor.js 做 MIME 魔数嗅探 +
// 自动缩放,把图片转成 initialImages（main.js:96-107 prepareInitialMessage → runPrintMode）。
//
// ⚠️ 顺序不由 argv 决定:cli/initial-message.js 恒按 [stdin, @file 文本, messages[0]] 拼接,
// 图片引用永远排在 prompt 之前。我们仍把 `@file` 放在 prompt 之前,与 pi -h 的
// `pi [options] [@files...] [messages...]` 一致,避免读命令行时产生误解。
//
// 上传范围与 chat 侧一致:PNG / JPEG / GIF / WebP,单轮 ≤6 张。
const MAX_PI_IMAGES = 6;
const PI_IMAGE_SNIFF_BYTES = 4100; // 与 pi utils/mime.js 的 IMAGE_TYPE_SNIFF_BYTES 对齐

/** buildArgs 阶段的图片校验失败。code 供上层做分支处理,message 面向用户。 */
export class PiImageArgError extends Error {
  readonly code: "too-many" | "not-found" | "empty" | "unreadable" | "unsupported" | "mime-mismatch";
  readonly imagePath?: string;

  constructor(code: PiImageArgError["code"], message: string, imagePath?: string) {
    super(message);
    this.name = "PiImageArgError";
    this.code = code;
    this.imagePath = imagePath;
  }
}

function startsWithBytes(buf: Buffer, bytes: number[]): boolean {
  return buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
}

function startsWithAscii(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (buf[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32BE(buf: Buffer, offset: number): number {
  return (
    (buf[offset] ?? 0) * 0x1000000 +
    ((buf[offset + 1] ?? 0) << 16) +
    ((buf[offset + 2] ?? 0) << 8) +
    (buf[offset + 3] ?? 0)
  );
}

// 动图 PNG(APNG)在 pi 侧被判定为「不是受支持的图片」→ 落进 @file 的**文本**分支被当 UTF-8 读,
// 会把二进制垃圾塞进 prompt。这里必须同样识别并拒绝,才能让失败响亮可见而不是静默污染上下文。
function isAnimatedPng(buf: Buffer): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buf, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buf, chunkTypeOffset, "IDAT")) return false;
    const next = offset + 8 + readUint32BE(buf, offset) + 4;
    if (next <= offset || next > buf.length) return false;
    offset = next;
  }
  return false;
}

// 魔数嗅探,逐条镜像 pi 0.82.1 utils/mime.js 的判定（含 JPEG-LS 0xF7 与 APNG 的排除),
// 只保留 Cortex 上传范围内的四种格式。返回 null = pi 不会把它当图片。
function sniffPiImageMime(buf: Buffer): string | null {
  if (startsWithBytes(buf, [0xff, 0xd8, 0xff])) return buf[3] === 0xf7 ? null : "image/jpeg";
  if (startsWithBytes(buf, PNG_SIGNATURE)) {
    const validHeader =
      buf.length >= 16 && readUint32BE(buf, PNG_SIGNATURE.length) === 13 && startsWithAscii(buf, 12, "IHDR");
    return validHeader && !isAnimatedPng(buf) ? "image/png" : null;
  }
  if (startsWithAscii(buf, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buf, 0, "RIFF") && startsWithAscii(buf, 8, "WEBP")) return "image/webp";
  return null;
}

// 声明 MIME 的规范化:浏览器/系统可能给出 image/jpg 这类别名,与魔数结果比对前先对齐。
function normalizeDeclaredMime(mime: string | undefined): string | undefined {
  const m = mime?.trim().toLowerCase();
  if (!m) return undefined;
  return m === "image/jpg" ? "image/jpeg" : m;
}

/** 通过校验的一张图:绝对路径 + **魔数嗅探出的真实** MIME（不是调用方声明的那个）。 */
export interface ValidatedPiImage {
  path: string;
  mimeType: string;
}

/**
 * 校验 req.images 并解析出真实 MIME。任何一张图有问题都整体抛错,**绝不静默丢图**
 * ——静默丢图正是本次事故里 pi 侧 `(image omitted…)` 让用户误以为模型看过图的同款failure mode。
 *
 * 这里做真实 fs 读取（buildArgs 因此不再是严格纯函数）:pi 的 file-processor.js 在文件缺失时
 * 直接 `process.exit(1)`、在非图片文件上会当文本读进 prompt,两种都发生在子进程里、错误信息
 * 拿不回来,只能在 spawn 之前拦。
 *
 * 抽成独立函数是为了让**两条投递通道共用同一套校验**（迁移计划 U5）：
 *   · 二进制路径 → `buildPiImageArgs()` 拼 `@<path>` 参数，由 pi 子进程自己读文件；
 *   · in-process 路径 → `agents/pi-inproc/oneshot.ts` 按这里给出的 path/mimeType 读字节转
 *     base64，喂 SDK 的 `prompt(msg, { images })`。
 * 两条路的**错误码与文案必须逐字相同**，否则灰度开关一切换，同一张坏图给出的提示就变了。
 */
export function validatePiImages(images: CliImageRef[] | undefined): ValidatedPiImage[] {
  if (!images?.length) return [];
  if (images.length > MAX_PI_IMAGES) {
    throw new PiImageArgError("too-many", `单轮最多发送 ${MAX_PI_IMAGES} 张图片，当前 ${images.length} 张`);
  }
  return images.map((img) => {
    const path = img.path;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new PiImageArgError("not-found", `图片文件不存在或不可访问：${path}`, path);
    }
    // pi 的 file-processor.js 对空文件是「静默跳过」,那正好是我们要避免的静默丢图,故提前拦。
    if (size === 0) throw new PiImageArgError("empty", `图片文件为空：${path}`, path);

    let head: Buffer;
    const fd = (() => {
      try {
        return openSync(path, "r");
      } catch {
        throw new PiImageArgError("unreadable", `图片文件无法读取：${path}`, path);
      }
    })();
    try {
      const buf = Buffer.alloc(PI_IMAGE_SNIFF_BYTES);
      const read = readSync(fd, buf, 0, PI_IMAGE_SNIFF_BYTES, 0);
      head = buf.subarray(0, read);
    } catch {
      throw new PiImageArgError("unreadable", `图片文件无法读取：${path}`, path);
    } finally {
      closeSync(fd);
    }

    const detected = sniffPiImageMime(head);
    if (!detected) {
      throw new PiImageArgError("unsupported", `图片格式不受支持或文件已损坏：${path}`, path);
    }
    const declared = normalizeDeclaredMime(img.mimeType);
    if (declared && declared !== detected) {
      throw new PiImageArgError(
        "mime-mismatch",
        `图片类型与内容不符：${path}（声明 ${declared}，实际 ${detected}）`,
        path,
      );
    }
    return { path, mimeType: detected };
  });
}

/**
 * 把 req.images 转成 pi 的 `@<path>` 参数（二进制单发路径）。校验语义见 `validatePiImages`。
 */
export function buildPiImageArgs(images: CliImageRef[] | undefined): string[] {
  return validatePiImages(images).map((img) => `@${img.path}`);
}

// 以 `@` 开头的 prompt 会被 pi 的 args.js 当成文件参数吞掉（`arg.startsWith("@")` 分支在
// 位置参数分支之前）,file-processor.js 找不到文件就 `process.exit(1)` —— 进程无任何 JSON 输出、
// 管线只看到空退出。Cortex 的委派 UI 恰好用 `@协作者` 开头,实测必踩（真实二进制复现:
// `Error: File not found: .../张三 帮我看看这段代码`）。pi 没有转义语法,只能加一个前导空格
// 把它挤出 `@` 分支;对模型而言首字符空格无语义差异。
function escapeLeadingAt(prompt: string): string {
  return prompt.startsWith("@") ? ` ${prompt}` : prompt;
}

export const piDef: AgentDef = {
  id: "pi",
  // 能力位:pi 是自包含二进制,prompt 走 argv 位置参数;不注入 MCP(走自身扩展);续接用 --session;
  // 图片走 `@<path>` 文件参数;appendSystemPrompt 原生 flag。
  promptDelivery: "argv",
  ignoredFrameTypes: IGNORED_FRAME_TYPES,
  // 细粒度已知忽略(盲区补点跳过,不刷屏):message_update 的生命周期/toolcall 子帧、user 回显
  // 与 toolUse 中间轮的 message_end。assistant 的未知 stopReason 刻意**不**忽略——那是终态卡死
  // 类协议漂移,必须保持可观测(与 pi-rpc.ts:101 的 warn 同一类信号)。
  isIgnoredFrame(frame: Record<string, unknown>): boolean {
    if (frame.type === "message_update") {
      const ev = frame.assistantMessageEvent as Record<string, unknown> | undefined;
      return typeof ev?.type === "string" && IGNORED_MESSAGE_UPDATE_SUBTYPES.has(ev.type);
    }
    if (frame.type === "message_end") {
      const message = frame.message as Record<string, unknown> | undefined;
      // --mode json 会回吐 user message 的 message_end(回显),非 assistant 一律已知忽略。
      return message?.role !== "assistant" || message.stopReason === "toolUse";
    }
    return false;
  },
  mcpInjection: "none",
  sessionResume: "resume-only",
  imageDelivery: "arg-at-path",
  appendSystemPrompt: "native-flag",
  buildArgs(req: CliStartRequest): { cmd: string; args: string[] } {
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-extensions",
    ];
    // 插件管理:--no-skills 随 useOwnSkills gate,与 claude adapter 的 --disable-slash-commands 对齐。
    //   · useOwnSkills!==true(缺省/关闭）→ 加 --no-skills 关掉 pi 原生自动发现(会话级一键关);
    //   · useOwnSkills===true → 省略 --no-skills,放开 pi 自身原生 skill 发现(~/.pi/agent/skills、
    //     ~/.agents/skills、项目 .pi/skills / .agents/skills),让 pi 用「各自原生目录」,与
    //     claude/codex 放开各自 CLI 原生发现的行为一致(修复三端不一致:此前 pi 恒关原生、只被
    //     强喂系统配置目录路径,claude/codex 却已放开原生 → 表现为「pi 用系统配置、claude/codex 用自带」)。
    // 无论开关,Cortex 已启用集合仍逐个 --skill 附加注入（实测 --no-skills 与显式 --skill 共存;
    // 开启原生时二者并存 = 原生发现 + Cortex 桥接,与 claude「原生 + --add-dir 桥接」混合模型同构）。
    if (req.useOwnSkills !== true) args.push("--no-skills");
    for (const p of req.skillPaths ?? []) args.push("--skill", p);
    // 运行模式 plan 档:只读工具白名单（pi 官方钦定 read-only 配方,物理上无 write/edit/bash）。
    // json 单发(ask 追问/oneshot)无 UI,审批 hook 失效,故只有 plan 的工具白名单有意义;
    // accept-edits/full-auto 在单发模式等价(不收窄工具)。RPC 长驻路径走 buildRpcArgs 的 toolWhitelist。
    if (req.permissionMode === "plan") args.push("--tools", planToolWhitelist(req).join(","));
    // 自定义供应商 + 委派桥接:cli.ts 已生成 extension 文件,这里多 `-e` 显式加载 + `-a` 整批信任
    //（实测 --no-extensions 与多个显式 -e 共存,-a 只加一次,仿 pi-rpc.ts buildRpcArgs）。
    //   · piExtensionPath = provider extension（apiKey 端点）
    //   · extraExtensionPaths = 委派单发的 delegate 桥接（挂 ask_<id> 工具）等
    const exts = [req.piExtensionPath, ...(req.extraExtensionPaths ?? [])].filter((p): p is string => !!p);
    if (exts.length) {
      for (const p of exts) args.push("-e", p);
      args.push("-a");
      // provider 名必须用 safeId（与 pi-providers.registerProvider 注册名同源,id 含空格/大写时才选得中）。
      if (req.provider) args.push("--provider", safeId(req.provider.id));
    }
    if (req.model) args.push("--model", req.model);
    if (req.resumeSessionId) args.push("--session", req.resumeSessionId);
    if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
    // 图片:`@<path>` 排在 prompt 之前（见上方 buildPiImageArgs 的注释:与 pi -h 的用法一致,
    // 且必须避开值型 flag 的紧后位置——此处前一个 arg 已是 --append-system-prompt 的值,安全）。
    args.push(...buildPiImageArgs(req.images));
    // prompt 是位置参数,必须在最后。
    args.push(escapeLeadingAt(req.prompt));
    // cmd 是 pi 二进制路径,cli.ts 直接 spawn 它（独立 CLI 进程,不弹 macOS Dock）。
    return { cmd: resolvePiBinary(), args };
  },

  parseLine(line: string): CliStreamEvent | CliStreamEvent[] | null {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;

    if (obj.type === "session" && typeof obj.id === "string") {
      return { type: "init", sessionId: obj.id };
    }

    if (obj.type === "message_update") {
      const ev = obj.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        return { type: "text", delta: ev.delta };
      }
      // 思考增量:reasoning 模型(deepseek 等)的 thinking_delta 归一化为 thinking 事件,
      // 与 claude adapter / pi-rpc(reasoning)对齐;丢弃会让渲染端在长思考期间无任何反馈。
      if (ev?.type === "thinking_delta" && typeof ev.delta === "string") {
        return { type: "thinking", delta: ev.delta };
      }
      return null;
    }

    if (obj.type === "tool_execution_start" && typeof obj.toolName === "string") {
      // 任务清单工具特判:todo_write(pi-todo extension)不产 tool 事件(避免过程流噪音),
      // 改产 todo 整表快照事件(与 pi-rpc.ts mapPiEvent 同款分流);空清单丢弃。
      if (obj.toolName === TODO_TOOL_NAME) {
        const todos = normalizePiTodos(obj.args);
        return todos.length > 0 ? { type: "todo", todos } : null;
      }
      return {
        type: "tool",
        name: obj.toolName,
        detail: toolDetail(obj.args),
        input: obj.args,
        phase: "start",
        toolCallId: typeof obj.toolCallId === "string" ? obj.toolCallId : undefined,
      };
    }

    if (obj.type === "tool_execution_end" && typeof obj.toolName === "string") {
      if (obj.toolName === TODO_TOOL_NAME) return null;
      return {
        type: "tool",
        name: obj.toolName,
        output: normalizeToolResult(obj.result),
        isError: !!obj.isError,
        phase: "end",
        toolCallId: typeof obj.toolCallId === "string" ? obj.toolCallId : undefined,
      };
    }

    if (obj.type === "message_end") {
      const message = obj.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") return null;
      const stopReason = message.stopReason;
      const usage = piUsageEvent(message.usage);
      if (stopReason === "stop" || stopReason === "length") {
        const result: CliStreamEvent = { type: "result", ok: true, text: joinText(message.content) };
        return usage ? [usage, result] : result;
      }
      if (stopReason === "error" || stopReason === "aborted") {
        const error =
          (typeof message.errorMessage === "string" ? message.errorMessage : undefined) ??
          diagnosticsError(message.diagnostics) ??
          String(stopReason);
        const result: CliStreamEvent = { type: "result", ok: false, error };
        return usage ? [usage, result] : result;
      }
      // stopReason:"toolUse" —— 中间轮,后续还有 message_end 收尾,这里不发 result。
      return stopReason === "toolUse" ? (usage ?? null) : null;
    }

    // agent_end 与其他事件均忽略：result 已由最后一条 assistant message_end 发出,
    // 若 agent_end 也发会覆盖前面的错误结果。
    return null;
  },
};
