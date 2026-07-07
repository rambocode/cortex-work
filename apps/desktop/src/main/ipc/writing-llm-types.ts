// 写作 LLM(inline-completion + Cmd-K 就地改写,U3）IPC 契约类型。
// ⚠️ 与 packages/core/desktop/writing-llm-types.ts 逐字镜像（双写契约，改动两处必须同步）。
// 续写/改写走独立 OpenAI 兼容端点直连（baseUrl/apiKey/model），独立于 timeline 日报与对话 agent 凭据。
// 独立成文件（不并入 writing-types.ts）是为降低与并行单元在 writing-types.ts 上的编辑冲突。

// 写作 LLM 配置：ghost text 打字续写与 Cmd-K 就地改写共用同一端点。
// completionEnabled 只门控 ghost text（打字续写）；Cmd-K 改写只取决于「是否配置」，不受此开关影响。
// 高级调优（对齐 Kun）：debounceMs=触发节奏（真正接进 ghost-text 去抖）；maxTokens=续写最大长度（传给续写请求）。
export interface WritingLlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  completionEnabled: boolean;
  // 续写触发去抖（ms，Kun 口径 150–5000，默认 650）。替代渲染端硬编码 600ms。
  debounceMs: number;
  // 续写最大长度（tokens，Kun 口径 16–512，默认 96）。传给续写请求的 max_tokens。
  maxTokens: number;
}

// 调优参数范围/默认（对齐 Kun WRITE_INLINE_COMPLETION_* schema）。
export const WRITING_LLM_DEBOUNCE_MIN = 150;
export const WRITING_LLM_DEBOUNCE_MAX = 5_000;
export const WRITING_LLM_DEBOUNCE_DEFAULT = 650;
export const WRITING_LLM_MAX_TOKENS_MIN = 16;
export const WRITING_LLM_MAX_TOKENS_MAX = 512;
export const WRITING_LLM_MAX_TOKENS_DEFAULT = 96;

export const DEFAULT_WRITING_LLM_SETTINGS: WritingLlmSettings = {
  baseUrl: "",
  apiKey: "",
  model: "",
  completionEnabled: true,
  debounceMs: WRITING_LLM_DEBOUNCE_DEFAULT,
  maxTokens: WRITING_LLM_MAX_TOKENS_DEFAULT,
};

// 调优参数夹取（非数值/越界回落默认）。渲染端与主进程消费前都过一遍，兼容旧档缺字段。
export function clampWritingDebounceMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return WRITING_LLM_DEBOUNCE_DEFAULT;
  return Math.round(Math.max(WRITING_LLM_DEBOUNCE_MIN, Math.min(WRITING_LLM_DEBOUNCE_MAX, n)));
}
export function clampWritingMaxTokens(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return WRITING_LLM_MAX_TOKENS_DEFAULT;
  return Math.round(Math.max(WRITING_LLM_MAX_TOKENS_MIN, Math.min(WRITING_LLM_MAX_TOKENS_MAX, n)));
}

// 写作日志一条：最近一次续写(complete)/改写(edit)的 LLM 调用记录（供设置里排障查看）。
// 只记元信息（时间/模型/耗时/结果字符数/成败/错误），不留正文，避免日志泄露文档内容。
export interface WritingDebugLogEntry {
  id: string;
  kind: "complete" | "edit";
  ts: number; // 发起时间戳（ms）
  model: string;
  ok: boolean;
  ms: number; // 耗时（ms）
  chars: number; // 结果字符数（ok 时）；失败为 0
  error?: string; // 失败原因（可读）
}

// 是否已配置：baseUrl 与 model 均非空（apiKey 对本地端点可空）。
// 未配置 → 渲染端隐藏续写/改写入口（降级），主进程 handler 也据此直接回失败（双重兜底）。
export function isWritingLlmConfigured(s: WritingLlmSettings | undefined | null): boolean {
  return !!s && s.baseUrl.trim().length > 0 && s.model.trim().length > 0;
}

// ghost text 续写请求：光标前后缀窗口（渲染端已按 PREFIX/SUFFIX 窗口截取，主进程再兜底夹取）。
export interface WritingCompletionRequest {
  prefix: string;
  suffix: string;
  language?: string;
}

// 续写结果：ok 时 completion 可能为空串（无合理续写，渲染端不显 ghost text）；失败给可读 message。
export type WritingCompletionResult =
  | { ok: true; completion: string }
  | { ok: false; message: string };

// Cmd-K 就地改写请求：选区原文 original + 前后缀上下文 + 用户改写指令 instruction。
export interface WritingInlineEditRequest {
  prefix: string;
  suffix: string;
  original: string;
  instruction: string;
  language?: string;
}

// 改写结果：ok 时 replacement 为替换文本（空串表示模型未给出有效改写，渲染端不进审阅）；失败给 message。
export type WritingInlineEditResult =
  | { ok: true; replacement: string }
  | { ok: false; message: string };

// 续写/改写可用性探测结果：configured=是否配置（决定 Cmd-K 与 ghost text 是否可用）；
// completionEnabled=ghost text 开关（configured 为真时才有意义）。
export interface WritingLlmStatus {
  configured: boolean;
  completionEnabled: boolean;
}
