// 写作 LLM(inline-completion + Cmd-K 就地改写,U3）IPC 域。
// 两条链路共用一个独立 OpenAI 兼容端点(WritingLlmSettings,独立于 timeline 与对话 agent 凭据):
//   - writing:complete —— ghost text 打字续写:前后缀窗口 → 模型返回可插入文本;
//   - writing:edit     —— Cmd-K 就地改写:前后缀 + 选区原文 + 用户指令 + <<<EDIT>>> 协议 → 替换文本;
//   - writing:llmStatus —— 探测配置态(configured/completionEnabled),渲染端据此决定挂载/隐藏入口。
//
// LLM 调用一律走 openai-chat.ts 的 postChatCompletion(URL 拼接/鉴权/错误契约的唯一真源,apiKey 不出 main)。
// prompt 构造(前后缀截断)/响应解析(去回声/去围栏/<<<EDIT>>> 提取)是纯函数,先写测试(writing-llm.test.ts)。
// 配置读取用 getPersistedState(每次读最新,支持中途改配置即时生效);store 依赖在 handler 内动态 import。

import { ipcMain } from "electron";
import { postChatCompletion, type ChatMessage } from "./openai-chat";
import {
  clampWritingMaxTokens,
  isWritingLlmConfigured,
  type WritingDebugLogEntry,
  type WritingCompletionRequest,
  type WritingCompletionResult,
  type WritingInlineEditRequest,
  type WritingInlineEditResult,
  type WritingLlmSettings,
  type WritingLlmStatus,
} from "./writing-llm-types";

// 前后缀上下文窗口(对齐 Kun inline-edit 的 6000/4000):prefix 保尾、suffix 保头。
// 主进程再兜底夹取一次(渲染端已截,防越权/超大 payload)。
export const WRITING_COMPLETION_PREFIX_WINDOW = 6_000;
export const WRITING_COMPLETION_SUFFIX_WINDOW = 4_000;

const COMPLETION_TIMEOUT_MS = 12_000; // 打字续写要快,超时短
const INLINE_EDIT_TIMEOUT_MS = 30_000; // 改写允许更久

// 续写响应的协议回声守卫短语(模型把指令原样吐回时视为无效续写)。
const COMPLETION_ECHO_INSTRUCTION = "Return only the text to insert at the cursor.";
const PROTOCOL_MARKER_RE = /<<<[ \t]*(?:PREFIX|SUFFIX|EDIT_SCOPE|EDIT)\b/i;

// 取尾 maxChars(prefix 窗口);空/未超窗原样返回。
export function clipTail(text = "", maxChars = 0): string {
  const source = String(text || "");
  if (!maxChars || source.length <= maxChars) return source;
  return source.slice(source.length - maxChars);
}

// 取头 maxChars(suffix 窗口)。
export function clipHead(text = "", maxChars = 0): string {
  const source = String(text || "");
  if (!maxChars || source.length <= maxChars) return source;
  return source.slice(0, maxChars);
}

// 边界标记块:<<<MARKER\n{text}\n>>>。sanitize 归一化 CRLF,避免注释闭合符干扰。
function markerBlock(marker: string, text = ""): string {
  return `<<<${marker}\n${String(text).replace(/\r\n?/g, "\n")}\n>>>`;
}

// 续写 chat messages:系统约束「只回可插入的纯文本」+ 用户给边界标记的前后缀。
export function buildWritingCompletionMessages(req: WritingCompletionRequest): ChatMessage[] {
  const prefix = clipTail(req.prefix, WRITING_COMPLETION_PREFIX_WINDOW);
  const suffix = clipHead(req.suffix, WRITING_COMPLETION_SUFFIX_WINDOW);
  const language = req.language || "markdown";
  return [
    {
      role: "system",
      content: [
        "You are an inline writing autocomplete engine for a Markdown editor.",
        "Continue the text at the cursor between <<<PREFIX ... >>> and <<<SUFFIX ... >>>.",
        COMPLETION_ECHO_INSTRUCTION,
        "Do not wrap the answer in quotes, Markdown fences, XML, JSON, or the boundary markers.",
        "Prefer a short, precise continuation that looks like the next few keystrokes.",
        "Return an empty response when there is no sensible continuation.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Language: ${language}.`,
        markerBlock("PREFIX", prefix),
        markerBlock("SUFFIX", suffix),
      ].join("\n"),
    },
  ];
}

// 去围栏 + 去包裹引号,不 trim(保留续写前导空白,如 " and then")。
function dequoteAndDefence(normalized: string): string {
  const trimmed = normalized.trim();
  if (!trimmed) return "";
  const fenced = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fenced) return fenced[1] ?? "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return normalized;
}

// 解析续写响应:回声/协议标记 → 空;否则去围栏/引号后返回可插入文本。
export function parseWritingCompletionResponse(raw: string): string {
  const normalized = String(raw ?? "").replace(/\r\n?/g, "\n").replaceAll("\0", "");
  const trimmed = normalized.trim();
  if (!trimmed) return "";
  // 回声守卫:模型把边界块或指令原样吐回,不是真续写。
  if (PROTOCOL_MARKER_RE.test(trimmed) || trimmed.includes(COMPLETION_ECHO_INSTRUCTION)) return "";
  return dequoteAndDefence(normalized);
}

// Cmd-K 改写 chat messages:系统约束返回 <<<EDIT>>> 替换块 + 用户给前后缀/原文/指令。
export function buildWritingInlineEditMessages(req: WritingInlineEditRequest): ChatMessage[] {
  const prefix = clipTail(req.prefix, WRITING_COMPLETION_PREFIX_WINDOW);
  const suffix = clipHead(req.suffix, WRITING_COMPLETION_SUFFIX_WINDOW);
  const language = req.language || "markdown";
  return [
    {
      role: "system",
      content: [
        "You perform an in-place rewrite of the user's selected Markdown text.",
        "Reason from <<<PREFIX ... >>>, <<<EDIT_SCOPE ... >>>, and <<<SUFFIX ... >>>.",
        "Return ONLY the replacement inside a single action block, nothing else:",
        "<<<EDIT",
        "replacement text for the editable scope",
        ">>>",
        "Do not include explanations, before/after labels, or unchanged surrounding text.",
        "Preserve Markdown structure and local voice unless the instruction says otherwise.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Language: ${language}.`,
        `User instruction: ${String(req.instruction || "").replace(/\r\n?/g, "\n")}`,
        markerBlock("PREFIX", prefix),
        markerBlock("EDIT_SCOPE", req.original),
        markerBlock("SUFFIX", suffix),
      ].join("\n"),
    },
  ];
}

// 清洗 <<<EDIT>>> 体:剥尾部 marker 残留/换行 → trim → 去围栏/引号。
function cleanEditBody(raw: string): string {
  let t = String(raw ?? "").replace(/\r\n?/g, "\n").replaceAll("\0", "");
  t = t.replace(/\n?>>>[\s\S]*$/, "").trim(); // 去掉闭合 >>> 及其后一切
  if (!t) return "";
  const fenced = t.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fenced) return (fenced[1] ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// 剥离残留协议 marker(兜底路径:整段当替换文本时先清 marker soup)。
function stripEditMarkers(text: string): string {
  return text
    .replace(/<<<[ \t]*(?:PREFIX|SUFFIX|EDIT_SCOPE|EDIT)\b[ \t]*/gi, "")
    .replace(/>>>/g, "")
    .trim();
}

// 解析改写响应:提取 <<<EDIT ... >>> 替换体;只回声输入边界(无 EDIT)→ 空;兜底整段当替换文本。
export function parseWritingInlineEditReplacement(raw: string): string {
  const normalized = String(raw ?? "").replace(/\r\n?/g, "\n").replaceAll("\0", "");
  const trimmed = normalized.trim();
  if (!trimmed) return "";
  const hasEdit = /<<<[ \t]*EDIT\b/i.test(trimmed);
  // 只回声输入边界(PREFIX/SUFFIX/EDIT_SCOPE)、没给 EDIT → 无效改写。
  if (!hasEdit && /<<<[ \t]*(?:PREFIX|SUFFIX|EDIT_SCOPE)\b/i.test(trimmed)) return "";
  if (hasEdit) {
    // 体在首个闭合 >>> 或下一个 marker 处终止,避免丢 >>> 时吞掉后续块(包尾语场景)。
    const m = /<<<[ \t]*EDIT\b[ \t]*\n?([\s\S]*?)(?:\n?>>>|<<<[ \t]*(?:PREFIX|SUFFIX|EDIT_SCOPE|EDIT)\b|$)/i.exec(
      trimmed,
    );
    if (m) return cleanEditBody(m[1] ?? "");
  }
  const labeled = trimmed.match(/^(?:edit|replacement|replace|new text|改写|替换|修改后)[:：]\s*([\s\S]*)$/i);
  if (labeled) return cleanEditBody(labeled[1] ?? "");
  return cleanEditBody(stripEditMarkers(normalized));
}

// 读最新写作 LLM 配置(每次读盘,支持中途改配置即时生效)。store 依赖动态 import(保持模块图轻)。
async function loadWritingLlmSettings(): Promise<WritingLlmSettings | undefined> {
  const { getPersistedState } = await import("./store");
  return (await getPersistedState()).writingLlmSettings;
}

// 写作日志环形缓冲:保留最近 N 条续写/改写调用记录(内存,进程重启即清)。只记元信息不留正文。
const WRITING_DEBUG_LOG_MAX = 30;
const writingDebugLog: WritingDebugLogEntry[] = [];
let writingDebugLogSeq = 0;

// 记录一条调用:newest-first 入队,超上限裁尾。
function recordWritingDebug(entry: Omit<WritingDebugLogEntry, "id">): void {
  writingDebugLog.unshift({ id: `wl-${Date.now().toString(36)}-${(writingDebugLogSeq++).toString(36)}`, ...entry });
  if (writingDebugLog.length > WRITING_DEBUG_LOG_MAX) writingDebugLog.length = WRITING_DEBUG_LOG_MAX;
}

// 注册写作 LLM IPC:llmStatus(探测)+ complete(续写)+ edit(改写)+ 写作日志(查看/清空)。全部失败回可读 message,不抛。
export function registerWritingLlmHandlers(): void {
  // 配置态探测:未配置 → configured=false,渲染端隐藏续写/改写入口。探测失败一律按未配置。
  ipcMain.handle("writing:llmStatus", async (): Promise<WritingLlmStatus> => {
    try {
      const s = await loadWritingLlmSettings();
      return {
        configured: isWritingLlmConfigured(s),
        completionEnabled: s?.completionEnabled !== false,
      };
    } catch {
      return { configured: false, completionEnabled: false };
    }
  });

  // ghost text 续写:未配置直接失败(渲染端本不会调,双重兜底);模型无内容 → completion 空串。
  ipcMain.handle(
    "writing:complete",
    async (_e, req: WritingCompletionRequest): Promise<WritingCompletionResult> => {
      const s = await loadWritingLlmSettings();
      if (!isWritingLlmConfigured(s)) return { ok: false, message: "写作模型未配置" };
      const t0 = Date.now();
      try {
        const raw = await postChatCompletion({
          baseUrl: s!.baseUrl,
          apiKey: s!.apiKey || undefined,
          model: s!.model,
          messages: buildWritingCompletionMessages(req),
          // 续写长度上限由设置的 maxTokens 决定（夹取兜底），对齐 Kun 短建议长度。
          maxTokens: clampWritingMaxTokens(s!.maxTokens),
          timeoutMs: COMPLETION_TIMEOUT_MS,
        });
        const completion = parseWritingCompletionResponse(raw);
        recordWritingDebug({ kind: "complete", ts: t0, model: s!.model, ok: true, ms: Date.now() - t0, chars: completion.length });
        return { ok: true, completion };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordWritingDebug({ kind: "complete", ts: t0, model: s!.model, ok: false, ms: Date.now() - t0, chars: 0, error: message });
        return { ok: false, message };
      }
    },
  );

  // Cmd-K 就地改写:未配置直接失败;返回替换文本(空串表示无有效改写,渲染端不进审阅)。
  ipcMain.handle(
    "writing:edit",
    async (_e, req: WritingInlineEditRequest): Promise<WritingInlineEditResult> => {
      const s = await loadWritingLlmSettings();
      if (!isWritingLlmConfigured(s)) return { ok: false, message: "写作模型未配置" };
      const t0 = Date.now();
      try {
        const raw = await postChatCompletion({
          baseUrl: s!.baseUrl,
          apiKey: s!.apiKey || undefined,
          model: s!.model,
          messages: buildWritingInlineEditMessages(req),
          timeoutMs: INLINE_EDIT_TIMEOUT_MS,
        });
        const replacement = parseWritingInlineEditReplacement(raw);
        recordWritingDebug({ kind: "edit", ts: t0, model: s!.model, ok: true, ms: Date.now() - t0, chars: replacement.length });
        return { ok: true, replacement };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordWritingDebug({ kind: "edit", ts: t0, model: s!.model, ok: false, ms: Date.now() - t0, chars: 0, error: message });
        return { ok: false, message };
      }
    },
  );

  // 写作日志:查看最近调用(newest-first 副本)/ 清空。供设置里排障。
  ipcMain.handle("writing:debugLog", async (): Promise<WritingDebugLogEntry[]> => [...writingDebugLog]);
  ipcMain.handle("writing:debugLogClear", async (): Promise<void> => {
    writingDebugLog.length = 0;
  });
}
