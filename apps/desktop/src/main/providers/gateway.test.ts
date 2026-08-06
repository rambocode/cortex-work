// Pi Model Gateway 契约测试（阶段③·4.1）。
//
// ── 替身放在哪一层，为什么 ────────────────────────────────────────────────────
// 计划要求「对 Catalog 中出现的每种 api 做 **mock transport 层**契约测试，
// bedrock/vertex 等 ambient 凭据协议不真调」。这里的 transport 替身放在 **pi `Models` 的
// 分发口**（`PiGatewayRuntime`），而不是 `fetch`：
//   · `bedrock-converse-stream` 走 AWS Smithy SDK、`google-vertex` 走 ADC + Google SDK，
//     两者**根本不经过 fetch**。在 fetch 上挖替身只能覆盖 HTTP 系的几种 api，
//     恰好把最需要"别真调"的那两种漏掉，给出虚假的覆盖率。
//   · Gateway 对每种 api 的行为本就应该**完全一致**（这正是它存在的意义）：
//     所以契约测试要断言的是「不管 api 是什么，complete / stream / abort / usage /
//     认证失败这五件事的表现一模一样」，而 pi 分发口正是这条不变量的边界。
//
// 另外三组回归：悬空引用 → config 且不回退、工具集永远为空、thinking 档位不自建映射表。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessage, AssistantMessageEvent, Context, Model, Api } from "@earendil-works/pi-ai";

import type { CatalogModel, CatalogProvider, GatewayStreamEvent, ProviderCatalog } from "./contract";
import type { PiGatewayRuntime } from "./pi-runtime";

// ── Catalog 替身 ─────────────────────────────────────────────────────────────
// gateway.ts 经 catalog.ts 间接依赖 electron；node 环境下先把 catalog 整个换掉，
// 顺带让每个用例都能自由摆布「Catalog 里有什么」。
let catalog: ProviderCatalog | undefined;
vi.mock("./catalog", () => ({ getProviderCatalog: () => catalog }));
// pi-runtime 的真实实现会去动态 import 纯 ESM 的 pi-ai；本测试一律走注入的替身，
// 但模块图仍会加载它，故把 electron 挡掉。
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

import {
  __resetGatewayInflightForTests,
  abortGatewayRequest,
  classifyGatewayError,
  runGatewayComplete,
  runGatewayStream,
  toIpcResult,
} from "./gateway";

/** pi `KnownApi` 全 10 种（pi-ai/dist/types.d.ts:15）+ 一个开放字符串，逐个跑同一套契约。 */
const ALL_APIS = [
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
  "acme-custom-protocol", // 开放字符串：Api = KnownApi | (string & {})
] as const;

const USAGE = {
  input: 12,
  output: 34,
  cacheRead: 5,
  cacheWrite: 6,
  totalTokens: 57,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function catalogModel(api: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "m1",
    name: "M1",
    api,
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...overrides,
  };
}

function catalogWith(providers: CatalogProvider[]): ProviderCatalog {
  return { schemaVersion: 1, piVersion: "0.82.1", hash: "test", providers };
}

/** 单 provider 单模型的最小 Catalog，api 由用例指定。 */
function singleModelCatalog(api: string, model: Partial<CatalogModel> = {}): ProviderCatalog {
  return catalogWith([
    {
      id: "p1",
      name: "P1",
      api,
      baseUrl: "https://api.example.com",
      auth: ["api-key"],
      models: [catalogModel(api, model)],
    },
  ]);
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "openai-completions",
    provider: "p1",
    model: "m1",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

/** 把一串事件 + 终态包成 pi `AssistantMessageEventStream` 的结构等价物。 */
function fakeStream(events: AssistantMessageEvent[], result: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => result,
  };
}

interface RuntimeSpy extends PiGatewayRuntime {
  calls: { model: Model<Api>; context: Context; options?: Record<string, unknown> }[];
}

/** 造一个可观测的 pi 运行时替身。默认「模型存在 + 已认证 + 返回一条正常回复」。 */
function makeRuntime(overrides: Partial<PiGatewayRuntime> = {}): RuntimeSpy {
  const calls: RuntimeSpy["calls"] = [];
  const base: PiGatewayRuntime = {
    getModel: async (providerId, modelId) =>
      ({ id: modelId, provider: providerId, api: "openai-completions" }) as Model<Api>,
    isAuthenticated: async () => true,
    completeSimple: async (model, context, options) => {
      calls.push({ model, context, options: options as Record<string, unknown> });
      return assistant();
    },
    streamSimple: async (model, context, options) => {
      calls.push({ model, context, options: options as Record<string, unknown> });
      return fakeStream(
        [{ type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant() }, { type: "text_delta", contentIndex: 0, delta: "lo", partial: assistant() }] as AssistantMessageEvent[],
        assistant(),
      );
    },
  };
  return Object.assign({ calls }, base, overrides) as RuntimeSpy;
}

const REQ = { providerId: "p1", modelId: "m1", messages: [{ role: "user" as const, content: "hi" }] };

beforeEach(() => {
  catalog = singleModelCatalog("openai-completions");
  __resetGatewayInflightForTests();
});

// ── 每种 api 的统一契约 ───────────────────────────────────────────────────────

describe.each(ALL_APIS)("api=%s 的统一契约", (api) => {
  beforeEach(() => {
    catalog = singleModelCatalog(api);
  });

  it("complete：返回正文与 usage", async () => {
    const runtime = makeRuntime();
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({
      ok: true,
      text: "hello",
      truncated: false,
      usage: { input: 12, output: 34, cacheRead: 5, cacheWrite: 6 },
    });
  });

  it("stream：增量按序回调，done 收尾并带 usage", async () => {
    const runtime = makeRuntime();
    const events: unknown[] = [];
    const outcome = await runGatewayStream(REQ, (e) => events.push(e), { runtime });
    expect(outcome.ok).toBe(true);
    expect(events).toEqual([
      { type: "text", delta: "hel" },
      { type: "text", delta: "lo" },
      { type: "usage", usage: { input: 12, output: 34, cacheRead: 5, cacheWrite: 6 } },
      { type: "done", ok: true, text: "hello" },
    ]);
  });

  it("abort：按 requestId 中止后返回 aborted", async () => {
    // pi 侧收到已 abort 的 signal 时按约定给出 stopReason:"aborted" 的终态消息。
    const runtime = makeRuntime({
      completeSimple: async (_m, _c, options) => {
        (options as { signal?: AbortSignal })?.signal?.throwIfAborted?.();
        return assistant({ stopReason: "aborted", errorMessage: "aborted by caller" });
      },
    });
    const promise = runGatewayComplete({ ...REQ, requestId: "r1" }, { runtime });
    expect(abortGatewayRequest("r1")).toBe(true);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, errorKind: "aborted" });
  });

  it("认证失败：pi 的 ModelsError(code:auth) 归到 errorKind=auth", async () => {
    const err = Object.assign(new Error("credential store failed"), { code: "auth" });
    const runtime = makeRuntime({
      completeSimple: async () => {
        throw err;
      },
    });
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({ ok: false, errorKind: "auth" });
  });

  it("截断（stopReason=length）仍是成功结果，只是带 truncated 位", async () => {
    const runtime = makeRuntime({
      completeSimple: async () => assistant({ stopReason: "length" }),
    });
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({ ok: true, text: "hello", truncated: true });
  });
});

// ── 悬空引用（计划 §5）：一律 config，且绝不回退 ───────────────────────────────

describe("悬空引用 → errorKind=config，且不回退任何模型", () => {
  it("Catalog 里没有这个 provider", async () => {
    const runtime = makeRuntime();
    const outcome = await runGatewayComplete({ ...REQ, providerId: "ghost" }, { runtime });
    expect(outcome).toMatchObject({ ok: false, errorKind: "config" });
    // 关键：一个字节都没出站，也没有"挑一个能用的模型"。
    expect(runtime.calls).toHaveLength(0);
  });

  it("Catalog 里没有这个 model（同一 provider 下有别的模型也不顶替）", async () => {
    catalog = catalogWith([
      {
        id: "p1",
        name: "P1",
        api: "openai-completions",
        auth: ["api-key"],
        models: [catalogModel("openai-completions", { id: "other" })],
      },
    ]);
    const runtime = makeRuntime();
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({ ok: false, errorKind: "config" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("pi 运行时里没注册该模型", async () => {
    const runtime = makeRuntime({ getModel: async () => undefined });
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({ ok: false, errorKind: "config" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("Provider 未认证", async () => {
    const runtime = makeRuntime({ isAuthenticated: async () => false });
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({ ok: false, errorKind: "config" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("引用为空串（用户从未选过模型）", async () => {
    const runtime = makeRuntime();
    const outcome = await runGatewayComplete({ ...REQ, providerId: "", modelId: "" }, { runtime });
    expect(outcome).toMatchObject({ ok: false, errorKind: "config", error: "未配置模型" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("Catalog 整体不可用（校验失败）也是 config 而不是 unknown", async () => {
    catalog = undefined;
    const runtime = makeRuntime();
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({ ok: false, errorKind: "config" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("流式路径的悬空引用同样以 done(ok:false, config) 收尾，不留挂起的流", async () => {
    const runtime = makeRuntime({ isAuthenticated: async () => false });
    const events: unknown[] = [];
    await runGatewayStream(REQ, (e) => events.push(e), { runtime });
    expect(events).toEqual([
      { type: "done", ok: false, error: "供应商未认证：p1", errorKind: "config" },
    ]);
  });
});

// ── 不变量：工具集永远为空 ────────────────────────────────────────────────────

describe("prompt injection 防线：工具集永远为空", () => {
  it("下发给 pi 的 Context 不含 tools（complete 与 stream 两条路径）", async () => {
    const runtime = makeRuntime();
    await runGatewayComplete({ ...REQ, system: "rules" }, { runtime });
    await runGatewayStream({ ...REQ, system: "rules" }, () => {}, { runtime });
    expect(runtime.calls).toHaveLength(2);
    for (const call of runtime.calls) {
      expect(call.context.tools).toBeUndefined();
      expect(Object.keys(call.context)).not.toContain("tools");
    }
  });

  it("即便调用方在请求里塞了 tools 字段也进不去（契约类型上没有这个字段）", async () => {
    const runtime = makeRuntime();
    // 用 as 绕过类型只是为了证明运行时同样不透传——生产代码根本写不出这一行。
    await runGatewayComplete({ ...REQ, tools: [{ name: "bash" }] } as never, { runtime });
    expect(runtime.calls[0]!.context.tools).toBeUndefined();
  });
});

// ── system 归并与消息搬运 ─────────────────────────────────────────────────────

describe("Context 构造", () => {
  it("图片块以 base64 内联；缺 dataBase64 时整条失败而不是发一张空图", async () => {
    const runtime = makeRuntime();
    await runGatewayComplete(
      {
        ...REQ,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "看图" },
              { type: "image", dataBase64: "AAAA", mimeType: "image/jpeg" },
            ],
          },
        ],
      },
      { runtime },
    );
    expect(runtime.calls[0]!.context.messages[0]!.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ]);

    // 只给 imagePath（Gateway 不读磁盘）→ 报错，绝不静默补空串。
    // 静默发空图正是本次事故（图片被换成占位文本）的同一类形态。
    const outcome = await runGatewayComplete(
      { ...REQ, messages: [{ role: "user", content: [{ type: "image", imagePath: "/tmp/a.png" }] }] },
      { runtime },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("图片内容缺少 base64 数据");
    expect(runtime.calls).toHaveLength(1); // 第二次没有出站
  });

  it("req.system 与 messages 里的 system 角色合并进 Context.systemPrompt，且 system 在最前", async () => {
    const runtime = makeRuntime();
    await runGatewayComplete(
      {
        ...REQ,
        system: "静态前缀",
        messages: [
          { role: "system", content: "补充规则" },
          { role: "user", content: "问题" },
        ],
      },
      { runtime },
    );
    const context = runtime.calls[0]!.context;
    expect(context.systemPrompt).toBe("静态前缀\n补充规则");
    // system 不该以 message 的形式再出现一次（pi 的 Message 联合里没有 system 角色）。
    expect(context.messages.map((m) => m.role)).toEqual(["user"]);
  });
});

// ── thinking 档位：只做取舍，翻译交给 pi ──────────────────────────────────────

describe("thinkingLevel 交给 pi 用模型自带 thinkingLevelMap 翻译", () => {
  it("推理模型：合法档位原样下发为 reasoning（不在 Cortex 侧翻成 provider 私有值）", async () => {
    catalog = singleModelCatalog("openai-completions", {
      reasoning: true,
      thinkingLevelMap: { high: "xhigh-vendor-value" },
    });
    const runtime = makeRuntime();
    await runGatewayComplete({ ...REQ, thinkingLevel: "high" }, { runtime });
    // 下发的是 pi 中立档位 "high"，而不是 map 里的私有值——翻译是 pi 的职责。
    expect(runtime.calls[0]!.options?.reasoning).toBe("high");
  });

  it("非推理模型 / 非法档位 / off / 被 Catalog 标成不支持 → 不下发 reasoning", async () => {
    const runtime = makeRuntime();
    catalog = singleModelCatalog("openai-completions", { reasoning: false });
    await runGatewayComplete({ ...REQ, thinkingLevel: "high" }, { runtime });

    catalog = singleModelCatalog("openai-completions", { reasoning: true });
    await runGatewayComplete({ ...REQ, thinkingLevel: "off" }, { runtime });
    await runGatewayComplete({ ...REQ, thinkingLevel: "ultra" }, { runtime });

    catalog = singleModelCatalog("openai-completions", {
      reasoning: true,
      thinkingLevelMap: { high: null } as unknown as Record<string, string>,
    });
    await runGatewayComplete({ ...REQ, thinkingLevel: "high" }, { runtime });

    for (const call of runtime.calls) expect(call.options?.reasoning).toBeUndefined();
  });
});

// ── 采样参数与出站选项 ────────────────────────────────────────────────────────

describe("出站选项", () => {
  it("temperature / maxTokens 未传时不下发（沿用供应商默认）", async () => {
    const runtime = makeRuntime();
    await runGatewayComplete(REQ, { runtime });
    const options = runtime.calls[0]!.options!;
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("maxTokens");
    expect(options.timeoutMs).toBe(60_000);
  });

  it("传了就下发，且 timeoutMs 可覆盖", async () => {
    const runtime = makeRuntime();
    await runGatewayComplete({ ...REQ, temperature: 0.3, maxTokens: 96 }, { runtime, timeoutMs: 12_000 });
    expect(runtime.calls[0]!.options).toMatchObject({ temperature: 0.3, maxTokens: 96, timeoutMs: 12_000 });
  });

  it("调用方 signal 已取消 → 解析后立即返回 aborted，不出站", async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    controller.abort();
    const outcome = await runGatewayComplete(REQ, { runtime, signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, errorKind: "aborted" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("正常调用下发的 signal 会随调用方 signal 一起触发（AbortSignal.any 组合）", async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    await runGatewayComplete(REQ, { runtime, signal: controller.signal });
    const downstream = runtime.calls[0]!.options!.signal as AbortSignal;
    expect(downstream.aborted).toBe(false);
    controller.abort();
    expect(downstream.aborted).toBe(true);
  });
});

// ── temperature 被上游拒绝时的自愈重试 ────────────────────────────────────────

describe("temperature 被上游拒绝 → 去参重试一次", () => {
  /** OpenAI 推理模型（gpt-5.x 经 codex 协议）的真实报错形态。 */
  const REJECTION = "Codex error: Unsupported parameter: 'temperature'";

  /** 首次调用按 errorMessage 失败、之后成功的 completeSimple 替身（calls 记在返回对象上）。 */
  function rejectOnceRuntime(errorMessage: string): RuntimeSpy {
    let first = true;
    const rt: RuntimeSpy = makeRuntime({
      completeSimple: async (model, context, options) => {
        rt.calls.push({ model, context, options: options as Record<string, unknown> });
        if (first) {
          first = false;
          return assistant({ stopReason: "error", errorMessage });
        }
        return assistant();
      },
    });
    return rt;
  }

  it("complete：重试请求不带 temperature，最终成功", async () => {
    const runtime = rejectOnceRuntime(REJECTION);
    const outcome = await runGatewayComplete({ ...REQ, temperature: 0.9, maxTokens: 64 }, { runtime });
    expect(outcome).toMatchObject({ ok: true, text: "hello" });
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[0]!.options).toMatchObject({ temperature: 0.9 });
    expect(runtime.calls[1]!.options).not.toHaveProperty("temperature");
    // 其余参数原样保留，不因重试而丢失。
    expect(runtime.calls[1]!.options).toMatchObject({ maxTokens: 64 });
  });

  it("complete：pi 以异常（而非 error 终态）拒绝时同样重试", async () => {
    let first = true;
    const runtime: RuntimeSpy = makeRuntime({
      completeSimple: async (model, context, options) => {
        runtime.calls.push({ model, context, options: options as Record<string, unknown> });
        if (first) {
          first = false;
          throw new Error("temperature is not supported with this model");
        }
        return assistant();
      },
    });
    const outcome = await runGatewayComplete({ ...REQ, temperature: 0.7 }, { runtime });
    expect(outcome.ok).toBe(true);
    expect(runtime.calls).toHaveLength(2);
  });

  it("complete：未传 temperature 时不重试（错误原样返回）", async () => {
    const runtime = rejectOnceRuntime(REJECTION);
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome.ok).toBe(false);
    expect(runtime.calls).toHaveLength(1);
  });

  it("complete：与 temperature 无关的错误不重试（503 过载等不消费重试）", async () => {
    const runtime = rejectOnceRuntime("503: Service is too busy.");
    const outcome = await runGatewayComplete({ ...REQ, temperature: 0.7 }, { runtime });
    expect(outcome.ok).toBe(false);
    expect(runtime.calls).toHaveLength(1);
  });

  it("stream：握手阶段被拒（零增量）→ 去参重试，订阅方拿到干净的一份正文", async () => {
    let first = true;
    const runtime: RuntimeSpy = makeRuntime({
      streamSimple: async (model, context, options) => {
        runtime.calls.push({ model, context, options: options as Record<string, unknown> });
        if (first) {
          first = false;
          return fakeStream([], assistant({ stopReason: "error", errorMessage: REJECTION }));
        }
        return fakeStream(
          [{ type: "text_delta", contentIndex: 0, delta: "hello", partial: assistant() }] as AssistantMessageEvent[],
          assistant(),
        );
      },
    });
    const events: GatewayStreamEvent[] = [];
    const outcome = await runGatewayStream({ ...REQ, temperature: 0.9 }, (e) => events.push(e), { runtime });
    expect(outcome.ok).toBe(true);
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.options).not.toHaveProperty("temperature");
    // 只有重试那一份增量与一条成功 done，不存在两份拼接的正文。
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  it("stream：已推过增量后失败 → 绝不重试（UI 已渲染半截内容）", async () => {
    const runtime: RuntimeSpy = makeRuntime({
      streamSimple: async (model, context, options) => {
        runtime.calls.push({ model, context, options: options as Record<string, unknown> });
        return fakeStream(
          [{ type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant() }] as AssistantMessageEvent[],
          assistant({ stopReason: "error", errorMessage: REJECTION }),
        );
      },
    });
    const events: GatewayStreamEvent[] = [];
    const outcome = await runGatewayStream({ ...REQ, temperature: 0.9 }, (e) => events.push(e), { runtime });
    expect(outcome.ok).toBe(false);
    expect(runtime.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
  });
});

// ── 失败归类 ─────────────────────────────────────────────────────────────────

describe("错误分类", () => {
  it.each([
    ["HTTP 429 Too Many Requests", "rate-limit"],
    ["HTTP 401 Unauthorized", "auth"],
    ["invalid_api_key", "auth"],
    ["HTTP 503 upstream error", "provider"],
    ["socket hang up", "unknown"],
  ])("%s → %s", (message, expected) => {
    expect(classifyGatewayError(new Error(message), message)).toBe(expected);
  });

  it("AbortError 名字优先于文案", () => {
    const err = Object.assign(new Error("HTTP 500"), { name: "AbortError" });
    expect(classifyGatewayError(err, err.message)).toBe("aborted");
  });

  it("空响应算失败（拿到 200 却没内容通常是网关拦截）", async () => {
    const runtime = makeRuntime({ completeSimple: async () => assistant({ content: [] }) });
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome).toMatchObject({ ok: false, error: "模型未返回内容", errorKind: "provider" });
  });

  it("pi 抛出的异常经 safeErrorMessage 清洗，Authorization 不进错误详情", async () => {
    const runtime = makeRuntime({
      completeSimple: async () => {
        throw new Error('request failed: authorization: Bearer sk-live-super-secret');
      },
    });
    const outcome = await runGatewayComplete(REQ, { runtime });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).not.toContain("sk-live-super-secret");
  });
});

// ── 取消注册表 ────────────────────────────────────────────────────────────────

describe("取消注册表", () => {
  it("未知 requestId 返回 false", () => {
    expect(abortGatewayRequest("nope")).toBe(false);
  });

  it("请求结束后注销，重复 abort 不再命中（不泄漏 controller）", async () => {
    const runtime = makeRuntime();
    await runGatewayComplete({ ...REQ, requestId: "r2" }, { runtime });
    expect(abortGatewayRequest("r2")).toBe(false);
  });
});

// ── IPC 结果收窄 ─────────────────────────────────────────────────────────────

describe("toIpcResult", () => {
  it("成功只带 text/usage；truncated 不过桥（contract.ts 无此位，见 gateway.ts 文件头）", () => {
    expect(toIpcResult({ ok: true, text: "x", truncated: true, usage: { input: 1 } })).toEqual({
      ok: true,
      text: "x",
      usage: { input: 1 },
    });
  });

  it("失败带 error 与 errorKind，缺省不留 undefined 洞", () => {
    expect(toIpcResult({ ok: false, text: "", truncated: false })).toEqual({
      ok: false,
      error: "模型调用失败",
      errorKind: "unknown",
    });
  });
});
