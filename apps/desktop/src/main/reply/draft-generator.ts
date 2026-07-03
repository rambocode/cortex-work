// 草稿生成器（U7 / R4）：对 reply 专属解析出的 OpenAI 兼容供应商，直连 /v1/chat/completions
// 单发生成一条回复草稿，无会话。
//
// 关键取舍（KTD3，生成通道从「默认 agent CLI」改为「模型直连」）：
//   - agent CLI 冷启动重（数百 ms~秒级）且无 temperature，快捷回复要秒回；改直连既快、又能分层温度。
//   - 温度分层（源项目契约经直连恢复）：首条候选 0.3、预生成/翻牌 0.9、语气蒸馏 0.2；由调用方按场景传入。
//     避重列表机制（buildReplyPrompt.avoidReplies）保留不动，与温度叠加提升多样性。
//   - system 走独立消息通道（直连支持 system role，不再拼接进 user）。
//   - 请求构造复用既有工具：chatCompletionsUrl（../ipc/push-sign）+ authHeaders（whisper/transcribe-auth），
//     与 ipc/llm.ts 的 llm:openaiComplete handler 写法一致（apiKey 不出 main，规避 renderer CORS）。
//   - 超时 30s（快捷场景比 llm.ts 的 60s 短，避免用户久等）；与调用方 signal 用 AbortSignal.any 组合，
//     controller 在 esc / 重入时 abort 即中止在途请求（Electron 的 Node ≥20 支持 AbortSignal.any）。
//   - 输出经 cleanAgentOutput 清洗（剥围栏 / 特殊 token / 开场白 / 引号）后返回；清洗后为空视为「空候选」
//     抛 EmptyDraftError，由 controller 推气泡错误态（不静默回 idle）。

import { chatCompletionsUrl } from "../ipc/push-sign";
import { authHeaders } from "../capabilities/whisper/transcribe-auth";
import type { ReplyPrompt } from "@cortex-work/core/reply/prompt-builder";
import type { ResolvedReplyModel } from "./resolve-model";
import { cleanAgentOutput } from "./controller-state";

/** 清洗后草稿为空（模型只吐了围栏 / 寒暄 / 空白）。controller 据此推「空候选」错误态。 */
export class EmptyDraftError extends Error {
  constructor() {
    super("模型返回空草稿");
    this.name = "EmptyDraftError";
  }
}

/** 直连请求超时：快捷回复场景比 llm.ts 的 60s 更短，避免用户久等。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 温度分层（源项目 0.3/0.9/0.2 经直连恢复）：
 *   - first：首条候选求稳（低温更贴切）；
 *   - variant：预生成翻牌候选求多样（高温 + 避重列表）；
 *   - distill：语气蒸馏求确定（低温少发散，提炼稳定风格要点）。
 */
export const REPLY_TEMPERATURES = {
  first: 0.3,
  variant: 0.9,
  distill: 0.2,
} as const;

/** 生成器依赖注入口（测试可替换 fetchFn，默认走全局 fetch，从不真发网络请求）。 */
export interface DraftGeneratorDeps {
  fetchFn?: typeof fetch;
}

export interface GenerateDraftParams {
  prompt: ReplyPrompt;
  /** 已解析的直连目标（供应商 baseUrl/apiKey/model；由 resolveReplyModel 产出）。 */
  target: ResolvedReplyModel;
  /** 采样温度（首条 0.3 / 预生成翻牌 0.9 / 蒸馏 0.2，由调用方按场景传）。 */
  temperature: number;
  /** 取消信号：controller esc / 重入时 abort，中止在途请求。 */
  signal?: AbortSignal;
}

/**
 * 底层单发补全：system+user 两条消息直连 chat completions（带 temperature 与取消信号），返回
 * 模型原始输出（不清洗）。语气蒸馏走此入口（原始 bullet 行交 cleanDistilledRules 过滤，不能被
 * cleanAgentOutput 误伤）；候选生成走下方 generateDraft 包装。非 2xx / 无内容抛错。
 */
export async function chatComplete(
  params: GenerateDraftParams,
  deps: DraftGeneratorDeps = {},
): Promise<string> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const { target, prompt, temperature } = params;

  const url = chatCompletionsUrl(target.baseUrl);
  // 组合调用方 signal 与超时 signal：任一触发即中止（AbortSignal.any 短路，Node ≥20）。
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders(target.baseUrl, target.apiKey)),
    },
    body: JSON.stringify({
      model: target.model,
      // system 走独立消息（直连有 system 通道，不再拼接进 user）。
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`模型接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型未返回内容");
  return content;
}

/**
 * 单发生成一条候选草稿：chatComplete 直连 → cleanAgentOutput 清洗（剥围栏/寒暄/引号）→
 * 非空返回，空则抛 EmptyDraftError（controller 推「空候选」错误态）。
 */
export async function generateDraft(
  params: GenerateDraftParams,
  deps: DraftGeneratorDeps = {},
): Promise<string> {
  const content = await chatComplete(params, deps);
  const cleaned = cleanAgentOutput(content);
  if (cleaned.length === 0) throw new EmptyDraftError();
  return cleaned;
}
