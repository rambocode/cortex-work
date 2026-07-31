// pi-providers 渲染单测：只测纯函数 renderPiExtension / buildPiProviderConfig（不碰 electron/fs）。
//
// 本文件最重要的一组用例是「内建 provider 的注册配置不含 models」——那是 2026-07-30 能力事故
// （extension 替换 pi 内置模型目录 → 图片被换成 `(image omitted…)`）的根因回归防线。
import { afterEach, describe, expect, it, vi } from "vitest";

// prefs 走 cortexHome() + 文件日志,会拉进 electron；本文件承诺「不碰 electron/fs」,故整体替身。
// 覆盖值本身的读写/校验/降级由 providers/prefs.test.ts 覆盖,这里只测「覆盖值有没有被用上」。
const baseUrlOverrides = new Map<string, string>();
vi.mock("../providers/prefs", () => ({
  getBaseUrlOverride: (providerId: string): string | undefined => baseUrlOverrides.get(providerId),
}));

import {
  buildPiProviderConfig,
  endpointFormatToApi,
  PI_KEY_ENV,
  PiProviderConfigError,
  renderPiExtension,
  safeId,
  setPiProviderCatalogLoaderForTest,
} from "./pi-providers";
import type { ProviderCatalog } from "../providers/contract";

// 最小 Catalog 替身:只需要 providers[].id/baseUrl,pi-providers 只消费这两项。
function catalogWith(providers: { id: string; baseUrl?: string }[]): ProviderCatalog {
  return {
    schemaVersion: 1,
    piVersion: "0.82.1",
    hash: "test",
    providers: providers.map((p) => ({
      id: p.id,
      name: p.id,
      api: "openai-completions",
      baseUrl: p.baseUrl,
      auth: ["api-key"],
      models: [],
    })),
  };
}

function useCatalog(providers: { id: string; baseUrl?: string }[]): void {
  setPiProviderCatalogLoaderForTest(() => catalogWith(providers));
}

function useNoCatalog(): void {
  setPiProviderCatalogLoaderForTest(() => undefined);
}

afterEach(() => {
  setPiProviderCatalogLoaderForTest(null);
  baseUrlOverrides.clear();
});

// 阶段③ JSON 编辑器落地前，自定义 provider 需要的完整能力字段。
const fullModel = {
  id: "custom-m",
  name: "Custom M",
  input: ["text" as const, "image" as const],
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 32_000,
};

describe("内建 Provider：绝不下发 models（事故根因回归）", () => {
  const builtin = {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-should-not-appear",
    models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner" }],
  };

  it("registerProvider 配置里没有 models 键（传了就会整体替换 pi 内置目录）", () => {
    useCatalog([{ id: "deepseek", baseUrl: "https://api.deepseek.com" }]);
    const config = buildPiProviderConfig(builtin);
    expect(config).not.toHaveProperty("models");
    // 渲染文本里也不能出现 models —— 断言配置对象与最终源码两层都守住。
    expect(renderPiExtension(builtin)).not.toContain('"models"');
  });

  it("同样不下发 api / name：它们属于 pi 内置目录，覆盖会与内置模型自带的 api 冲突", () => {
    useCatalog([{ id: "deepseek", baseUrl: "https://api.deepseek.com" }]);
    const config = buildPiProviderConfig({ ...builtin, endpointFormat: "messages" });
    expect(config).not.toHaveProperty("api");
    expect(config).not.toHaveProperty("name");
  });

  it("baseUrl 与 Catalog 一致（含末尾斜杠差异）时不下发，视为未覆盖", () => {
    useCatalog([{ id: "deepseek", baseUrl: "https://api.deepseek.com" }]);
    expect(buildPiProviderConfig({ ...builtin, baseUrl: "https://api.deepseek.com/" })).toEqual({
      apiKey: `$${PI_KEY_ENV}`,
    });
  });

  it("用户显式覆盖 baseUrl（企业网关）时才下发", () => {
    useCatalog([{ id: "deepseek", baseUrl: "https://api.deepseek.com" }]);
    expect(buildPiProviderConfig({ ...builtin, baseUrl: "https://gw.corp.test/v1" })).toEqual({
      apiKey: `$${PI_KEY_ENV}`,
      baseUrl: "https://gw.corp.test/v1",
    });
  });

  it("apiKey 用 $CORTEX_PI_KEY 占位，绝不写入明文 key", () => {
    useCatalog([{ id: "deepseek" }]);
    const src = renderPiExtension(builtin);
    expect(src).toContain(`$${PI_KEY_ENV}`);
    expect(src).not.toContain("sk-should-not-appear");
  });

  it("即便用户填了 vision/reasoning/contextTokens，内建 provider 也一律忽略（能力只读）", () => {
    useCatalog([{ id: "deepseek" }]);
    const config = buildPiProviderConfig({
      ...builtin,
      models: [{ id: "deepseek-chat", reasoning: false, vision: false, contextTokens: 131072 }],
    });
    expect(config).not.toHaveProperty("models");
    expect(JSON.stringify(config)).not.toContain("131072");
  });

  it("id 安全化后再与 Catalog 比对：大写/空格照样命中内建", () => {
    useCatalog([{ id: "deepseek" }]);
    expect(buildPiProviderConfig({ ...builtin, id: "DeepSeek " })).not.toHaveProperty("models");
    expect(renderPiExtension({ ...builtin, id: "DeepSeek " })).toContain('pi.registerProvider("deepseek"');
  });
});

describe("自定义 Provider：完整模型定义直转，缺字段即拒绝", () => {
  const custom = {
    id: "My Custom LLM!",
    baseUrl: "https://llm.corp.test/v1",
    apiKey: "sk-secret",
    models: [fullModel],
  };

  it("字段齐全 → 完整下发 models（自定义 provider 在 pi 侧没有内置目录，必须自带）", () => {
    useCatalog([{ id: "deepseek" }]);
    const config = buildPiProviderConfig(custom) as { models: Record<string, unknown>[] };
    expect(config).toMatchObject({
      name: "My Custom LLM!",
      baseUrl: "https://llm.corp.test/v1",
      apiKey: `$${PI_KEY_ENV}`,
      api: "openai-completions",
    });
    expect(config.models).toEqual([
      {
        id: "custom-m",
        name: "Custom M",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
    ]);
    expect(renderPiExtension(custom)).toContain('pi.registerProvider("my-custom-llm"');
  });

  it("thinkingLevelMap / compat 透传，不被丢弃", () => {
    useCatalog([]);
    const config = buildPiProviderConfig({
      ...custom,
      models: [{ ...fullModel, thinkingLevelMap: { high: "xl" }, compat: { chatTemplateKwargs: { a: 1 } } }],
    }) as { models: Record<string, unknown>[] };
    expect(config.models[0]).toMatchObject({
      thinkingLevelMap: { high: "xl" },
      compat: { chatTemplateKwargs: { a: 1 } },
    });
  });

  it("endpointFormat 决定 api（自定义 provider 才消费该字段）", () => {
    useCatalog([]);
    expect(buildPiProviderConfig({ ...custom, endpointFormat: "messages" })).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("旧 UI 字段直转：vision→input、contextTokens→contextWindow（改名而非猜值）", () => {
    useCatalog([]);
    const config = buildPiProviderConfig({
      ...custom,
      models: [{ id: "m", reasoning: false, vision: false, contextTokens: 128_000, maxTokens: 4096 }],
    }) as { models: Record<string, unknown>[] };
    expect(config.models[0]).toMatchObject({ input: ["text"], contextWindow: 128_000 });
  });

  it("缺 maxTokens → 抛 PiProviderConfigError，不再兜底 8192", () => {
    useCatalog([]);
    const call = () =>
      buildPiProviderConfig({ ...custom, models: [{ ...fullModel, maxTokens: undefined }] });
    expect(call).toThrow(PiProviderConfigError);
    expect(call).toThrow(/maxTokens/);
    // 关键：错误里不能出现旧兜底值，证明确实没走猜测路径。
    try {
      call();
    } catch (e) {
      expect((e as PiProviderConfigError).issues).toEqual([
        { modelId: "custom-m", field: "maxTokens", message: expect.any(String) },
      ]);
    }
  });

  it("缺 input / reasoning / contextWindow 各自被收集为结构化 issue", () => {
    useCatalog([]);
    try {
      buildPiProviderConfig({ ...custom, models: [{ id: "m", maxTokens: 4096 }] });
      expect.unreachable("应当抛错");
    } catch (e) {
      const issues = (e as PiProviderConfigError).issues;
      expect(issues.map((i) => i.field).sort()).toEqual(["contextWindow", "input", "reasoning"]);
      expect(issues.every((i) => i.modelId === "m")).toBe(true);
      expect((e as PiProviderConfigError).code).toBe("pi-provider-config-incomplete");
    }
  });

  it("缺 baseUrl → 拒绝（pi 对自定义模型强制要求 baseUrl）", () => {
    useCatalog([]);
    expect(() => buildPiProviderConfig({ ...custom, baseUrl: "  " })).toThrow(/接口地址/);
  });

  it("绝不再出现旧的猜测默认值 131072 / 8192", () => {
    useCatalog([]);
    const src = renderPiExtension(custom);
    expect(src).not.toContain("131072");
    expect(src).not.toContain("8192");
  });

  it("插值值经 JSON 编码：含引号/反斜杠的 baseUrl 与 model id 不会破坏语法", () => {
    useCatalog([]);
    const src = renderPiExtension({
      id: "x",
      baseUrl: 'https://e/v1"; pwned()//',
      models: [{ ...fullModel, id: 'm"]; hack()//' }],
    });
    expect(src).not.toContain('v1"; pwned');
    expect(src).toContain(JSON.stringify('https://e/v1"; pwned()//'));
    expect(src).toContain(JSON.stringify('m"]; hack()//'));
  });
});

describe("Catalog 不可用时的降级：按内建处理，绝不猜 models", () => {
  it("取不到 Catalog → 只覆盖 endpoint/认证，不下发 models", () => {
    useNoCatalog();
    const config = buildPiProviderConfig({
      id: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
      models: [{ id: "deepseek-chat" }],
    });
    expect(config).toEqual({ apiKey: `$${PI_KEY_ENV}`, baseUrl: "https://api.deepseek.com" });
  });

  it("字段不全也不报错：降级路径根本不看模型能力（误判代价选『响亮失败』那侧）", () => {
    useNoCatalog();
    expect(() =>
      buildPiProviderConfig({ id: "whatever", baseUrl: "https://x/v1", models: [{ id: "m" }] }),
    ).not.toThrow();
  });

  it("Catalog 加载抛异常时同样降级，不让 extension 生成整体崩掉", () => {
    setPiProviderCatalogLoaderForTest(() => {
      throw new Error("catalog boom");
    });
    expect(
      buildPiProviderConfig({ id: "x", baseUrl: "https://x/v1", models: [{ id: "m" }] }),
    ).not.toHaveProperty("models");
  });
});

// pi 的 composeApiKeyAuth 有一条守卫「OAuth-only providers get no fabricated API-key login
// method」(provider-composer.js:179-185),只要 extension 带了 apiKey 字段就会被绕过。
// 实测(openai-codex,未登录):带占位 → `Failed to extract accountId from token`;
// 不带 → 正确的 `Use /login ...`。故 apiKey 占位必须与「确有 key 要注入」严格同步。
describe("apiKey 占位只在确有 key 时下发（不干扰 OAuth / ambient 认证）", () => {
  it("内建 Provider 无 apiKey → 配置里没有 apiKey 键", () => {
    useCatalog([{ id: "anthropic", baseUrl: "https://api.anthropic.com" }]);
    const config = buildPiProviderConfig({
      id: "anthropic",
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "claude-sonnet-4-5" }],
    });
    expect(config).not.toHaveProperty("apiKey");
    // 无 key、baseUrl 又未覆盖 → 空配置对象。pi 接受（实测:模型目录照常、认证指引正确）。
    expect(config).toEqual({});
  });

  it("空串 / 纯空白 apiKey 视同未提供（与 cli.ts 注入 env 的真值判断同一条件）", () => {
    useCatalog([{ id: "anthropic", baseUrl: "https://api.anthropic.com" }]);
    for (const apiKey of ["", "   "]) {
      expect(
        buildPiProviderConfig({ id: "anthropic", baseUrl: "https://api.anthropic.com", apiKey, models: [] }),
      ).not.toHaveProperty("apiKey");
    }
  });

  it("内建 Provider 有 apiKey → 下发 $CORTEX_PI_KEY 占位", () => {
    useCatalog([{ id: "anthropic", baseUrl: "https://api.anthropic.com" }]);
    expect(
      buildPiProviderConfig({
        id: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-x",
        models: [],
      }),
    ).toEqual({ apiKey: `$${PI_KEY_ENV}` });
  });

  it("baseUrl 覆盖与 apiKey 相互独立:无 key 也能只下发 baseUrl", () => {
    useCatalog([{ id: "anthropic", baseUrl: "https://api.anthropic.com" }]);
    expect(
      buildPiProviderConfig({ id: "anthropic", baseUrl: "https://gw.corp.test", models: [] }),
    ).toEqual({ baseUrl: "https://gw.corp.test" });
  });

  it("自定义 Provider 同样遵守该规则", () => {
    useCatalog([]);
    const noKey = buildPiProviderConfig({ ...{ id: "gw", baseUrl: "https://gw/v1" }, models: [fullModel] });
    expect(noKey).not.toHaveProperty("apiKey");
    const withKey = buildPiProviderConfig({
      id: "gw",
      baseUrl: "https://gw/v1",
      apiKey: "sk-x",
      models: [fullModel],
    });
    expect(withKey).toMatchObject({ apiKey: `$${PI_KEY_ENV}` });
  });

  it("Catalog 不可用的降级路径也遵守该规则", () => {
    useNoCatalog();
    expect(
      buildPiProviderConfig({ id: "anthropic", baseUrl: "https://api.anthropic.com", models: [] }),
    ).toEqual({ baseUrl: "https://api.anthropic.com" });
  });
});

describe("endpointFormatToApi 映射", () => {
  it("四种 endpointFormat 映射到 pi 合法 api 值", () => {
    expect(endpointFormatToApi("chat_completions")).toBe("openai-completions");
    expect(endpointFormatToApi("responses")).toBe("openai-responses");
    expect(endpointFormatToApi("messages")).toBe("anthropic-messages");
    // custom 暂按 OpenAI 兼容兜底（pi 无 custom api 值）。
    expect(endpointFormatToApi("custom")).toBe("openai-completions");
  });

  it("缺省（undefined）回退 openai-completions", () => {
    expect(endpointFormatToApi(undefined)).toBe("openai-completions");
  });
});

describe("safeId", () => {
  it("大写/空格/特殊字符 → 合法 slug；全非法字符回退 provider", () => {
    expect(safeId("My Custom LLM!")).toBe("my-custom-llm");
    expect(safeId("深度求索")).toBe("provider");
  });
});

// main-owned 的 baseUrl 覆盖（provider-prefs.json）必须真正作用到 extension 上。
// 不接这条链路时会是一次**没有任何报错**的静默失败：设置页显示已配好自建网关，
// 请求却照旧发往官方端点。
describe("内建 Provider 的 baseUrl 覆盖来自 main-owned 偏好", () => {
  const builtin = {
    id: "Anthropic", // 含大写:同时验证查询键必须走 safeId 归一化
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-x",
    models: [{ id: "claude-sonnet-4" }],
  };

  it("有覆盖时下发覆盖值，且仍不含 models（事故根因不变量）", () => {
    useCatalog([{ id: "anthropic", baseUrl: "https://api.anthropic.com" }]);
    baseUrlOverrides.set("anthropic", "https://gw.corp.com/anthropic");
    const config = buildPiProviderConfig(builtin);
    expect(config.baseUrl).toBe("https://gw.corp.com/anthropic");
    expect(config).not.toHaveProperty("models");
  });

  it("覆盖值等于 Catalog 官方端点时按「未覆盖」处理，不下发 baseUrl", () => {
    useCatalog([{ id: "anthropic", baseUrl: "https://api.anthropic.com" }]);
    baseUrlOverrides.set("anthropic", "https://api.anthropic.com/");
    expect(buildPiProviderConfig(builtin)).not.toHaveProperty("baseUrl");
  });

  it("无覆盖时行为与接入前逐字一致（回归护栏）", () => {
    useCatalog([{ id: "anthropic", baseUrl: "https://api.anthropic.com" }]);
    const config = buildPiProviderConfig(builtin);
    expect(config).not.toHaveProperty("baseUrl");
    expect(config).toEqual({ apiKey: `$${PI_KEY_ENV}` });
  });
});
