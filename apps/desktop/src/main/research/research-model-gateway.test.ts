// 研究模型网关的行为测试（spec §19.2.5、§6.1）。
//
// 全部依赖手写注入：假 fetch / 假 complete，零真实网络。
// 两条关键性质：选型失败时 fetchFn 调用次数为 0（一个字节都不出站），
// 以及请求体里永远没有 tools —— 后者是处理 public_web 内容时的 prompt injection 防线。
import { describe, expect, it } from "vitest";
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import { ResearchModelGateway } from "./research-model-gateway";

/// 记录调用的假 fetch。默认回一个合法的 chat completions 响应。
function makeFetch(content = "模型输出"): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (input: unknown, init?: { body?: string }) => {
    calls.push({ url: String(input), body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function providers(...entries: Array<{ id: string; baseUrl: string }>): ProviderSettings {
  return {
    providers: entries.map((entry) => ({
      id: entry.id,
      name: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: `sk-${entry.id}-secret`,
      endpointFormat: "chat_completions" as const,
      models: [{ id: `${entry.id}-model` }],
      enabled: true,
    })),
  };
}

const BASE_INPUT = {
  purpose: "report" as const,
  systemPrompt: "你是研究助手",
  userPrompt: "请汇总证据",
};

describe("ResearchModelGateway 前置选型（spec §19.2.5）", () => {
  it("一个 provider 都没有时返回 no_provider_configured，且 fetchFn 一次都不被调用", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new ResearchModelGateway({ providerSettings: { providers: [] }, fetchFn });

    const result = await gateway.call(BASE_INPUT);

    expect(result).toMatchObject({ ok: false, code: "no_provider_configured" });
    expect(calls).toHaveLength(0);
  });

  it("研究模型偏好决定发往哪个供应商", async () => {
    const { fetchFn, calls } = makeFetch("本地模型输出");
    const gateway = new ResearchModelGateway({
      providerSettings: {
        ...providers(
          { id: "cloud", baseUrl: "https://api.example.com/v1" },
          { id: "local", baseUrl: "http://127.0.0.1:11434/v1" },
        ),
        // 全局默认指向云端，研究偏好指向本地：偏好必须赢。
        defaultProviderId: "cloud",
      },
      preference: { providerId: "local" },
      fetchFn,
    });

    const result = await gateway.call(BASE_INPUT);

    expect(result).toMatchObject({ ok: true, text: "本地模型输出", providerId: "local", isLocal: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("127.0.0.1");
  });

  it("无研究偏好时跟随全局默认模型", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new ResearchModelGateway({
      providerSettings: {
        ...providers(
          { id: "local", baseUrl: "http://127.0.0.1:11434/v1" },
          { id: "cloud", baseUrl: "https://api.example.com/v1" },
        ),
        defaultProviderId: "cloud",
      },
      fetchFn,
    });

    const result = await gateway.call(BASE_INPUT);

    expect(result).toMatchObject({ ok: true, providerId: "cloud", isLocal: false });
    expect(calls[0]!.url).toContain("api.example.com");
  });

  it("isLocal 如实反映所选供应商（UI 据它告知用户正文是否离开本机）", async () => {
    const { fetchFn } = makeFetch();
    const local = await new ResearchModelGateway({
      providerSettings: providers({ id: "local", baseUrl: "http://localhost:11434/v1" }),
      fetchFn,
    }).call(BASE_INPUT);
    const cloud = await new ResearchModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    }).call(BASE_INPUT);

    expect(local.ok && local.isLocal).toBe(true);
    expect(cloud.ok && cloud.isLocal).toBe(false);
  });
});

describe("ResearchModelGateway 工具集与出站内容", () => {
  it("请求体里没有任何 tools / functions 字段（spec §6.1 第 4 条）", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new ResearchModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    await gateway.call(BASE_INPUT);

    const body = calls[0]!.body;
    expect(Object.keys(body)).not.toContain("tools");
    expect(Object.keys(body)).not.toContain("functions");
    expect(Object.keys(body)).not.toContain("tool_choice");
    expect(body.messages).toEqual([
      { role: "system", content: "你是研究助手" },
      { role: "user", content: "请汇总证据" },
    ]);
  });

  it("证据正文可以直接出站（不再有出站策略守卫拦它）", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new ResearchModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    const body = "node:sqlite 在 Node 22 上可用，但仍被标记为实验特性，生产环境需谨慎评估。";
    const result = await gateway.call({ ...BASE_INPUT, userPrompt: `参考资料：${body}` });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const messages = calls[0]!.body.messages as Array<{ content: string }>;
    expect(messages[1]!.content).toContain(body);
  });

  it("userPrompt 超过出站字符上限时被截断并带截断标记", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new ResearchModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    const result = await gateway.call({
      ...BASE_INPUT,
      userPrompt: "证".repeat(500),
      maxPromptChars: 100,
    });

    expect(result.ok).toBe(true);
    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect([...messages[1]!.content].length).toBeLessThanOrEqual(100);
    expect(messages[1]!.content.endsWith("…[truncated]")).toBe(true);
    // systemPrompt 永不截断：它承载安全规则
    expect(messages[0]!.content).toBe("你是研究助手");
  });
});

describe("ResearchModelGateway 失败处理", () => {
  it("调用抛错时收敛为 call_failed，且错误信息不含凭据与 prompt 正文", async () => {
    const gateway = new ResearchModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      complete: async () => {
        throw new Error("模型接口 HTTP 500:Bearer sk-cloud-secret 请汇总证据");
      },
    });

    const result = await gateway.call(BASE_INPUT);

    expect(result).toMatchObject({ ok: false, code: "call_failed" });
    const message = result.ok === false ? result.message : "";
    expect(message).not.toContain("sk-cloud-secret");
    expect(message).not.toContain("请汇总证据");
  });

  it("注入的 complete 收到的参数不含 tools，且带上 provider 的 baseUrl 与模型", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const gateway = new ResearchModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      complete: async (params) => {
        seen.push(params as unknown as Record<string, unknown>);
        return "ok";
      },
    });

    await gateway.call({ ...BASE_INPUT, maxTokens: 256 });

    expect(seen[0]).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "cloud-model",
      maxTokens: 256,
    });
    expect(Object.keys(seen[0]!)).not.toContain("tools");
  });
});

/// 回归：调用失败时必须能从结果里看出**选中的是哪个 provider / model**。
///
/// 真实踩过一次：选型只在 loopback provider 里挑 → 选中了列表里排第一的
/// `bge-reranker-v2-m3`（一个 reranker，不是 chat 模型）→ 秒回 HTTP 400。
/// 但日志里只有一句 `call_failed`，既看不出选了谁也看不出选了什么模型，
/// 排查只能靠翻配置逐个复现。选型结果是配置不是用户数据，记它没有隐私代价。
///
/// 现在用户可以为研究直接指定模型，这类误选更容易避免——但一旦发生，
/// 结果里仍必须带得出「选中了谁」，否则同样查不到根因。
describe("失败结果要带上选型信息", () => {
  it("call_failed 时回传 providerId 与 model", async () => {
    const gateway = new ResearchModelGateway({
      providerSettings: {
        providers: [
          {
            id: "local",
            name: "本地",
            baseUrl: "http://127.0.0.1:8000/v1",
            apiKey: "k",
            endpointFormat: "chat_completions",
            enabled: true,
            models: [{ id: "bge-reranker-v2-m3" }],
          },
        ],
      } as never,
      complete: async () => {
        throw new Error("模型接口 HTTP 400:not an LLM / chat model");
      },
    });

    const result = await gateway.call({
      purpose: "initial_plan",
      systemPrompt: "sys",
      userPrompt: "user",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("call_failed");
    expect(result.providerId).toBe("local");
    expect(result.model).toBe("bge-reranker-v2-m3");
  });
});
