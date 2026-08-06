// in-process 模型接入点的单测（迁移计划 U3-2 / R6）。
//
// 覆盖四条要紧的约束：
//   1. `${secret:}` 只有写在顶层 apiKey 上才解析得了 —— 其余位置必须**响亮失败**，
//      绝不能带着 `${secret:X}` 字面量去发请求（那只会得到一次莫名其妙的 401）。
//   2. Secret 缺失的两种成因（没配过 / 配过但解不开）要分开报，与二进制路径措辞一致。
//   3. 自定义供应商与 baseUrl 覆盖的同步差集：删掉定义要真的摘除，且**绝不能**用
//      registerProvider 去覆盖一个刚 registerNativeProvider 进去的自定义供应商（会把它抹掉）。
//   4. 模型解析不出时抛结构化错误，不返回「没有 model」的结果（否则 pi 会自己换模型）。
//
// 刻意**不**替身 `custom-provider-registry`：自定义供应商的构建逻辑整套复用它，
// 替掉就等于把「复用是否真的接上了」这件事测没了。改为替身它底下的 pi-ai（纯 ESM，只能动态引入）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderCatalog } from "./contract";

const state = vi.hoisted(() => ({
  definitions: [] as { id: string; json: string; updatedAt: number }[],
  /** 能解密出真值的 Secret。 */
  secrets: {} as Record<string, string>,
  /** 金库里「已定义」的名字（可能解不开）。缺省与 secrets 同集合。 */
  definedSecretNames: undefined as string[] | undefined,
  catalog: undefined as ProviderCatalog | undefined,
  baseUrlOverrides: {} as Record<string, string>,
  listThrows: false,
}));

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cortex-test" } }));
vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("./custom-providers", () => ({
  listCustomProviders: async () => {
    if (state.listThrows) throw new Error("disk error");
    return state.definitions;
  },
}));
vi.mock("./credentials", () => ({
  readSecrets: async () => state.secrets,
  listSecretNames: async () => state.definedSecretNames ?? Object.keys(state.secrets),
  createSafeStorageCredentialStore: () => ({}),
}));
vi.mock("./catalog", () => ({ getProviderCatalog: () => state.catalog }));
vi.mock("./prefs", () => ({
  getBaseUrlOverrides: () => state.baseUrlOverrides,
  getBaseUrlOverride: (id: string) => state.baseUrlOverrides[id],
}));
// pi-ai 是纯 ESM、只能动态引入；替身成「原样回传入参」，于是构造出来的 Provider 就是那个 config 对象
//（带 id），本模块的 setProvider → registerNativeProvider 适配才能被如实断言。
vi.mock("@earendil-works/pi-ai", () => ({ createProvider: (input: unknown) => input }));
vi.mock("@earendil-works/pi-ai/api/openai-completions.lazy", () => ({
  openAICompletionsApi: () => ({ __api: "openai-completions" }),
}));

import { resetCustomProviderRegistryForTests } from "./custom-provider-registry";
import {
  assertCustomProviderReady,
  findUnsupportedSecretRefPaths,
  PiInprocProviderError,
  resetPiInprocProviderSyncStateForTests,
  resolvePiInprocModel,
  setPiInprocModelRuntimeForTests,
  syncPiInprocProviders,
  type PiInprocProviderRegistry,
} from "./pi-inproc-models";

/** 一份合法的自定义供应商定义（apiKey 走 Secret 引用，模型能力字段齐全）。 */
function gatewayJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "公司网关",
    baseUrl: "https://gw.example/v1",
    api: "openai-completions",
    apiKey: "${secret:GW_KEY}",
    models: [
      {
        id: "gw-large",
        name: "GW Large",
        reasoning: false,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
    ...over,
  });
}

function def(id: string, json: string) {
  return { id, json, updatedAt: 1 };
}

/** 记录全部注册表调用的假 registry。 */
function fakeRegistry(providerIds: string[] = []) {
  const nativeRegistered: string[] = [];
  const configRegistered: { id: string; config: { baseUrl?: string } }[] = [];
  const unregistered: string[] = [];
  const registry: PiInprocProviderRegistry & { throwOnRegisterProvider?: string } = {
    getProviders: () => providerIds.map((id) => ({ id })),
    registerNativeProvider: (provider) => void nativeRegistered.push(provider.id),
    registerProvider: (id, config) => {
      if (registry.throwOnRegisterProvider === id) throw new Error("boom");
      configRegistered.push({ id, config });
    },
    unregisterProvider: (id) => void unregistered.push(id),
  };
  return { registry, nativeRegistered, configRegistered, unregistered };
}

beforeEach(() => {
  state.definitions = [];
  state.secrets = {};
  state.definedSecretNames = undefined;
  state.catalog = undefined;
  state.baseUrlOverrides = {};
  state.listThrows = false;
  resetCustomProviderRegistryForTests();
  resetPiInprocProviderSyncStateForTests();
});

afterEach(() => {
  setPiInprocModelRuntimeForTests(null);
});

describe("findUnsupportedSecretRefPaths", () => {
  it("顶层 apiKey 上的引用是受支持位置", () => {
    expect(findUnsupportedSecretRefPaths(gatewayJson())).toEqual([]);
  });

  it("provider 级 headers 里的引用会被指出（旧路径能用、本路径不能）", () => {
    const json = gatewayJson({ headers: { Authorization: "Bearer ${secret:TRACE}" } });
    expect(findUnsupportedSecretRefPaths(json)).toEqual(["headers.Authorization"]);
  });

  it("model 级 headers 里的引用带出数组下标，便于用户定位", () => {
    const json = JSON.stringify({
      baseUrl: "https://gw.example/v1",
      models: [{ id: "a", headers: { "X-Trace": "${secret:T}" } }],
    });
    expect(findUnsupportedSecretRefPaths(json)).toEqual(["models[0].headers.X-Trace"]);
  });

  it("完全没有引用时返回空", () => {
    expect(findUnsupportedSecretRefPaths(JSON.stringify({ apiKey: "plain", headers: { a: "b" } }))).toEqual([]);
  });

  it("JSON 不合法时返回空（那是更靠前的另一个错误，不在这里重复报）", () => {
    expect(findUnsupportedSecretRefPaths("{not json")).toEqual([]);
  });
});

describe("assertCustomProviderReady", () => {
  it("内建供应商（不在自定义列表里）直接放行", async () => {
    await expect(assertCustomProviderReady("openai")).resolves.toBeUndefined();
  });

  it("JSON 坏掉 → custom-provider-invalid-json", async () => {
    state.definitions = [def("corp-gateway", "{oops")];
    await expect(assertCustomProviderReady("corp-gateway")).rejects.toMatchObject({
      code: "custom-provider-invalid-json",
      providerId: "corp-gateway",
    });
  });

  it("顶层不是对象 → custom-provider-invalid-json", async () => {
    state.definitions = [def("corp-gateway", "[1,2,3]")];
    await expect(assertCustomProviderReady("corp-gateway")).rejects.toBeInstanceOf(PiInprocProviderError);
  });

  it("Secret 从没配过 → 报「尚未配置」", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    await expect(assertCustomProviderReady("corp-gateway")).rejects.toMatchObject({
      code: "custom-provider-secret-missing",
    });
    await expect(assertCustomProviderReady("corp-gateway")).rejects.toThrow(/尚未配置：GW_KEY/);
  });

  it("Secret 已保存但解不开 → 报「无法解密」，与「没配过」分开说", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    state.definedSecretNames = ["GW_KEY"]; // 名字在金库里，但 readSecrets 解不出来
    await expect(assertCustomProviderReady("corp-gateway")).rejects.toThrow(/无法解密.*GW_KEY/);
  });

  it("Secret 齐备时放行", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    state.secrets = { GW_KEY: "sk-real" };
    await expect(assertCustomProviderReady("corp-gateway")).resolves.toBeUndefined();
  });

  it("引用写在 headers 里 → custom-provider-secret-unsupported-position（不静默发字面量）", async () => {
    state.definitions = [def("corp-gateway", gatewayJson({ headers: { "X-Trace": "${secret:TRACE}" } }))];
    state.secrets = { GW_KEY: "sk-real", TRACE: "t" };
    await expect(assertCustomProviderReady("corp-gateway")).rejects.toMatchObject({
      code: "custom-provider-secret-unsupported-position",
    });
  });

  it("读自定义列表失败时放行（体检不该成为新的失败源）", async () => {
    state.listThrows = true;
    await expect(assertCustomProviderReady("corp-gateway")).resolves.toBeUndefined();
  });
});

describe("syncPiInprocProviders", () => {
  it("把自定义供应商经 registerNativeProvider 注册进去", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    const { registry, nativeRegistered } = fakeRegistry();
    const result = await syncPiInprocProviders(registry);
    expect(nativeRegistered).toEqual(["corp-gateway"]);
    expect(result.customProviderIds).toEqual(["corp-gateway"]);
  });

  it("用户删掉定义后再同步 → 真的摘除（不留幽灵供应商）", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    const { registry, unregistered } = fakeRegistry();
    await syncPiInprocProviders(registry);
    state.definitions = [];
    const result = await syncPiInprocProviders(registry);
    expect(unregistered).toEqual(["corp-gateway"]);
    expect(result.removedIds).toEqual(["corp-gateway"]);
    expect(result.customProviderIds).toEqual([]);
  });

  it("内建供应商的 baseUrl 覆盖走 registerProvider，且只下发 baseUrl", async () => {
    state.baseUrlOverrides = { openai: "https://my-gw.example/v1" };
    const { registry, configRegistered } = fakeRegistry(["openai"]);
    const result = await syncPiInprocProviders(registry);
    expect(configRegistered).toEqual([{ id: "openai", config: { baseUrl: "https://my-gw.example/v1" } }]);
    expect(result.baseUrlOverrideIds).toEqual(["openai"]);
  });

  it("覆盖指向注册表里不存在的供应商时跳过，不炸整批", async () => {
    state.baseUrlOverrides = { ghost: "https://x.example" };
    const { registry, configRegistered } = fakeRegistry(["openai"]);
    const result = await syncPiInprocProviders(registry);
    expect(configRegistered).toEqual([]);
    expect(result.baseUrlOverrideIds).toEqual([]);
  });

  it("自定义供应商 id 上的 baseUrl 覆盖不得走 registerProvider（否则会抹掉 native 注册）", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    state.baseUrlOverrides = { "corp-gateway": "https://other.example/v1" };
    const { registry, configRegistered, nativeRegistered } = fakeRegistry(["corp-gateway"]);
    await syncPiInprocProviders(registry);
    expect(nativeRegistered).toEqual(["corp-gateway"]);
    expect(configRegistered).toEqual([]);
  });

  it("清掉覆盖后再同步 → 摘除该覆盖", async () => {
    state.baseUrlOverrides = { openai: "https://my-gw.example/v1" };
    const { registry, unregistered } = fakeRegistry(["openai"]);
    await syncPiInprocProviders(registry);
    state.baseUrlOverrides = {};
    const result = await syncPiInprocProviders(registry);
    expect(unregistered).toEqual(["openai"]);
    expect(result.removedIds).toEqual(["openai"]);
  });

  it("单条覆盖登记失败不影响其余供应商", async () => {
    state.baseUrlOverrides = { openai: "https://a.example", anthropic: "https://b.example" };
    const { registry, configRegistered } = fakeRegistry(["openai", "anthropic"]);
    registry.throwOnRegisterProvider = "openai";
    const result = await syncPiInprocProviders(registry);
    expect(configRegistered.map((c) => c.id)).toEqual(["anthropic"]);
    expect(result.baseUrlOverrideIds).toEqual(["anthropic"]);
  });

  it("并发调用被串行化，差集不会互相踩踏", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    const { registry, nativeRegistered, unregistered } = fakeRegistry();
    const [a, b] = await Promise.all([syncPiInprocProviders(registry), syncPiInprocProviders(registry)]);
    expect(nativeRegistered).toEqual(["corp-gateway", "corp-gateway"]);
    expect(unregistered).toEqual([]);
    expect(a.customProviderIds).toEqual(["corp-gateway"]);
    expect(b.customProviderIds).toEqual(["corp-gateway"]);
  });
});

describe("resolvePiInprocModel", () => {
  /** 只实现本模块用到的那几个方法的假 ModelRuntime。 */
  function fakeRuntime(models: { provider: string; id: string }[]) {
    return {
      getProviders: () => [...new Set(models.map((m) => m.provider))].map((id) => ({ id })),
      getModel: (providerId: string, modelId: string) =>
        models.find((m) => m.provider === providerId && m.id === modelId),
      getModels: (providerId?: string) => models.filter((m) => !providerId || m.provider === providerId),
      registerNativeProvider: () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
  }

  it("命中模型时返回可直接展开进 createAgentSession 的 { modelRuntime, model }", async () => {
    const runtime = fakeRuntime([{ provider: "openai", id: "gpt-5" }]);
    setPiInprocModelRuntimeForTests(runtime as never);
    const selection = await resolvePiInprocModel({ providerId: "openai", modelId: "gpt-5" });
    expect(selection.modelRuntime).toBe(runtime);
    expect(selection.model).toMatchObject({ provider: "openai", id: "gpt-5" });
  });

  it("不给 modelId 时取该供应商的第一个模型", async () => {
    const runtime = fakeRuntime([
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "claude" },
    ]);
    setPiInprocModelRuntimeForTests(runtime as never);
    const selection = await resolvePiInprocModel({ providerId: "anthropic" });
    expect(selection.model).toMatchObject({ id: "claude" });
  });

  it("模型不存在时抛结构化错误，绝不返回「没有 model」让 pi 自己换模型", async () => {
    setPiInprocModelRuntimeForTests(fakeRuntime([{ provider: "openai", id: "gpt-5" }]) as never);
    await expect(resolvePiInprocModel({ providerId: "openai", modelId: "ghost" })).rejects.toMatchObject({
      code: "custom-provider-not-found",
    });
  });

  it("providerId 会经 safeId 归一（大小写/空格不影响命中）", async () => {
    setPiInprocModelRuntimeForTests(fakeRuntime([{ provider: "corp-gateway", id: "gw-large" }]) as never);
    const selection = await resolvePiInprocModel({ providerId: "Corp Gateway", modelId: "gw-large" });
    expect(selection.model).toMatchObject({ provider: "corp-gateway" });
  });

  it("Secret 缺失时先于模型解析失败（错误指名道姓，而不是 pi 侧一句泛泛的未认证）", async () => {
    state.definitions = [def("corp-gateway", gatewayJson())];
    setPiInprocModelRuntimeForTests(fakeRuntime([{ provider: "corp-gateway", id: "gw-large" }]) as never);
    await expect(resolvePiInprocModel({ providerId: "corp-gateway", modelId: "gw-large" })).rejects.toMatchObject({
      code: "custom-provider-secret-missing",
    });
  });
});
