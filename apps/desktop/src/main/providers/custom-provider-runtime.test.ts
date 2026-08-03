// 自定义 Provider 会话运行时单测，对应方案 §A4 的五条验收：
//   1. 自定义 Provider 能解析出 extension + Secret env（会话可用）；
//   2. extension 文件里 grep 不到任何真实 key（明文红线）；
//   3. 被引用的 Secret 缺失 → 抛错并指明缺哪个（不带着未解析占位符 spawn）；
//   4. 既不在 Catalog 也不在自定义列表的 id → 抛错（调用方据此在 spawn 前失败）；
//   5. 定义的 updatedAt 透出，供渲染端计入 extensionFingerprint 触发会话重开。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { CustomProviderDefinition, ProviderCatalog } from "./contract";
import type { PiProviderInput } from "../ipc/types";

// 可变替身状态：hoisted 以便在 vi.mock 工厂里引用（工厂会被提升到 import 之前）。
const state = vi.hoisted(() => ({
  userData: "",
  definitions: [] as CustomProviderDefinition[],
  secrets: {} as Record<string, string>,
  catalog: undefined as ProviderCatalog | undefined,
  builtin: undefined as PiProviderInput | undefined,
  // 模拟 getProviderCatalog() 抛错（实测它会经 resolvePiBinary 触碰 app.isPackaged）。
  catalogThrows: false,
  definedSecretNames: undefined as string[] | undefined,
}));

vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));
vi.mock("./custom-providers", () => ({ listCustomProviders: async () => state.definitions }));
vi.mock("./credentials", () => ({
  readSecrets: async () => state.secrets,
  // 金库里「已定义」的名字集合。与 secrets（能解密的真值）刻意分开，用于区分
  // 「没配过」与「配过但解不开」两种缺失。缺省 = 与 secrets 同集合。
  listSecretNames: async () => state.definedSecretNames ?? Object.keys(state.secrets),
}));
vi.mock("./catalog", () => ({
  getProviderCatalog: () => {
    if (state.catalogThrows) throw new Error("catalog unavailable");
    return state.catalog;
  },
}));
vi.mock("./pi-provider-input", () => ({ resolvePiProviderInput: async () => state.builtin }));
// prefs 会拉进 cortexHome + 文件日志；本文件只关心「覆盖值有没有被用上」之外的逻辑，整体替身。
vi.mock("./prefs", () => ({ getBaseUrlOverride: () => undefined }));

import {
  assertOneShotProviderSupported,
  CUSTOM_SECRET_ENV_PREFIX,
  CustomProviderRuntimeError,
  resolveCustomProviderExtension,
  resolvePiSessionProvider,
} from "./custom-provider-runtime";

const REAL_KEY = "sk-corp-REALSECRET-0123456789";

/** 一份典型的公司网关配置：apiKey 与自定义 Header 都走 `${secret:...}` 引用。 */
function gatewayJson(): string {
  return JSON.stringify(
    {
      id: "corp-gateway",
      name: "公司模型",
      baseUrl: "http://gw.corp.example/v1",
      api: "openai-completions",
      apiKey: "${secret:CORP_KEY}",
      headers: { "X-Corp-Auth": "Bearer ${secret:CORP_TRACE}" },
      models: [
        {
          id: "gpt-5.6-luna",
          name: "Luna",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 32000,
        },
      ],
    },
    null,
    2,
  );
}

function defineProvider(id: string, json: string, updatedAt = 1_700_000_000_000): CustomProviderDefinition {
  return { id, json, secretRefs: [], updatedAt };
}

/** 最小 Catalog 替身：pi-providers / 本模块只消费 providers[].id/baseUrl。 */
function catalogWith(ids: string[]): ProviderCatalog {
  return {
    schemaVersion: 1,
    piVersion: "0.82.1",
    hash: "test",
    providers: ids.map((id) => ({
      id,
      name: id,
      api: "openai-completions",
      baseUrl: `https://${id}.example/v1`,
      auth: ["api-key"],
      models: [],
    })),
  };
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), "cortex-custom-provider-"));
  state.definitions = [];
  state.secrets = {};
  state.catalog = catalogWith(["openai", "anthropic"]);
  state.builtin = undefined;
  state.catalogThrows = false;
  state.definedSecretNames = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveCustomProviderExtension", () => {
  it("把自定义 JSON 渲染成 extension，并派生 Secret 环境变量", async () => {
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.secrets = { CORP_KEY: REAL_KEY, CORP_TRACE: "trace-token-xyz" };

    const runtime = await resolveCustomProviderExtension("corp-gateway");

    expect(runtime).toBeDefined();
    expect(runtime!.providerId).toBe("corp-gateway");
    expect(runtime!.updatedAt).toBe(1_700_000_000_000);
    // 环境变量按引用在 JSON 中的出现顺序编号：apiKey 在前、header 在后。
    expect(runtime!.secretEnv).toEqual({
      [`${CUSTOM_SECRET_ENV_PREFIX}0`]: REAL_KEY,
      [`${CUSTOM_SECRET_ENV_PREFIX}1`]: "trace-token-xyz",
    });

    const source = readFileSync(runtime!.extensionPath, "utf8");
    // 占位用花括号形式，避免变量名边界被后缀吞掉（"Bearer ${VAR}" 里 VAR 后紧跟引号也安全）。
    expect(source).toContain(`\${${CUSTOM_SECRET_ENV_PREFIX}0}`);
    expect(source).toContain(`Bearer \${${CUSTOM_SECRET_ENV_PREFIX}1}`);
    // 自定义 provider 必须整份下发 models（与内建路径相反）。
    expect(source).toContain("gpt-5.6-luna");
    expect(source).toContain(`pi.registerProvider("corp-gateway"`);
  });

  it("extension 文件与返回值里都不含任何明文密钥（明文红线）", async () => {
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.secrets = { CORP_KEY: REAL_KEY, CORP_TRACE: "trace-token-xyz" };

    const runtime = await resolveCustomProviderExtension("corp-gateway");
    const source = readFileSync(runtime!.extensionPath, "utf8");

    expect(source).not.toContain(REAL_KEY);
    expect(source).not.toContain("trace-token-xyz");
    // `${secret:...}` 原始引用也不该残留：它对 pi 毫无意义，留着等于一个静默失效的鉴权。
    expect(source).not.toContain("${secret:");
  });

  it("引用的 Secret 已从金库删除时抛错并指明缺哪个", async () => {
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.secrets = { CORP_KEY: REAL_KEY }; // CORP_TRACE 被删

    await expect(resolveCustomProviderExtension("corp-gateway")).rejects.toMatchObject({
      code: "custom-provider-secret-missing",
    });
    await expect(resolveCustomProviderExtension("corp-gateway")).rejects.toThrow(/CORP_TRACE/);
    await expect(resolveCustomProviderExtension("corp-gateway")).rejects.toThrow(/尚未配置/);
  });

  it("Secret 名still在金库但解不开时，错误要说「无法解密」而不是「尚未配置」", async () => {
    // 换机 / 重装后 safeStorage 密钥失效：readSecrets 会静默丢弃解不开的条目，
    // 若一律报「请去填写」，用户会对着一个明明已填好的值反复重填。
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.secrets = { CORP_KEY: REAL_KEY };
    state.definedSecretNames = ["CORP_KEY", "CORP_TRACE"];

    await expect(resolveCustomProviderExtension("corp-gateway")).rejects.toThrow(/无法解密/);
    await expect(resolveCustomProviderExtension("corp-gateway")).rejects.not.toThrow(/尚未配置/);
  });

  it("JSON 损坏时抛结构化错误，而不是带着半截配置继续", async () => {
    state.definitions = [defineProvider("corp-gateway", "{ not json ")];

    await expect(resolveCustomProviderExtension("corp-gateway")).rejects.toMatchObject({
      code: "custom-provider-invalid-json",
    });
  });

  it("同一个 Secret 被引用多次 → 共用同一个环境变量，序号不错位", async () => {
    // collectSecretRefs 去重且保序，所以「出现次数」不影响编号；两处引用必须都被替换，
    // 漏替一处就会有一个 ${secret:...} 字面量进到请求里。
    const json = JSON.stringify({
      name: "dup",
      baseUrl: "http://gw/v1",
      api: "openai-completions",
      apiKey: "${secret:K}",
      headers: { "X-A": "${secret:K}", "X-B": "${secret:OTHER}" },
      models: [
        {
          id: "m",
          name: "M",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 100,
        },
      ],
    });
    state.definitions = [defineProvider("dup", json)];
    state.secrets = { K: "key-value", OTHER: "other-value" };

    const runtime = await resolveCustomProviderExtension("dup");
    expect(runtime!.secretEnv).toEqual({
      [`${CUSTOM_SECRET_ENV_PREFIX}0`]: "key-value",
      [`${CUSTOM_SECRET_ENV_PREFIX}1`]: "other-value",
    });
    const source = readFileSync(runtime!.extensionPath, "utf8");
    // 两处 K 引用都替换成同一个变量；没有任何残留的 ${secret:} 字面量。
    expect(source.match(/CORTEX_PI_SECRET_0/g)).toHaveLength(2);
    expect(source).not.toContain("${secret:");
    expect(source).not.toContain("key-value");
    expect(source).not.toContain("other-value");
  });

  it("渲染 extension 时剥掉 capabilitySource（只把 pi 定义过的字段交给 pi）", async () => {
    // pi 的 applyExtension 对 config.models 是 `{...definition, ...}` 原样展开，未知键会一路
    // 留在 Model 对象上。落盘 JSON 是 Cortex 的记录、extension 是 pi 的输入，两者刻意不等同。
    const json = JSON.parse(gatewayJson());
    json.models[0].capabilitySource = "openai/gpt-4o";
    state.definitions = [defineProvider("corp-gateway", JSON.stringify(json))];
    state.secrets = { CORP_KEY: REAL_KEY, CORP_TRACE: "t" };

    const runtime = await resolveCustomProviderExtension("corp-gateway");
    const source = readFileSync(runtime!.extensionPath, "utf8");
    expect(source).not.toContain("capabilitySource");
    // 剥的是这一个字段，别的能力字段一个都不能少。
    expect(source).toContain("contextWindow");
    expect(source).toContain("gpt-5.6-luna");
  });

  it("未命中自定义列表返回 undefined（交由调用方继续判定）", async () => {
    expect(await resolveCustomProviderExtension("nobody")).toBeUndefined();
  });

  it("registerProvider 的注册名以 safeId 为准，不受 JSON 里 id 字段影响", async () => {
    // 用户 JSON 里写了带大写的 id；注册名必须与 `--provider` 同源（safeId），
    // 否则 pi 侧选不中这个 provider。
    const json = gatewayJson().replace('"id": "corp-gateway"', '"id": "Corp_Gateway"');
    state.definitions = [defineProvider("corp-gateway", json)];
    state.secrets = { CORP_KEY: REAL_KEY, CORP_TRACE: "t" };

    const source = readFileSync((await resolveCustomProviderExtension("corp-gateway"))!.extensionPath, "utf8");
    expect(source).toContain(`pi.registerProvider("corp-gateway"`);
    expect(source).not.toContain("Corp_Gateway");
  });
});

describe("resolvePiSessionProvider（三段式）", () => {
  it("命中 Catalog 走内建路径，且注册配置不含 models（内建目录不可被替换）", async () => {
    state.builtin = { id: "openai", baseUrl: "https://openai.example/v1", apiKey: "k", models: [] };

    const resolved = await resolvePiSessionProvider("openai");

    expect(resolved.kind).toBe("builtin");
    const source = readFileSync(
      (resolved as { extensionPath: string }).extensionPath,
      "utf8",
    );
    expect(source).not.toContain("models");
  });

  it("未命中 Catalog 但命中自定义列表 → 走自定义路径", async () => {
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.secrets = { CORP_KEY: REAL_KEY, CORP_TRACE: "t" };

    const resolved = await resolvePiSessionProvider("corp-gateway");
    expect(resolved.kind).toBe("custom");
  });

  it("两处都未命中 → 抛错（调用方据此在 spawn 前失败）", async () => {
    await expect(resolvePiSessionProvider("ghost-provider")).rejects.toBeInstanceOf(CustomProviderRuntimeError);
    await expect(resolvePiSessionProvider("ghost-provider")).rejects.toMatchObject({
      code: "custom-provider-not-found",
    });
  });

  it("Catalog 不可用时，自定义 Provider 仍先于内建降级路径被命中", async () => {
    // 回归防线：若顺序反过来，Catalog 一次加载失败就会把自定义 Provider 误判成内建
    // （不下发 models）→ pi 拿不到任何模型，会话必挂。
    state.catalog = undefined;
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.secrets = { CORP_KEY: REAL_KEY, CORP_TRACE: "t" };
    state.builtin = { id: "corp-gateway", baseUrl: "", models: [] };

    const resolved = await resolvePiSessionProvider("corp-gateway");
    expect(resolved.kind).toBe("custom");
  });

  it("Catalog 读取抛错 → 当作不可用降级，而不是让开会话整体崩掉", async () => {
    // getProviderCatalog() 内部经 resolvePiBinary 定位随包目录，二进制缺失时会直接抛
    //（它的「不抛异常」承诺只覆盖校验失败）。一次定位失败不该把整个聊天打死。
    state.catalogThrows = true;
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.secrets = { CORP_KEY: REAL_KEY, CORP_TRACE: "t" };

    const resolved = await resolvePiSessionProvider("corp-gateway");
    expect(resolved.kind).toBe("custom");
  });

  it("Catalog 不可用且非自定义 id → 退回内建降级路径（不误判为不存在）", async () => {
    state.catalog = undefined;
    state.builtin = { id: "openai", baseUrl: "https://openai.example/v1", models: [] };

    const resolved = await resolvePiSessionProvider("openai");
    expect(resolved.kind).toBe("builtin");
  });
});

describe("assertOneShotProviderSupported（单发路径守卫）", () => {
  it("命中自定义 Provider → 抛错（不让单发链路带着未解析的 provider 继续 spawn）", async () => {
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    await expect(assertOneShotProviderSupported("corp-gateway")).rejects.toBeInstanceOf(
      CustomProviderRuntimeError,
    );
  });

  it("内建 Provider / 未知 id / 未传 id → 放行（既有行为完全不变）", async () => {
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    await expect(assertOneShotProviderSupported("openai")).resolves.toBeUndefined();
    await expect(assertOneShotProviderSupported("whatever")).resolves.toBeUndefined();
    await expect(assertOneShotProviderSupported(undefined)).resolves.toBeUndefined();
  });

  it("Catalog 读取抛错 → 放行而不是把守卫变成新的失败源", async () => {
    // 实测 getProviderCatalog() 会经 resolvePiBinary 触碰 app.isPackaged，在缺少 electron
    // 环境时抛错（catalog.ts 的「不抛异常」承诺只覆盖校验失败，不覆盖定位失败）。
    // 守卫必须吞掉它——否则接入守卫本身就会拖垮所有单发路径。
    state.definitions = [defineProvider("corp-gateway", gatewayJson())];
    state.catalogThrows = true;
    await expect(assertOneShotProviderSupported("corp-gateway")).resolves.toBeUndefined();
  });
});
