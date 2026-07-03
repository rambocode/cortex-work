import { describe, it, expect } from "vitest";
import { generateDraft, EmptyDraftError } from "./draft-generator";
import type { ReplyPrompt } from "@cortex-work/core/reply/prompt-builder";
import type { ResolvedReplyModel } from "./resolve-model";

const PROMPT: ReplyPrompt = { system: "SYS", user: "USER" };

const TARGET: ResolvedReplyModel = {
  providerId: "reply",
  providerName: "Reply",
  baseUrl: "https://api.test/v1",
  apiKey: "sk-test",
  model: "m1",
};

// 组装一个返回指定 content 的假 fetch，并记录收到的 url / init 以断言请求构造。
function makeFetch(content: string, opts?: { onCall?: (url: string, init: RequestInit) => void }) {
  return (async (url: string, init: RequestInit) => {
    opts?.onCall?.(url, init);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("REPLY_TEMPERATURES 温度分层", () => {
  it("锁定源项目契约值 0.3/0.9/0.2,漂移即报红", async () => {
    const { REPLY_TEMPERATURES } = await import("./draft-generator");
    expect(REPLY_TEMPERATURES).toEqual({ first: 0.3, variant: 0.9, distill: 0.2 });
  });
});

describe("generateDraft 请求构造", () => {
  it("拼 chat completions URL、带 Authorization、system+user 两条消息与 temperature 透传", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetchFn = makeFetch("你好，稍后回复你。", {
      onCall: (u, i) => {
        url = u;
        init = i;
      },
    });
    const result = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn });
    expect(result).toBe("你好，稍后回复你。");

    expect(url).toBe("https://api.test/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("m1");
    expect(body.temperature).toBe(0.3);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
  });
});

describe("generateDraft sad path", () => {
  it("非 2xx → 抛错含状态码与响应体前 200 字符", async () => {
    const fetchFn = (async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    })) as unknown as typeof fetch;
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn }),
    ).rejects.toThrow(/HTTP 429.*rate limited/);
  });

  it("choices content 缺失/空 → 抛「模型未返回内容」", async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "   " } }] }),
    })) as unknown as typeof fetch;
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn }),
    ).rejects.toThrow("模型未返回内容");
  });

  it("清洗后为空（只有空围栏）→ EmptyDraftError", async () => {
    const fetchFn = makeFetch("```\n\n```");
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn }),
    ).rejects.toBeInstanceOf(EmptyDraftError);
  });
});

describe("generateDraft 输出清洗（经 cleanAgentOutput）", () => {
  it("剥 markdown 围栏返回内层正文", async () => {
    const fetchFn = makeFetch("```text\n今天下午三点见。\n```");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.9 }, { fetchFn });
    expect(res).toBe("今天下午三点见。");
  });

  it("脱去成对包裹引号", async () => {
    const fetchFn = makeFetch('"收到，谢谢！"');
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.9 }, { fetchFn });
    expect(res).toBe("收到，谢谢！");
  });
});

describe("generateDraft 取消信号", () => {
  it("调用方 signal 已 abort → 请求随之中止（fetch 收到 aborted signal）", async () => {
    const controller = new AbortController();
    controller.abort();
    let seenSignal: AbortSignal | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seenSignal = init.signal ?? undefined;
      // 组合 signal 应已处于 aborted 态（AbortSignal.any 短路）。
      if (seenSignal?.aborted) throw new DOMException("aborted", "AbortError");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3, signal: controller.signal }, { fetchFn }),
    ).rejects.toThrow(/abort/i);
    expect(seenSignal?.aborted).toBe(true);
  });
});
