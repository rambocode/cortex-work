// OpenAI 兼容 chat completions 单发补全的唯一真源(主进程)。
// llm:openaiComplete handler(日报等一次性补全)与 reply 直连生成/蒸馏(draft-generator)共用,
// 把 URL 拼接、鉴权头、请求体、非 2xx 错误契约、choices[0].message.content 提取收敛到一处——
// 响应格式或错误文案变更只改这里。在主进程发请求:规避 renderer CORS,且 apiKey 不出 main。

import { chatCompletionsUrl } from "./push-sign";
import { authHeaders } from "../capabilities/whisper/transcribe-auth";

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
