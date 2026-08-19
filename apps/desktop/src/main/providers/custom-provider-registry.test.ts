// 自定义供应商注册进主进程 pi-ai 注册表的单测。
//
// 最要紧的一条是「绝不覆盖内建供应商」：`setProvider` 按 id upsert，一旦让自定义定义写到
// 内建 id 上，就等于用用户声明的能力替换掉 pi 内置目录 —— 2026-07-30 事故的原样重演，
// 而且这次发生在主进程（连 Gateway 一起波及）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderCatalog } from "./contract";

const state = vi.hoisted(() => ({
  defs: [] as { id: string; json: string }[],
  secrets: {} as Record<string, string>,
  catalog: undefined as ProviderCatalog | undefined,
  catalogThrows: false,
}));

vi.mock("./custom-providers", () => ({ listCustomProviders: async () => state.defs }));
vi.mock("./credentials", () => ({ readSecrets: async () => state.secrets }));
vi.mock("./catalog", () => ({
  getProviderCatalog: () => {
    if (state.catalogThrows) throw new Error("catalog unavailable");
    return state.catalog;
  },
}));
vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
// pi-ai 是纯 ESM、只能动态引入；这里替身成「原样回传入参」，便于断言构造出的 Provider 形状。
vi.mock("@earendil-works/pi-ai", () => ({ createProvider: (input: unknown) => ({ __provider: input }) }));
vi.mock("@earendil-works/pi-ai/api/openai-completions.lazy", () => ({
  openAICompletionsApi: () => ({ __api: "openai-completions" }),
}));
vi.mock("@earendil-works/pi-ai/api/anthropic-messages.lazy", () => ({
  anthropicMessagesApi: () => ({ __api: "anthropic-messages" }),
}));

import { resetCustomProviderRegistryForTests, syncCustomProvidersInto } from "./custom-provider-registry";

/** 收集 setProvider / deleteProvider 调用的假注册表。 */
function fakeModels() {
  const set = new Map<string, Record<string, unknown>>();
  const deleted: string[] = [];
  return {
    set,
    deleted,
    setProvider: (p: { __provider: Record<string, unknown> }) => set.set(String(p.__provider.id), p.__provider),
    deleteProvider: (id: string) => void deleted.push(id),
  };
}

function def(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    json: JSON.stringify({
      name: "公司网关",
      baseUrl: "https://gw.example/v1",
      api: "openai-completions",
      apiKey: "${secret:GW_KEY}",
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 1, output: 2 },
          compat: { maxTokensField: "max_tokens" },
        },
      ],
      ...over,
    }),
  };
}

const CATALOG: ProviderCatalog = {
  schemaVersion: 1,
  piVersion: "0.82.1",
  hash: "t",
  providers: [{ id: "openai", name: "OpenAI", api: "openai-responses", auth: ["api-key"], models: [] }],
};

beforeEach(() => {
  resetCustomProviderRegistryForTests();
  state.defs = [];
  state.secrets = { GW_KEY: "sk-real" };
  state.catalog = CATALOG;
  state.catalogThrows = false;
});
afterEach(() => vi.restoreAllMocks());

describe("syncCustomProvidersInto", () => {
  it("把自定义供应商注册进注册表，模型带上完整能力与 compat", async () => {
    state.defs = [def("corp-gw")];
    const models = fakeModels();

    await syncCustomProvidersInto(models);

    const p = models.set.get("corp-gw")!;
    expect(p.baseUrl).toBe("https://gw.example/v1");
    const m = (p.models as Record<string, unknown>[])[0]!;
    expect(m).toMatchObject({
      id: "gpt-4o",
      provider: "corp-gw",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
    // compat 决定 role / max_tokens 字段名等线格式，丢了非 OpenAI 上游会 400。
    expect(m.compat).toEqual({ maxTokensField: "max_tokens" });
    // cost 的四项补齐（pi 的 ModelCost 要求齐全），但不影响能力。
    expect(m.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("按模型族系推断 thinkingFormat：网关代理的 DeepSeek 才能真正关掉思考;显式 compat 优先", async () => {
    state.defs = [
      {
        id: "ds-gw",
        json: JSON.stringify({
          name: "DS 网关",
          baseUrl: "https://gw.example/v1",
          api: "openai-completions",
          apiKey: "${secret:GW_KEY}",
          models: [
            // 未写 compat 的 DeepSeek reasoning 模型 → 推断 deepseek(否则「关闭思考」
            // 不会下发 thinking:{type:"disabled"},上游默认思考,实测故障)。
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", input: ["text"], reasoning: true, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0 } },
            // 显式 compat.thinkingFormat 覆盖推断(严格网关拒收 thinking 参数时的逃生口)。
            { id: "deepseek-v4", name: "DS", input: ["text"], reasoning: true, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0 }, compat: { thinkingFormat: "openai" } },
            // 非 reasoning 模型不推断。
            { id: "deepseek-lite", name: "DS Lite", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0 } },
          ],
        }),
      },
    ];
    const models = fakeModels();
    await syncCustomProvidersInto(models);
    const list = models.set.get("ds-gw")!.models as Record<string, unknown>[];
    expect(list[0]!.compat).toEqual({ thinkingFormat: "deepseek" });
    expect(list[1]!.compat).toEqual({ thinkingFormat: "openai" });
    expect(list[2]!.compat).toBeUndefined();
  });

  it("🔴 与内建供应商同名的自定义定义被跳过，绝不覆盖内建目录", async () => {
    // 事故回归：setProvider 按 id upsert，写进去就等于把 pi 内建 openai 的模型目录整个换掉。
    state.defs = [def("openai")];
    const models = fakeModels();

    await syncCustomProvidersInto(models);

    expect(models.set.has("openai")).toBe(false);
    expect(models.set.size).toBe(0);
  });

  it("API Key 在 resolve() 被调用时才解密，而不是注册时就捕获进闭包", async () => {
    state.defs = [def("corp-gw")];
    const models = fakeModels();
    await syncCustomProvidersInto(models);

    const p = models.set.get("corp-gw")!;
    const auth = (p.auth as { apiKey: { resolve: () => Promise<unknown> } }).apiKey;
    // 注册产物里不该有明文（否则明文会随 Provider 对象常驻内存）。
    expect(JSON.stringify(p)).not.toContain("sk-real");

    // 改完金库后**立即**生效，不必重新注册 —— 这正是延迟解密换来的性质。
    state.secrets = { GW_KEY: "sk-rotated" };
    await expect(auth.resolve()).resolves.toMatchObject({ auth: { apiKey: "sk-rotated" } });
  });

  it("引用的 Secret 缺失 → resolve 返回 undefined（未配置），绝不把占位符当密钥发出去", async () => {
    state.defs = [def("corp-gw")];
    state.secrets = {};
    const models = fakeModels();
    await syncCustomProvidersInto(models);

    const auth = (models.set.get("corp-gw")!.auth as { apiKey: { resolve: () => Promise<unknown> } }).apiKey;
    await expect(auth.resolve()).resolves.toBeUndefined();
  });

  it("能力字段不全 / 协议不支持的模型整条丢弃；一个都不剩时整个供应商不注册", async () => {
    state.defs = [
      def("miss-caps", { models: [{ id: "m", input: ["text"], reasoning: true }] }), // 缺 contextWindow/maxTokens
      def("bad-api", { api: "bedrock-converse-stream" }),
    ];
    const models = fakeModels();

    await syncCustomProvidersInto(models);
    expect(models.set.size).toBe(0);
  });

  it("坏 JSON / 非法 baseUrl 被跳过，且不影响同批的其它供应商", async () => {
    state.defs = [{ id: "broken", json: "{ 坏" }, def("ok-gw"), def("bad-url", { baseUrl: "gw.example" })];
    const models = fakeModels();

    await syncCustomProvidersInto(models);
    expect([...models.set.keys()]).toEqual(["ok-gw"]);
  });

  it("用户删掉定义后，上一轮注册的供应商要从注册表摘除（否则残留成幽灵供应商）", async () => {
    state.defs = [def("corp-gw")];
    const first = fakeModels();
    await syncCustomProvidersInto(first);
    expect(first.set.has("corp-gw")).toBe(true);

    state.defs = [];
    const second = fakeModels();
    await syncCustomProvidersInto(second);
    expect(second.deleted).toContain("corp-gw");
  });

  it("Catalog 读取抛错 → 仍然注册（降级不阻断），只是失去撞名保护", async () => {
    state.catalogThrows = true;
    state.defs = [def("corp-gw")];
    const models = fakeModels();

    await syncCustomProvidersInto(models);
    expect(models.set.has("corp-gw")).toBe(true);
  });

  it("多次同步是幂等的，不会重复堆积", async () => {
    state.defs = [def("corp-gw")];
    const models = fakeModels();
    await syncCustomProvidersInto(models);
    await syncCustomProvidersInto(models);
    expect(models.set.size).toBe(1);
    expect(models.deleted).toEqual([]);
  });

  // ── headers 里的 `${secret:}` 解析 ──────────────────────────────────────────
  // Header 没有 apiKey 那样的延迟认证钩子，必须由共享 builder 在注册 Provider 时解析；
  // 主进程从 safeStorage 读，pi-host worker 经 credential RPC 读。若不在这里解，
  // `${secret:X}` 字面量会原样发到上游，换来一次无从归因的 401。
  describe("headers 的 Secret 引用", () => {
    it("provider 级与 model 级 headers 都会被解析成真实值", async () => {
      state.secrets = { GW_KEY: "sk-real", TENANT: "acme-42" };
      state.defs = [
        def("corp-gw", {
          headers: { "X-Tenant": "${secret:TENANT}", "X-Static": "plain" },
          models: [
            {
              id: "gpt-4o",
              input: ["text"],
              reasoning: false,
              contextWindow: 1000,
              maxTokens: 100,
              cost: { input: 1, output: 2 },
              headers: { Authorization: "Bearer ${secret:GW_KEY}" },
            },
          ],
        }),
      ];
      const models = fakeModels();

      await syncCustomProvidersInto(models);

      const provider = models.set.get("corp-gw")!;
      expect(provider.headers).toEqual({ "X-Tenant": "acme-42", "X-Static": "plain" });
      const model = (provider.models as Record<string, unknown>[])[0];
      expect(model.headers).toEqual({ Authorization: "Bearer sk-real" });
    });

    it("引用了不存在的 Secret → 该 header 整条丢弃，绝不发出带 ${secret:} 的字面量", async () => {
      state.secrets = { GW_KEY: "sk-real" }; // 故意缺 MISSING_ONE
      state.defs = [
        def("corp-gw", {
          headers: { "X-Bad": "${secret:MISSING_ONE}", "X-Good": "kept" },
        }),
      ];
      const models = fakeModels();

      await syncCustomProvidersInto(models);

      const headers = models.set.get("corp-gw")!.headers as Record<string, string>;
      expect(headers).toEqual({ "X-Good": "kept" });
      // 半解析的鉴权头比不发更糟，这里断言的是「字面量绝不外泄」这条红线。
      expect(JSON.stringify(headers)).not.toContain("${secret:");
    });

    it("没有 Secret 引用时不读金库（避免为绝大多数定义白付一次 safeStorage 解密）", async () => {
      let reads = 0;
      Object.defineProperty(state, "secrets", {
        get() {
          reads += 1;
          return { GW_KEY: "sk-real" };
        },
        configurable: true,
      });
      // apiKey 的 `${secret:GW_KEY}` 会触发读取，故这里换成明文 apiKey、且不带 headers 引用。
      state.defs = [def("corp-gw", { apiKey: "sk-plain", headers: { "X-Static": "plain" } })];
      const models = fakeModels();

      await syncCustomProvidersInto(models);

      expect(reads).toBe(0);
      expect(models.set.get("corp-gw")!.headers).toEqual({ "X-Static": "plain" });
    });
  });
});
