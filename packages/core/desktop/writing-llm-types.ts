// 写作 LLM(inline-completion + Cmd-K 就地改写,U3）IPC 契约类型。
// ⚠️ 与 apps/desktop/src/main/ipc/writing-llm-types.ts 逐字镜像（双写契约，改动两处必须同步）。
// 续写/改写走独立 OpenAI 兼容端点直连（baseUrl/apiKey/model），独立于 timeline 日报与对话 agent 凭据。
// 独立成文件（不并入 writing-types.ts）是为降低与并行单元在 writing-types.ts 上的编辑冲突。

// 写作 LLM 配置：ghost text 打字续写与 Cmd-K 就地改写共用同一端点。
// completionEnabled 只门控 ghost text（打字续写）；Cmd-K 改写只取决于「是否配置」，不受此开关影响。
export interface WritingLlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  completionEnabled: boolean;
}

export const DEFAULT_WRITING_LLM_SETTINGS: WritingLlmSettings = {
  baseUrl: "",
  apiKey: "",
  model: "",
  completionEnabled: true,
};

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
