import { describe, it, expect } from "vitest";
import {
  generateDraft,
  generateDraftStream,
  displayableStreamText,
  EmptyDraftError,
} from "./draft-generator";
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
    expect(result).toEqual({ text: "你好，稍后回复你。", stance: null });

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
    expect(res.text).toBe("今天下午三点见。");
  });

  it("脱去成对包裹引号", async () => {
    const fetchFn = makeFetch('"收到，谢谢！"');
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.9 }, { fetchFn });
    expect(res.text).toBe("收到，谢谢！");
  });
});

describe("generateDraft 立场标记行解析", () => {
  it("首行立场标记 → 剥离并回填 stance，正文不含标记", async () => {
    const fetchFn = makeFetch("[stance:agree]\n好，这块我们来承接。");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn });
    expect(res).toEqual({ text: "好，这块我们来承接。", stance: "agree" });
  });

  it("围栏包裹的标记行也可解析（先剥围栏再剥标记）", async () => {
    const fetchFn = makeFetch("```\n[stance:unsure]\n量级大概多少？\n```");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn });
    expect(res).toEqual({ text: "量级大概多少？", stance: "unsure" });
  });

  it("标记后正文整体被引号包裹 → 剥标记后再清洗脱壳", async () => {
    const fetchFn = makeFetch('[stance:reject]\n"这个暂时接不了。"');
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn });
    expect(res).toEqual({ text: "这个暂时接不了。", stance: "reject" });
  });

  it("[stance:none] 归一为 null", async () => {
    const fetchFn = makeFetch("[stance:none]\n哈哈好的");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn });
    expect(res).toEqual({ text: "哈哈好的", stance: null });
  });

  it("剥标记后无正文 → EmptyDraftError", async () => {
    const fetchFn = makeFetch("[stance:agree]");
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { fetchFn }),
    ).rejects.toBeInstanceOf(EmptyDraftError);
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

// ── 流式生成 ──────────────────────────────────────────────────────────────────

/** 组装一个按序吐 SSE chunk 的假 fetch（chunk 粒度即网络分包粒度，可模拟半行截断）。 */
function makeStreamFetch(
  chunks: string[],
  opts?: { onCall?: (url: string, init: RequestInit) => void },
) {
  return (async (url: string, init: RequestInit) => {
    opts?.onCall?.(url, init);
    let i = 0;
    return {
      ok: true,
      body: {
        getReader() {
          return {
            read: async () =>
              i < chunks.length
                ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
                : { done: true, value: undefined },
          };
        },
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 把增量 content 包成一行 SSE data 事件。 */
const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("generateDraftStream 流式生成", () => {
  it("请求体 stream:true；增量回调剥立场行的可外显文本 + 已解析立场；最终返回清洗结果", async () => {
    let init: RequestInit | undefined;
    const fetchFn = makeStreamFetch(
      [sse("[stance:agree]\n"), sse("好，"), sse("这块我们来承接。"), "data: [DONE]\n\n"],
      { onCall: (_u, i) => (init = i) },
    );
    const updates: Array<[string, string | null]> = [];
    const res = await generateDraftStream(
      { prompt: PROMPT, target: TARGET, temperature: 0.3 },
      (text, stance) => updates.push([text, stance]),
      { fetchFn },
    );
    expect(JSON.parse(init?.body as string).stream).toBe(true);
    expect(res).toEqual({ text: "好，这块我们来承接。", stance: "agree" });
    // 增量文本不含标记行，且随流增长
    expect(updates).toEqual([
      ["好，", "agree"],
      ["好，这块我们来承接。", "agree"],
    ]);
  });

  it("标记行首行未收齐时按住不外显（不闪现半截 [stan...）", async () => {
    const fetchFn = makeStreamFetch([sse("[stan"), sse("ce:none]\n哈哈"), sse("好的")]);
    const updates: string[] = [];
    const res = await generateDraftStream(
      { prompt: PROMPT, target: TARGET, temperature: 0.3 },
      (text) => updates.push(text),
      { fetchFn },
    );
    expect(updates).toEqual(["哈哈", "哈哈好的"]);
    expect(res).toEqual({ text: "哈哈好的", stance: null });
  });

  it("SSE 事件被网络分包截断（半行跨 chunk）仍正确拼接", async () => {
    const whole = sse("[stance:reject]\n接不了。");
    const fetchFn = makeStreamFetch([whole.slice(0, 25), whole.slice(25), "data: [DONE]\n\n"]);
    const res = await generateDraftStream(
      { prompt: PROMPT, target: TARGET, temperature: 0.3 },
      () => {},
      { fetchFn },
    );
    expect(res).toEqual({ text: "接不了。", stance: "reject" });
  });

  it("供应商无视 stream:true 返回普通 JSON → 回退解析 message.content", async () => {
    const fetchFn = makeStreamFetch([
      JSON.stringify({ choices: [{ message: { content: "[stance:none]\n收到。" } }] }),
    ]);
    const res = await generateDraftStream(
      { prompt: PROMPT, target: TARGET, temperature: 0.3 },
      () => {},
      { fetchFn },
    );
    expect(res).toEqual({ text: "收到。", stance: null });
  });

  it("流为空 → 抛「模型未返回内容」", async () => {
    const fetchFn = makeStreamFetch(["data: [DONE]\n\n"]);
    await expect(
      generateDraftStream({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, () => {}, {
        fetchFn,
      }),
    ).rejects.toThrow("模型未返回内容");
  });
});

describe("displayableStreamText 增量外显", () => {
  it("首行未完整且疑似标记/围栏前缀 → null（按住）", () => {
    expect(displayableStreamText("[stan")).toBeNull();
    expect(displayableStreamText("【同")).toBeNull();
    expect(displayableStreamText("```")).toBeNull();
    expect(displayableStreamText("  ")).toBeNull();
  });

  it("普通正文直接外显；标记行/开头围栏行被剥", () => {
    expect(displayableStreamText("好，接了")).toBe("好，接了");
    expect(displayableStreamText("[stance:agree]\n好，接了")).toBe("好，接了");
    expect(displayableStreamText("```text\n今天下午")).toBe("今天下午");
  });
});
