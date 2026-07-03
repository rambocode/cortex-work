// postChatCompletion 直测：锁定 llm:openaiComplete 与 reply 直连共用真源的请求契约——
// 尤其是「temperature 未定义则不下发该字段」的旧行为(llm:openaiComplete 依赖,间接覆盖不到)。

import { describe, it, expect } from "vitest";
import { postChatCompletion } from "./openai-chat";

/** 构造可注入的假 fetch：记录请求并返回给定响应。 */
function fakeFetch(response: { status?: number; body?: unknown; text?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const ok = (response.status ?? 200) < 300;
    return {
      ok,
      status: response.status ?? 200,
      text: async () => response.text ?? "",
      json: async () => response.body ?? {},
    } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

const OK_BODY = { choices: [{ message: { content: "  hello  " } }] };

describe("postChatCompletion", () => {
  it("temperature 未传时请求体不含 temperature 键(llm:openaiComplete 旧契约)", async () => {
    const { fetchFn, calls } = fakeFetch({ body: OK_BODY });
    await postChatCompletion({
      baseUrl: "https://api.example.com/v1",
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      fetchFn,
    });
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect("temperature" in body).toBe(false);
    expect(body.model).toBe("m1");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("temperature 传入时原样下发(reply 温度分层依赖)", async () => {
    const { fetchFn, calls } = fakeFetch({ body: OK_BODY });
    await postChatCompletion({
      baseUrl: "https://api.example.com/v1",
      model: "m1",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      temperature: 0.3,
      fetchFn,
    });
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.temperature).toBe(0.3);
  });

  it("返回原始 content,不 trim(trim 责任在调用方)", async () => {
    const { fetchFn } = fakeFetch({ body: OK_BODY });
    const out = await postChatCompletion({
      baseUrl: "https://api.example.com/v1",
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      fetchFn: fetchFn,
    });
    expect(out).toBe("  hello  ");
  });

  it("非 2xx 抛错含 HTTP 状态与响应体前缀", async () => {
    const { fetchFn } = fakeFetch({ status: 500, text: "boom" });
    await expect(
      postChatCompletion({
        baseUrl: "https://api.example.com/v1",
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        fetchFn,
      }),
    ).rejects.toThrow(/HTTP 500.*boom/);
  });

  it("无 content / 空白 content 抛「模型未返回内容」", async () => {
    const { fetchFn } = fakeFetch({ body: { choices: [{ message: { content: "   " } }] } });
    await expect(
      postChatCompletion({
        baseUrl: "https://api.example.com/v1",
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        fetchFn,
      }),
    ).rejects.toThrow("模型未返回内容");
  });
});
