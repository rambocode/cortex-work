// 主进程内部的**文本补全适配层**：把「返回一段文本、失败就抛错」这套既有调用契约，
// 架到 `providers/gateway.ts`（Pi Model Gateway）之上。
//
// ⚠️ 文件名是历史包袱。收编前（阶段③·4.1 之前）这里确实自己拼 OpenAI 兼容的 chat
// completions 端点并直接发请求，是全仓唯一的出口；现在协议分发、认证、thinking 档位翻译全部交给
// pi 的 `Models`，"openai" 三个字已经名不副实 —— 它现在能说 Catalog 里的全部 10 种 api。
// 保留路径只是为了不动 research/planner 那几个只引 `stripTruncationMarker` 的文件；
// 后续可单独做一次纯重命名。
//
// 寻址方式随之改变：调用方给 `{providerId, modelId}`（Catalog 引用），**不再给 baseUrl/apiKey**。
// 明文凭据从此不进业务模块，只在主进程的 safeStorage 金库与 pi 运行时之间流动。
//
// 保留这一层而不是让 6 个调用方各自直调 Gateway，是因为它们共享三条既有语义：
//   1. 成功返回**原始文本**（不 trim、不清洗），由调用方按场景处理；
//   2. 失败**抛错**（而不是返回 ok:false），且错误的 name / 文案是上游归类的依据；
//   3. 截断用 TRUNCATED_MARKER 尾标记表达（见下）。

import { runGatewayComplete, runGatewayStream, type GatewayOutcome } from "../providers/gateway";
import type { ModelRef } from "../providers/contract";
import type { PiGatewayRuntime } from "../providers/pi-runtime";

/// 输出被 token 上限截断的标记。
///
/// 附在返回文本末尾而不是抛错：截断的输出**有时仍然可用**（比如报告正文截掉结尾一段，
/// 总比整个 Session 失败好），所以不能一律当失败处理；但解析失败时，
/// 调用方要能一眼看出是截断而不是模型乱写——真实踩过：计划 JSON 被截断，
/// 报出来的却是「输出不是合法 JSON」，据此去查 JSON 提取逻辑完全查不到根因。
///
/// 用 \u0000 开头：正常模型输出不会包含 NUL，不会误判。
///
/// 收编后的来源变了但语义未变：以前看 `choices[0].finish_reason === "length"`，
/// 现在看 pi 的 `stopReason === "length"`（Gateway 归一成 `outcome.truncated`）。
export const TRUNCATED_MARKER = "\n\u0000[truncated:length]";

/// 判断一段模型输出是否被截断，并剥掉标记。
export function stripTruncationMarker(text: string): { text: string; truncated: boolean } {
  if (text.endsWith(TRUNCATED_MARKER)) {
    return { text: text.slice(0, -TRUNCATED_MARKER.length), truncated: true };
  }
  return { text, truncated: false };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PostChatCompletionParams extends ModelRef {
  messages: ChatMessage[];
  /** 采样温度;不传则不下发该字段(沿用供应商默认)。 */
  temperature?: number;
  /** 最大生成 tokens;不传则不下发(沿用供应商默认)。写作续写用它约束建议长度。 */
  maxTokens?: number;
  /** pi 的思考档位（minimal/low/medium/high/xhigh/max）。模型不支持时 Gateway 自动忽略。 */
  thinkingLevel?: string;
  /** 调用方取消信号;与超时信号组合,任一触发即中止。 */
  signal?: AbortSignal;
  /** 超时毫秒数,默认 60s(reply 快捷场景传更短值)。 */
  timeoutMs?: number;
  /** 测试注入口:替身 pi 运行时。生产不传,走真实 pi `Models`。 */
  runtime?: PiGatewayRuntime;
}

/**
 * 把 Gateway 的结构化失败翻回本层的「抛错」契约。
 *
 * 为什么要保住 `err.name`：研究引擎的 safeErrorMessage 用 `name === "AbortError"` 区分
 * 「取消/超时」与真实故障（research-model-gateway.ts）。收编后底层不再抛 DOMException，
 * 必须在这里把取消态重新打上同一个 name，否则那条分支会静默失效、取消被报成「调用失败」。
 */
function throwOutcome(outcome: GatewayOutcome): never {
  const error = new Error(outcome.error ?? "模型调用失败");
  if (outcome.errorKind === "aborted") error.name = "AbortError";
  throw error;
}

/** 把 Gateway 结果翻成本层契约：成功返回原文（截断则附标记），失败抛错。 */
function unwrap(outcome: GatewayOutcome): string {
  if (!outcome.ok) throwOutcome(outcome);
  // **内容非空但仍被截断**是最阴险的一种：调用方拿到一段看似正常、实际断在半路的 JSON，
  // 报出来的却是「输出不是合法 JSON」——真实踩过，据此去查 JSON 提取逻辑完全查不到根因。
  // 在文本尾部附一个标记，让上层的解析失败信息里带上真正的原因。
  return outcome.truncated ? `${outcome.text}${TRUNCATED_MARKER}` : outcome.text;
}

/** 把本层入参搬成 Gateway 请求 + 调用选项（两处共用，避免 complete / stream 漂移）。 */
function toGatewayCall(params: PostChatCompletionParams): {
  req: Parameters<typeof runGatewayComplete>[0];
  options: Parameters<typeof runGatewayComplete>[1];
} {
  return {
    req: {
      providerId: params.providerId,
      modelId: params.modelId,
      messages: params.messages,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
    },
    options: {
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.runtime ? { runtime: params.runtime } : {}),
    },
  };
}

/**
 * 单发补全,返回模型原始输出(不 trim、不清洗,交调用方按场景处理)。
 * 失败抛错;模型引用无效 / 未认证时错误来自 Gateway 的 config 分类(**不会回退到别的模型**)。
 */
export async function postChatCompletion(params: PostChatCompletionParams): Promise<string> {
  const { req, options } = toGatewayCall(params);
  return unwrap(await runGatewayComplete(req, options));
}

/**
 * 流式补全：每收到一段增量就以「累计全文」回调 onDelta，结束返回完整原始输出
 * （契约同 postChatCompletion）。reply 首条候选用它做边生成边展示。
 *
 * onDelta 给**累计**而不是增量，是这一层的历史契约（研究引擎在自己那侧切成增量下发 IPC，
 * 见 research-model-gateway.completeStreaming 的注释）。Gateway 给的是增量，这里累加还原。
 */
export async function postChatCompletionStream(
  params: PostChatCompletionParams & { onDelta?: (accumulated: string) => void },
): Promise<string> {
  const { req, options } = toGatewayCall(params);
  let acc = "";
  const outcome = await runGatewayStream(
    req,
    (event) => {
      if (event.type !== "text") return;
      acc += event.delta;
      params.onDelta?.(acc);
    },
    options,
  );
  return unwrap(outcome);
}
