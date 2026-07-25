// 模型出站闸的行为测试（spec §19.2.5、§6.1）。
//
// 全部依赖手写注入：假 fetch / 假 complete，零真实网络。
// 最关键的一条是「local_only + 只有云 provider 时 fetchFn 调用次数为 0」——
// 它是 spec §19.2.5「local_only 策略下没有任何证据请求到达远程模型」的自动化验收。
import { describe, expect, it } from "vitest";
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import { PolicyAwareModelGateway, assertNoEvidenceText } from "./policy-aware-model-gateway";

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

describe("PolicyAwareModelGateway 前置闸（spec §19.2.5）", () => {
  it("local_only 且只有云 provider 时直接失败，fetchFn 一次都不被调用", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    const result = await gateway.call({ ...BASE_INPUT, policy: "local_only" });

    expect(result).toMatchObject({ ok: false, code: "local_model_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("local_only 且存在 loopback provider 时正常调用", async () => {
    const { fetchFn, calls } = makeFetch("本地模型输出");
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers(
        { id: "cloud", baseUrl: "https://api.example.com/v1" },
        { id: "local", baseUrl: "http://127.0.0.1:11434/v1" },
      ),
      fetchFn,
    });

    const result = await gateway.call({ ...BASE_INPUT, policy: "local_only" });

    expect(result).toMatchObject({ ok: true, text: "本地模型输出", providerId: "local", isLocal: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("127.0.0.1");
  });

  it("一个 provider 都没有时返回 no_provider_configured，且不出站", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new PolicyAwareModelGateway({ providerSettings: { providers: [] }, fetchFn });

    const result = await gateway.call({ ...BASE_INPUT, policy: "evidence_allowed" });

    expect(result).toMatchObject({ ok: false, code: "no_provider_configured" });
    expect(calls).toHaveLength(0);
  });
});

describe("PolicyAwareModelGateway 工具集与出站内容", () => {
  it("请求体里没有任何 tools / functions 字段（spec §6.1 第 4 条）", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    await gateway.call({ ...BASE_INPUT, policy: "evidence_allowed" });

    const body = calls[0]!.body;
    expect(Object.keys(body)).not.toContain("tools");
    expect(Object.keys(body)).not.toContain("functions");
    expect(Object.keys(body)).not.toContain("tool_choice");
    expect(body.messages).toEqual([
      { role: "system", content: "你是研究助手" },
      { role: "user", content: "请汇总证据" },
    ]);
  });

  it("userPrompt 超过出站字符上限时被截断并带截断标记", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    const result = await gateway.call({
      ...BASE_INPUT,
      userPrompt: "证".repeat(500),
      policy: "evidence_allowed",
      maxPromptChars: 100,
    });

    expect(result.ok).toBe(true);
    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect([...messages[1]!.content].length).toBeLessThanOrEqual(100);
    expect(messages[1]!.content.endsWith("…[truncated]")).toBe(true);
    // systemPrompt 永不截断：它承载安全规则
    expect(messages[0]!.content).toBe("你是研究助手");
  });

  it("metadata_only 下 prompt 混入证据正文时被守卫拦下，且不出站", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    const body = "node:sqlite 在 Node 22 上可用，但仍被标记为实验特性，生产环境需谨慎评估。";
    const result = await gateway.call({
      ...BASE_INPUT,
      userPrompt: `参考资料：${body}`,
      policy: "metadata_only",
      forbiddenEvidenceTexts: [body],
    });

    expect(result).toMatchObject({ ok: false, code: "call_failed" });
    expect(result.ok === false && result.message).toContain("policy_guard");
    expect(calls).toHaveLength(0);
  });

  it("evidence_allowed 下同样的正文可以出站", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      fetchFn,
    });

    const body = "node:sqlite 在 Node 22 上可用，但仍被标记为实验特性，生产环境需谨慎评估。";
    const result = await gateway.call({
      ...BASE_INPUT,
      userPrompt: `参考资料：${body}`,
      policy: "evidence_allowed",
      forbiddenEvidenceTexts: [body],
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("local_only + 本地模型时正文守卫不生效（数据没有离开本机）", async () => {
    const { fetchFn, calls } = makeFetch();
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "local", baseUrl: "http://localhost:11434/v1" }),
      fetchFn,
    });

    const body = "node:sqlite 在 Node 22 上可用，但仍被标记为实验特性，生产环境需谨慎评估。";
    const result = await gateway.call({
      ...BASE_INPUT,
      userPrompt: `参考资料：${body}`,
      policy: "local_only",
      forbiddenEvidenceTexts: [body],
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("PolicyAwareModelGateway 失败处理", () => {
  it("调用抛错时收敛为 call_failed，且错误信息不含凭据与 prompt 正文", async () => {
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      complete: async () => {
        throw new Error("模型接口 HTTP 500:Bearer sk-cloud-secret 请汇总证据");
      },
    });

    const result = await gateway.call({ ...BASE_INPUT, policy: "evidence_allowed" });

    expect(result).toMatchObject({ ok: false, code: "call_failed" });
    const message = result.ok === false ? result.message : "";
    expect(message).not.toContain("sk-cloud-secret");
    expect(message).not.toContain("请汇总证据");
  });

  it("注入的 complete 收到的参数不含 tools，且带上 provider 的 baseUrl 与模型", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const gateway = new PolicyAwareModelGateway({
      providerSettings: providers({ id: "cloud", baseUrl: "https://api.example.com/v1" }),
      complete: async (params) => {
        seen.push(params as unknown as Record<string, unknown>);
        return "ok";
      },
    });

    await gateway.call({ ...BASE_INPUT, policy: "evidence_allowed", maxTokens: 256 });

    expect(seen[0]).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "cloud-model",
      maxTokens: 256,
    });
    expect(Object.keys(seen[0]!)).not.toContain("tools");
  });
});

describe("assertNoEvidenceText", () => {
  it("evidence_allowed 一律放行", () => {
    expect(assertNoEvidenceText("正文片段就在这里出现了很长的一段内容", "evidence_allowed", [
      "正文片段就在这里出现了很长的一段内容",
    ])).toBeNull();
  });

  it("metadata_only 下命中正文片段返回可读的违规说明", () => {
    const body = "这是一段足够长的网页正文，用来验证守卫能够识别出片段级别的重叠。";
    const violation = assertNoEvidenceText(`前缀 ${body} 后缀`, "metadata_only", [body]);
    expect(violation).toContain("policy_guard");
  });

  it("换行与多余空白不影响命中（归一化后比较）", () => {
    const body = "这是一段足够长的网页正文，\n\n  用来验证守卫能够识别出片段级别的重叠。";
    const flattened = body.replace(/\s+/g, " ");
    expect(assertNoEvidenceText(`前缀 ${flattened} 后缀`, "metadata_only", [body])).toContain(
      "policy_guard",
    );
  });

  it("过短的证据文本不参与匹配（避免把标题里的常见词判成正文泄漏）", () => {
    expect(assertNoEvidenceText("研究报告", "metadata_only", ["研究"])).toBeNull();
  });
});

/// 回归：调用失败时必须能从结果里看出**选中的是哪个 provider / model**。
///
/// 真实踩过一次：策略被误判成 local_only → 只在 loopback provider 里选 → 选中了列表里排第一的
/// `bge-reranker-v2-m3`（一个 reranker，不是 chat 模型）→ 秒回 HTTP 400。
/// 但日志里只有一句 `call_failed`，既看不出选了谁也看不出选了什么模型，
/// 排查只能靠翻配置逐个复现。选型结果是配置不是用户数据，记它没有隐私代价。
describe("失败结果要带上选型信息", () => {
  it("call_failed 时回传 providerId 与 model", async () => {
    const gateway = new PolicyAwareModelGateway({
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
      policy: "local_only",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("call_failed");
    expect(result.providerId).toBe("local");
    expect(result.model).toBe("bge-reranker-v2-m3");
  });
});
