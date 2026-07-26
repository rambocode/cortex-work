// OpenAI 兼容 chat completions 单发补全的唯一真源(主进程)。
// llm:openaiComplete handler(日报等一次性补全)与 reply 直连生成/蒸馏(draft-generator)共用,
// 把 URL 拼接、鉴权头、请求体、非 2xx 错误契约、choices[0].message.content 提取收敛到一处——
// 响应格式或错误文案变更只改这里。在主进程发请求:规避 renderer CORS,且 apiKey 不出 main。

import { chatCompletionsUrl } from "./push-sign";
import { authHeaders } from "../capabilities/whisper/transcribe-auth";

/// 输出被 token 上限截断的标记。
///
/// 附在返回文本末尾而不是抛错：截断的输出**有时仍然可用**（比如报告正文截掉结尾一段，
/// 总比整个 Session 失败好），所以不能一律当失败处理；但解析失败时，
/// 调用方要能一眼看出是截断而不是模型乱写——真实踩过：计划 JSON 被截断，
/// 报出来的却是「输出不是合法 JSON」，据此去查 JSON 提取逻辑完全查不到根因。
///
/// 用 \u0000 开头：正常模型输出不会包含 NUL，不会误判。
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

export interface PostChatCompletionParams {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  /** 采样温度;不传则不下发该字段(沿用供应商默认,保持 llm:openaiComplete 旧行为)。 */
  temperature?: number;
  /** 最大生成 tokens;不传则不下发 max_tokens(沿用供应商默认)。写作续写用它约束建议长度。 */
  maxTokens?: number;
  /** 调用方取消信号;与超时信号 AbortSignal.any 组合,任一触发即中止(Node ≥20)。 */
  signal?: AbortSignal;
  /** 超时毫秒数,默认 60s(reply 快捷场景传更短值)。 */
  timeoutMs?: number;
  /** 测试注入口,默认走全局 fetch。 */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 单发 chat completions,返回模型原始输出(不 trim、不清洗,交调用方按场景处理)。
 * 非 2xx 抛「模型接口 HTTP ...」(带响应体前 200 字符),无内容抛「模型未返回内容」。
 */
export async function postChatCompletion(params: PostChatCompletionParams): Promise<string> {
  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  const res = await fetchFn(chatCompletionsUrl(params.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders(params.baseUrl, params.apiKey)),
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`模型接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    // 推理模型（reasoning model）在 token 预算被思考耗尽时会返回空 content、
    // 内容全在 reasoning_content 里。区分开报错，否则调用方只看到「模型未返回内容」，
    // 完全指不到「预算不够」这个真正可操作的原因。
    if (choice?.finish_reason === "length") {
      throw new Error("模型输出被 token 上限截断（finish_reason=length），请提高 maxTokens");
    }
    throw new Error("模型未返回内容");
  }
  // **内容非空但仍被截断**是最阴险的一种：调用方拿到一段看似正常、实际断在半路的 JSON，
  // 报出来的却是「输出不是合法 JSON」——真实踩过，据此去查 JSON 提取逻辑完全查不到根因。
  // 在文本尾部附一个标记，让上层的解析失败信息里带上真正的原因。
  if (choice?.finish_reason === "length") {
    return `${content}${TRUNCATED_MARKER}`;
  }
  return content;
}

/**
 * 流式 chat completions（SSE）：每收到一段增量就以「累计全文」回调 onDelta，结束返回完整原始
 * 输出（不 trim、不清洗，契约同 postChatCompletion）。reply 首条候选用它做边生成边展示。
 * 容错：供应商无视 stream:true 返回普通 JSON 时，回退解析 choices[0].message.content。
 */
export async function postChatCompletionStream(
  params: PostChatCompletionParams & { onDelta?: (accumulated: string) => void },
): Promise<string> {
  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  const res = await fetchFn(chatCompletionsUrl(params.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders(params.baseUrl, params.apiKey)),
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`模型接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("模型未返回内容");
  const decoder = new TextDecoder();
  let acc = ""; // 已累计的正文
  let raw = ""; // 原始响应全文（非 SSE 回退解析用）
  let lineBuf = ""; // 跨 chunk 的半行缓冲（SSE 事件可能被网络分包截断）
  let finishReason: string | undefined;
  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const evt = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; finish_reason?: string }[];
      };
      const choice = evt.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        acc += delta;
        params.onDelta?.(acc);
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    } catch {
      // 非 JSON 的 data 行（心跳/注释）忽略
    }
  };
  // 逐行消费 SSE：await reader.read() 期间 signal 触发会使下一次 read 抛 AbortError，向上冒泡。
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    lineBuf += chunk;
    for (;;) {
      const nl = lineBuf.indexOf("\n");
      if (nl < 0) break;
      consumeLine(lineBuf.slice(0, nl));
      lineBuf = lineBuf.slice(nl + 1);
    }
  }
  consumeLine(lineBuf);

  if (acc.trim().length > 0) {
    return finishReason === "length" ? `${acc}${TRUNCATED_MARKER}` : acc;
  }
  // 回退：部分兼容供应商无视 stream:true 直接回普通 JSON
  try {
    const data = JSON.parse(raw) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string" && content.trim()) {
      params.onDelta?.(content);
      return choice?.finish_reason === "length" ? `${content}${TRUNCATED_MARKER}` : content;
    }
  } catch {
    // 非 JSON：落入统一「无内容」错误
  }
  throw new Error("模型未返回内容");
}
