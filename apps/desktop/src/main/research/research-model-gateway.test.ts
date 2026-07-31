// 研究模型网关的行为测试（spec §19.2.5、§6.1）。
//
// 全部依赖手写注入：假 pi 运行时 / 假 complete，零真实网络。
// 两条关键性质：选型失败时**出站调用次数为 0**（一个字节都不出站），
// 以及下发给 pi 的 Context 里永远没有 tools —— 后者是处理 public_web 内容时的 prompt injection 防线。
//
// 阶段③·4.1 收编后，「一个字节都不出站」的观测点从 fetch 调用次数变成 pi 运行时的调用次数
//（bedrock / vertex 不走 fetch，替身必须放在协议分发口，理由见 providers/gateway.test.ts）。
import { beforeEach, describe, expect, it, vi } from "vitest";

let catalog: ReturnType<typeof fakeCatalog> | undefined;
vi.mock("../providers/catalog", () => ({ getProviderCatalog: () => catalog }));
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

import { createFakePiRuntime, fakeCatalog } from "../providers/__fixtures__/fake-pi-runtime";
import { ResearchModelGateway, type ModelCallInput } from "./research-model-gateway";

const BASE_INPUT = {
  purpose: "report" as const,
  systemPrompt: "你是研究助手",
  userPrompt: "请汇总证据",
};

/** 造一个含云端与本地两个 Provider 的 Catalog（isLocal 判定要看 baseUrl）。 */
function twoProviderCatalog() {
  const cloud = fakeCatalog("cloud", "cloud-model");
  const local = fakeCatalog("local", "local-model", {}, { baseUrl: "http://127.0.0.1:11434/v1" });
  return { ...cloud, providers: [...cloud.providers, ...local.providers] };
}

beforeEach(() => {
  catalog = twoProviderCatalog();
});

describe("ResearchModelGateway 前置校验（spec §19.2.5）", () => {
  it("没有模型引用时返回 no_provider_configured，且出站一次都不发生", async () => {
    const runtime = createFakePiRuntime();
    const gateway = new ResearchModelGateway({ model: null, runtime });

    const result = await gateway.call(BASE_INPUT);

    expect(result).toMatchObject({ ok: false, code: "no_provider_configured" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("引用只有一半（缺 modelId）同样阻断，不猜模型", async () => {
    const runtime = createFakePiRuntime();
    const gateway = new ResearchModelGateway({ model: { providerId: "cloud", modelId: "" }, runtime });

    expect(await gateway.call(BASE_INPUT)).toMatchObject({ ok: false, code: "no_provider_configured" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("装配层给什么引用就发往谁（选型不在本文件）", async () => {
    const runtime = createFakePiRuntime({ texts: ["本地模型输出"] });
    const gateway = new ResearchModelGateway({
      model: { providerId: "local", modelId: "local-model" },
      runtime,
    });

    const result = await gateway.call(BASE_INPUT);

    expect(result).toMatchObject({ ok: true, text: "本地模型输出", providerId: "local", isLocal: true });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.model.provider).toBe("local");
  });

  it("isLocal 按 Catalog 里该 Provider 的 baseUrl 判（UI 据它告知用户正文是否离开本机）", async () => {
    const runtime = createFakePiRuntime();
    const local = await new ResearchModelGateway({
      model: { providerId: "local", modelId: "local-model" },
      runtime,
    }).call(BASE_INPUT);
    const cloud = await new ResearchModelGateway({
      model: { providerId: "cloud", modelId: "cloud-model" },
      runtime,
    }).call(BASE_INPUT);

    expect(local.ok && local.isLocal).toBe(true);
    expect(cloud.ok && cloud.isLocal).toBe(false);
  });

  it("Catalog 里查不到该 Provider 时 isLocal 保守判 false（拿不准不能给「不出站」的承诺）", async () => {
    const runtime = createFakePiRuntime();
    const gateway = new ResearchModelGateway({ model: { providerId: "ghost", modelId: "m" }, runtime });
    expect(gateway.preflight()).toMatchObject({ ok: true, isLocal: false });
  });
});

describe("ResearchModelGateway 工具集与出站内容", () => {
  it("下发给 pi 的 Context 里没有 tools（spec §6.1 第 4 条）", async () => {
    const runtime = createFakePiRuntime();
    const gateway = new ResearchModelGateway({
      model: { providerId: "cloud", modelId: "cloud-model" },
      runtime,
    });

    await gateway.call(BASE_INPUT);

    const context = runtime.calls[0]!.context;
    expect(Object.keys(context)).not.toContain("tools");
    expect(context.tools).toBeUndefined();
    expect(context.systemPrompt).toBe("你是研究助手");
    expect(context.messages).toEqual([expect.objectContaining({ role: "user", content: "请汇总证据" })]);
  });

  it("证据正文可以直接出站（不再有出站策略守卫拦它）", async () => {
    const runtime = createFakePiRuntime();
    const gateway = new ResearchModelGateway({
      model: { providerId: "cloud", modelId: "cloud-model" },
      runtime,
    });

    const body = "node:sqlite 在 Node 22 上可用，但仍被标记为实验特性，生产环境需谨慎评估。";
    const result = await gateway.call({ ...BASE_INPUT, userPrompt: `参考资料：${body}` });

    expect(result.ok).toBe(true);
    expect(runtime.calls).toHaveLength(1);
    expect(String(runtime.calls[0]!.context.messages[0]!.content)).toContain(body);
  });

  it("userPrompt 超过出站字符上限时被截断并带截断标记，systemPrompt 永不截断", async () => {
    const runtime = createFakePiRuntime();
    const gateway = new ResearchModelGateway({
      model: { providerId: "cloud", modelId: "cloud-model" },
      runtime,
    });

    const result = await gateway.call({
      ...BASE_INPUT,
      userPrompt: "证".repeat(500),
      maxPromptChars: 100,
    });

    expect(result.ok).toBe(true);
    const context = runtime.calls[0]!.context;
    const userContent = String(context.messages[0]!.content);
    expect([...userContent].length).toBeLessThanOrEqual(100);
    expect(userContent.endsWith("…[truncated]")).toBe(true);
    // systemPrompt 永不截断：它承载安全规则，也是 prompt 缓存的命中前缀。
    expect(context.systemPrompt).toBe("你是研究助手");
  });
});

describe("ResearchModelGateway 失败处理", () => {
  it("调用抛错时收敛为 call_failed，且错误信息不含凭据与 prompt 正文", async () => {
    const gateway = new ResearchModelGateway({
      model: { providerId: "cloud", modelId: "cloud-model" },
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

  it("注入的 complete 收到的参数不含 tools，且带上模型引用（不再有 baseUrl/apiKey）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const gateway = new ResearchModelGateway({
      model: { providerId: "cloud", modelId: "cloud-model" },
      complete: async (params) => {
        seen.push(params as unknown as Record<string, unknown>);
        return "ok";
      },
    });

    await gateway.call({ ...BASE_INPUT, maxTokens: 256 });

    expect(seen[0]).toMatchObject({ providerId: "cloud", modelId: "cloud-model", maxTokens: 256 });
    expect(Object.keys(seen[0]!)).not.toContain("tools");
    // 收编的核心成果：凭据与端点根本不出现在这一层的参数里。
    expect(Object.keys(seen[0]!)).not.toContain("apiKey");
    expect(Object.keys(seen[0]!)).not.toContain("baseUrl");
  });

  it("单次调用的长报告超时会透传给底层补全", async () => {
    const seen: Array<number | undefined> = [];
    const gateway = new ResearchModelGateway({
      model: { providerId: "cloud", modelId: "cloud-model" },
      complete: async (params) => {
        seen.push(params.timeoutMs);
        return "ok";
      },
    });
    const input = { ...BASE_INPUT, timeoutMs: 240_000 } as ModelCallInput & { timeoutMs: number };

    await gateway.call(input);

    expect(seen).toEqual([240_000]);
  });
});

/// 回归：调用失败时必须能从结果里看出**选中的是哪个 provider / model**。
///
/// 真实踩过一次：选型只在 loopback provider 里挑 → 选中了列表里排第一的
/// `bge-reranker-v2-m3`（一个 reranker，不是 chat 模型）→ 秒回 HTTP 400。
/// 但日志里只有一句 `call_failed`，既看不出选了谁也看不出选了什么模型，
/// 排查只能靠翻配置逐个复现。选型结果是配置不是用户数据，记它没有隐私代价。
describe("失败结果要带上选型信息", () => {
  it("call_failed 时回传 providerId 与 model", async () => {
    const gateway = new ResearchModelGateway({
      model: { providerId: "local", modelId: "bge-reranker-v2-m3" },
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
