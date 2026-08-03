// 能力解析器单测（方案 §B5 验收 + 2026-07-30 能力事故的红线回归）。
//
// 本模块是纯函数、不碰 electron / fs / 网络，所以这里**一个 mock 都没有**：
// 只造 `ProviderCatalog` 替身即可。任何日后为它引入 mock 的改动，都说明模块被污染了。
//
// 测试要守住的三条线（与实现文件头一一对应）：
//   1. 不猜能力 —— unknown 必须是空壳，不得夹带任何兜底能力字段（事故形态就是「悄悄降级成
//      text-only / 131072」，而不是显式说不知道）；
//   2. 匹配保守 —— 只做小写与 `-latest` 归一，`gpt-4o-mini` 绝不能被当成 `gpt-4o`；
//   3. 协议是匹配键的一部分 —— 跨 api 复用能力时必须丢 `compat`（能力研究 §5.3）。

import { describe, expect, it } from "vitest";

import { applyReferenceModel, normalizeModelId, resolveModelCapabilities } from "./capability-resolver";
import type { CatalogModel, CatalogProvider, ProviderCatalog } from "./contract";

// ── 替身工厂 ──────────────────────────────────────────────────────────────────

/**
 * 造一条目录模型。刻意 `Object.freeze`：生产环境的 Catalog 由 `loadProviderCatalogAt` 深冻结，
 * 解析器若哪天改成就地改写（而不是复制），在这里就会当场抛错而不是等到线上污染目录。
 */
function model(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  const built: CatalogModel = {
    id,
    name: id.toUpperCase(),
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 2.5, output: 10 },
    ...overrides,
  };
  Object.freeze(built.input);
  return Object.freeze(built);
}

function provider(id: string, models: CatalogModel[], overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id,
    name: id,
    api: models[0]?.api ?? "openai-responses",
    auth: ["api-key"],
    models,
    ...overrides,
  };
}

function catalogOf(...providers: CatalogProvider[]): ProviderCatalog {
  return { schemaVersion: 1, piVersion: "0.82.1", hash: "test-hash", providers };
}

/**
 * 真实目录里的 thinkingLevelMap 用 `null` 表示「该档位不下发思考参数」（325 条里 209 条含 null，
 * gateway.ts 的翻译逻辑也显式判 `=== null`），但 `CatalogModel.thinkingLevelMap` 声明成
 * `Record<string, string>`。这里刻意造带 null 的真实形状并断言它被原样带过 —— 类型窄了是
 * contract 的问题（见本文件末尾的实现问题记录），测试不该为了迁就它去造一份失真的数据。
 */
const THINKING_LEVEL_MAP = { off: null, low: "low", medium: "medium", high: "high" } as unknown as Record<
  string,
  string
>;

/** 目录里最典型的一条：多模态、128k、带 thinkingLevelMap 与 compat 的 gpt-4o。 */
const GPT_4O = model("gpt-4o", {
  api: "openai-responses",
  input: ["text", "image"],
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 16384,
  thinkingLevelMap: THINKING_LEVEL_MAP,
  compat: { supportsStrictMode: true },
});

const BASE_CATALOG = catalogOf(provider("openai", [GPT_4O]));

/** 网关一律 OpenAI 兼容协议 —— 与目录里 gpt-4o 记录的 `openai-responses` 不同，跨协议路径。 */
const GATEWAY_API = "openai-completions";

// ── 1. 精确命中：能力逐字段照抄，只改协议 ────────────────────────────────────

describe("resolveModelCapabilities · 精确命中", () => {
  // 事故核心回归：命中后能力必须是目录的原值，不能被 Cortex 的旧映射改写成 text/131072。
  it("命中目录条目时，五组能力字段与目录逐字段一致，一个都不许被重算", () => {
    const result = resolveModelCapabilities("gpt-4o", GATEWAY_API, BASE_CATALOG);

    expect(result.status).toBe("known");
    if (result.status !== "known") return;
    expect(result.model.input).toEqual(["text", "image"]);
    expect(result.model.reasoning).toBe(false);
    expect(result.model.contextWindow).toBe(128000);
    expect(result.model.maxTokens).toBe(16384);
    // null 档位（「该档不下发思考参数」）必须原样带过，不能被过滤或折算成字符串。
    expect(result.model.thinkingLevelMap).toEqual({ off: null, low: "low", medium: "medium", high: "high" });
  });

  it("api 被改写成网关实际协议，而不是留着目录记录的协议（请求要按网关的形状发）", () => {
    const result = resolveModelCapabilities("gpt-4o", GATEWAY_API, BASE_CATALOG);
    expect(result.status === "known" && result.model.api).toBe("openai-completions");
  });

  it("sourceRef 指回目录出处，供只读展示与日后审计", () => {
    const result = resolveModelCapabilities("gpt-4o", GATEWAY_API, BASE_CATALOG);
    expect(result.status === "known" && result.sourceRef).toBe("openai/gpt-4o");
  });

  it("解析不改动目录本身（目录对 Cortex 只读）", () => {
    resolveModelCapabilities("gpt-4o", GATEWAY_API, BASE_CATALOG);
    expect(GPT_4O.api).toBe("openai-responses");
    expect(GPT_4O.compat).toEqual({ supportsStrictMode: true });
  });
});

// ── 2. compat 必须整套保留（线上 400 的回归防线）─────────────────────────────

describe("resolveModelCapabilities · compat 一律保留", () => {
  // 这组用例是一次线上故障的回归防线，也推翻了此处原先的规则。
  //
  // 原规则是「api 不一致就丢掉 compat」，理由写的是「丢掉只会回到该 api 的默认行为，是安全方向」。
  // 用随包 pi 二进制 + 假网关逐条抓请求，实测结果正相反：
  //   reasoning:false + 无 compat → role: system    / max_completion_tokens
  //   reasoning:true  + 无 compat → role: developer / max_completion_tokens   ← 400 的来源
  //   reasoning:true  + 有 compat → role: system    / max_tokens
  // 即 pi 对**推理模型**默认按现代 OpenAI 约定发 `developer` 角色，而经 new-api 这类网关转发到
  // 的上游只认 system/assistant/user/tool，直接 400：`invalid value: developer`。
  // 目录里 supportsDeveloperRole 414 处全为 false、maxTokensField 93 处全为 "max_tokens" ——
  // 这些开关存在的唯一意义就是替非 OpenAI 上游关掉这些约定，丢掉等于主动拼出上游不认的请求。
  it("跨协议复用时也保留 compat（丢掉会让推理模型踩到 role: developer 的 400）", () => {
    const result = resolveModelCapabilities("gpt-4o", "openai-completions", BASE_CATALOG);
    expect(result.status === "known" && result.model.compat).toEqual({ supportsStrictMode: true });
  });

  it("协议完全相同时 compat 原样保留", () => {
    const result = resolveModelCapabilities("gpt-4o", "openai-responses", BASE_CATALOG);
    expect(result.status === "known" && result.model.compat).toEqual({ supportsStrictMode: true });
  });

  it("目录条目本来就没有 compat 时不凭空造一个（不猜仍然成立）", () => {
    const noCompat: ProviderCatalog = {
      ...BASE_CATALOG,
      providers: BASE_CATALOG.providers.map((p) => ({
        ...p,
        models: p.models.map(({ compat: _drop, ...rest }) => rest),
      })),
    };
    const result = resolveModelCapabilities("gpt-4o", "openai-completions", noCompat);
    if (result.status !== "known") throw new Error("应命中");
    expect(JSON.parse(JSON.stringify(result.model))).not.toHaveProperty("compat");
  });
});

// ── 3. 保守归一：宁可 unknown，也不错配 ──────────────────────────────────────

describe("normalizeModelId · 只做确定性变换", () => {
  it("小写化与去 latest 后缀是确定性的，可以做", () => {
    expect(normalizeModelId("GPT-4O")).toBe("gpt-4o");
    expect(normalizeModelId("  gpt-4o  ")).toBe("gpt-4o");
    expect(normalizeModelId("gpt-4o-latest")).toBe("gpt-4o");
    expect(normalizeModelId("gpt-4o:latest")).toBe("gpt-4o");
  });

  // 这几条"看起来也该归一"的变换一旦做了，就是把能力不同的模型混为一谈。
  it("版本日期后缀、-mini、-turbo 一律不动（它们是不同模型，不是别名）", () => {
    expect(normalizeModelId("gpt-4o-2024-08-06")).toBe("gpt-4o-2024-08-06");
    expect(normalizeModelId("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(normalizeModelId("gpt-4-turbo")).toBe("gpt-4-turbo");
  });
});

describe("resolveModelCapabilities · 保守匹配", () => {
  it.each([["GPT-4O"], ["gpt-4o-latest"], ["gpt-4o:latest"], ["  GPT-4o:Latest "]])(
    "%s 能归一到 gpt-4o 并命中",
    (raw) => {
      expect(resolveModelCapabilities(raw, GATEWAY_API, BASE_CATALOG).status).toBe("known");
    },
  );

  // 红线：错配（把一份错误能力当成真的用）比 unknown（让用户点一次参照模型）危险得多。
  // gpt-4o-mini 与 gpt-4o 的 cost / maxTokens 完全不同，前缀匹配会直接算错账、发错请求。
  it.each([["gpt-4o-mini"], ["gpt-4o-2024-08-06"], ["gpt-4"], ["gpt-4o-audio-preview"], ["my-gpt-4o"]])(
    "%s 不做模糊/前缀匹配，必须 unknown",
    (raw) => {
      expect(resolveModelCapabilities(raw, GATEWAY_API, BASE_CATALOG).status).toBe("unknown");
    },
  );

  // 归一在「查询侧」与「目录侧」是对称的：目录里本来就叫 *-latest 的滚动别名照样查得到。
  it("目录条目自身带 latest 后缀时，用其原始 id 仍能命中", () => {
    const catalog = catalogOf(provider("openai", [model("chatgpt-4o-latest", { api: GATEWAY_API })]));
    expect(resolveModelCapabilities("chatgpt-4o-latest", GATEWAY_API, catalog).status).toBe("known");
    expect(resolveModelCapabilities("chatgpt-4o", GATEWAY_API, catalog).status).toBe("known");
  });
});

// ── 4. 渠道前缀：命中目录，但返回网关自己的 id ───────────────────────────────

describe("resolveModelCapabilities · new-api 风格的渠道前缀", () => {
  it.each([["openai/gpt-4o"], ["azure/gpt-4o"], ["OpenAI/GPT-4o"]])("%s 取最后一段后能命中", (raw) => {
    expect(resolveModelCapabilities(raw, GATEWAY_API, BASE_CATALOG).status).toBe("known");
  });

  // 红线：pi 要拿这个 id 去请求网关。写成目录 id（gpt-4o）会让带渠道前缀的网关直接 404。
  it("返回的 model.id 是网关原始 id，而非目录 id", () => {
    const result = resolveModelCapabilities("openai/gpt-4o", GATEWAY_API, BASE_CATALOG);
    if (result.status !== "known") throw new Error("应命中");
    expect(result.model.id).toBe("openai/gpt-4o");
    // 但 sourceRef 仍指向目录出处，两者不能混淆。
    expect(result.sourceRef).toBe("openai/gpt-4o");
  });

  it("大小写混排的原始 id 也原样保留，不被归一化写回", () => {
    const result = resolveModelCapabilities("Azure/GPT-4o", GATEWAY_API, BASE_CATALOG);
    expect(result.status === "known" && result.model.id).toBe("Azure/GPT-4o");
  });

  // 目录里本就含 `/` 的 id（openrouter 的 `qwen/qwen3-32b`）必须整串先匹配，
  // 否则会被当成"渠道前缀"截成 `qwen3-32b` 而落空。
  it("目录 id 自带斜杠时按整串命中，不被误当作渠道前缀", () => {
    const catalog = catalogOf(provider("openrouter", [model("qwen/qwen3-32b", { api: GATEWAY_API })]));
    expect(resolveModelCapabilities("qwen/qwen3-32b", GATEWAY_API, catalog).status).toBe("known");
  });

  it("前缀存在但最后一段不在目录里 → 仍是 unknown，不退化成前缀匹配", () => {
    expect(resolveModelCapabilities("openai/gpt-9o", GATEWAY_API, BASE_CATALOG).status).toBe("unknown");
  });
});

// ── 5. 能力冲突：宁可 unknown，也不随便挑一条 ────────────────────────────────

describe("resolveModelCapabilities · 同名模型的能力冲突", () => {
  /** 同一模型 id 挂在两个 Provider 下，能力由 overrides 决定是否一致。 */
  const twoProviders = (a: Partial<CatalogModel>, b: Partial<CatalogModel>) =>
    catalogOf(
      provider("vendor-a", [model("shared-model", { api: "anthropic-messages", ...a })]),
      provider("vendor-b", [model("shared-model", { api: "anthropic-messages", ...b })]),
    );

  // 红线：挑错一条 = 用一份错误能力去请求。上下文窗口挑大了会直接被网关拒绝或截断。
  it("contextWindow 不一致 → unknown，不允许随便挑一条", () => {
    const catalog = twoProviders({ contextWindow: 200000 }, { contextWindow: 1000000 });
    expect(resolveModelCapabilities("shared-model", GATEWAY_API, catalog).status).toBe("unknown");
  });

  it("input 不一致（一条支持图片一条不支持）→ unknown，绝不乐观地取多模态那条", () => {
    const catalog = twoProviders({ input: ["text", "image"] }, { input: ["text"] });
    expect(resolveModelCapabilities("shared-model", GATEWAY_API, catalog).status).toBe("unknown");
  });

  it("reasoning 不一致 → unknown", () => {
    const catalog = twoProviders({ reasoning: true }, { reasoning: false });
    expect(resolveModelCapabilities("shared-model", GATEWAY_API, catalog).status).toBe("unknown");
  });

  it("thinkingLevelMap 不一致 → unknown", () => {
    const catalog = twoProviders({ thinkingLevelMap: { low: "low" } }, {});
    expect(resolveModelCapabilities("shared-model", GATEWAY_API, catalog).status).toBe("unknown");
  });

  it("能力完全一致时可命中（多 Provider 收录同一模型是常态，不该因此退化）", () => {
    const catalog = twoProviders({}, {});
    expect(resolveModelCapabilities("shared-model", GATEWAY_API, catalog).status).toBe("known");
  });

  // cost 与 name 不是能力：它们不同不该拖累判定，否则绝大多数跨 Provider 模型都会 unknown。
  it("只有 cost / name 不同时仍算等价，照常命中", () => {
    const catalog = twoProviders(
      { name: "Shared (A)", cost: { input: 1, output: 2 } },
      { name: "Shared (B)", cost: { input: 9, output: 20 } },
    );
    expect(resolveModelCapabilities("shared-model", GATEWAY_API, catalog).status).toBe("known");
  });
});

// ── 6. 协议优先 ──────────────────────────────────────────────────────────────

describe("resolveModelCapabilities · 协议优先", () => {
  /** 同名模型分挂三家：只有 gw-native 那条的 api 与网关协议完全一致。 */
  const catalog = catalogOf(
    provider("vendor-anthropic", [
      model("multi-home", { api: "anthropic-messages", contextWindow: 1000000, compat: { tag: "anthropic" } }),
    ]),
    provider("gw-native", [
      model("multi-home", { api: GATEWAY_API, contextWindow: 200000, compat: { tag: "completions" } }),
    ]),
    provider("vendor-responses", [
      model("multi-home", { api: "openai-responses", contextWindow: 400000, compat: { tag: "responses" } }),
    ]),
  );

  it("存在协议完全一致的候选时优先取它（能力属于 route + model，不是模型名的永恒属性）", () => {
    const result = resolveModelCapabilities("multi-home", GATEWAY_API, catalog);
    expect(result.status === "known" && result.model.contextWindow).toBe(200000);
    expect(result.status === "known" && result.sourceRef).toBe("gw-native/multi-home");
  });

  it("协议一致的候选其 compat 得以保留（这正是协议优先存在的理由）", () => {
    const result = resolveModelCapabilities("multi-home", GATEWAY_API, catalog);
    expect(result.status === "known" && result.model.compat).toEqual({ tag: "completions" });
  });

  // 注意这是**当前实现的既定取舍**：协议优先在冲突判定之前生效，因此其余候选的能力矛盾
  // 不会让结果退回 unknown。同名模型经不同协议本来就可能有不同能力，协议一致的那条更可信。
  it("协议一致的候选唯一时，其余候选的能力矛盾不再阻断命中", () => {
    expect(resolveModelCapabilities("multi-home", GATEWAY_API, catalog).status).toBe("known");
  });

  it("协议一致的候选有多条且彼此矛盾 → 仍退回 unknown", () => {
    const conflicting = catalogOf(
      provider("gw-a", [model("multi-home", { api: GATEWAY_API, contextWindow: 200000 })]),
      provider("gw-b", [model("multi-home", { api: GATEWAY_API, contextWindow: 128000 })]),
    );
    expect(resolveModelCapabilities("multi-home", GATEWAY_API, conflicting).status).toBe("unknown");
  });
});

// ── 7. 降级路径：查不到就是查不到 ────────────────────────────────────────────

describe("resolveModelCapabilities · Catalog 不可用与空输入", () => {
  // Catalog 构建产物缺失 / 校验失败时，「查不到」是真的查不到，不能编一份能力出来。
  it("Catalog 未加载 → unknown", () => {
    expect(resolveModelCapabilities("gpt-4o", GATEWAY_API, undefined).status).toBe("unknown");
  });

  it("Catalog 为空目录 → unknown", () => {
    expect(resolveModelCapabilities("gpt-4o", GATEWAY_API, catalogOf()).status).toBe("unknown");
  });

  it.each([
    ["空串", ""],
    ["纯空白", "   "],
  ])("模型 id 为%s → unknown，不落入任何匹配分支", (_label, raw) => {
    expect(resolveModelCapabilities(raw, GATEWAY_API, BASE_CATALOG).status).toBe("unknown");
  });
});

// ── 8. 参照模型补全 ──────────────────────────────────────────────────────────

describe("applyReferenceModel · 用户指认的能力来源", () => {
  const reference = { providerId: "openai", model: GPT_4O };

  it("能力整套继承自参照模型（把六个字段手填压缩成一次选择，值仍然完整确定）", () => {
    const result = applyReferenceModel("gpt-5.6-luna", GATEWAY_API, reference);
    if (result.status !== "known") throw new Error("参照补全必然 known");
    expect(result.model.input).toEqual(["text", "image"]);
    expect(result.model.reasoning).toBe(false);
    expect(result.model.contextWindow).toBe(128000);
    expect(result.model.maxTokens).toBe(16384);
    expect(result.model.thinkingLevelMap).toEqual(GPT_4O.thinkingLevelMap);
    expect(result.model.cost).toEqual(GPT_4O.cost);
  });

  it("id 与 name 换成网关模型 id，不能留着参照模型的身份去请求网关", () => {
    const result = applyReferenceModel("gpt-5.6-luna", GATEWAY_API, reference);
    if (result.status !== "known") throw new Error("参照补全必然 known");
    expect(result.model.id).toBe("gpt-5.6-luna");
    expect(result.model.name).toBe("gpt-5.6-luna");
  });

  it("api 改写为网关协议", () => {
    const result = applyReferenceModel("gpt-5.6-luna", GATEWAY_API, reference);
    expect(result.status === "known" && result.model.api).toBe(GATEWAY_API);
  });

  // 与自动解析同一条规则：用户指认参照模型，说的就是「行为跟那个一样」，协议开关正是
  // 这句话里最实质的部分。丢掉它，推理类模型会立刻踩到 role: developer 那个 400。
  it("参照模型协议不同时也整套继承 compat", () => {
    const result = applyReferenceModel("gpt-5.6-luna", GATEWAY_API, reference);
    expect(result.status === "known" && result.model.compat).toEqual({ supportsStrictMode: true });
  });

  it("参照模型协议相同时保留 compat", () => {
    const result = applyReferenceModel("gpt-5.6-luna", "openai-responses", reference);
    expect(result.status === "known" && result.model.compat).toEqual({ supportsStrictMode: true });
  });

  // sourceRef 前缀区分「目录自动命中」与「用户指认」——两者都不是猜测，区别只在谁负责。
  it("sourceRef 带 reference: 前缀，与自动命中可区分（供只读展示与审计）", () => {
    const result = applyReferenceModel("gpt-5.6-luna", GATEWAY_API, reference);
    expect(result.status === "known" && result.sourceRef).toBe("reference:openai/gpt-4o");
  });

  it("不改动参照模型本身", () => {
    applyReferenceModel("gpt-5.6-luna", GATEWAY_API, reference);
    expect(GPT_4O.id).toBe("gpt-4o");
    expect(GPT_4O.name).toBe("GPT-4O");
    expect(GPT_4O.api).toBe("openai-responses");
  });
});

// ── 9. 最重要的红线：unknown 是空壳 ──────────────────────────────────────────

describe("红线回归 · unknown 不得夹带任何兜底能力", () => {
  /** 所有会走到 unknown 的入口，逐个验证返回值形状。 */
  const unknownCases: [string, () => ReturnType<typeof resolveModelCapabilities>][] = [
    ["Catalog 未加载", () => resolveModelCapabilities("gpt-4o", GATEWAY_API, undefined)],
    ["空 id", () => resolveModelCapabilities("", GATEWAY_API, BASE_CATALOG)],
    ["目录里没有该模型", () => resolveModelCapabilities("gpt-5.6-luna", GATEWAY_API, BASE_CATALOG)],
    ["前缀相近但不是同一模型", () => resolveModelCapabilities("gpt-4o-mini", GATEWAY_API, BASE_CATALOG)],
    [
      "同名模型能力冲突",
      () =>
        resolveModelCapabilities(
          "shared-model",
          GATEWAY_API,
          catalogOf(
            provider("a", [model("shared-model", { contextWindow: 8000 })]),
            provider("b", [model("shared-model", { contextWindow: 32000 })]),
          ),
        ),
    ],
  ];

  // 2026-07-30 事故的形态就是「未知被静默折算成 text-only / 固定 contextWindow」。
  // 这里断言返回对象上**除 status 外一无所有**：没有 model、没有 input、没有任何数字兜底。
  it.each(unknownCases)("%s：返回值只有 status，没有 model 也没有任何能力字段", (_label, run) => {
    const result = run();

    expect(result.status).toBe("unknown");
    expect(Object.keys(result)).toEqual(["status"]);
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("input");
    expect(result).not.toHaveProperty("contextWindow");
    expect(result).not.toHaveProperty("sourceRef");
  });

  it("unknown 与 known 是穷尽两态，没有第三种「半知道」的中间状态", () => {
    const known = resolveModelCapabilities("gpt-4o", GATEWAY_API, BASE_CATALOG);
    const unknown = resolveModelCapabilities("gpt-4o-mini", GATEWAY_API, BASE_CATALOG);
    expect([known.status, unknown.status]).toEqual(["known", "unknown"]);
  });
});
