// 聚合网关接入流水线（发现 → 解析 → 生成）单测，对应方案 §B5 的五条验收。
//
// 最要紧的一组是「生成物不含任何猜测能力」：向导 UI 上没有输入能力数字的地方，
// 所以写进 pi 的每个字段都必须能追溯到「随包目录」或「用户指认的参照模型」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayBuildRequest, ProviderCatalog } from "./contract";

const state = vi.hoisted(() => ({
  catalog: undefined as ProviderCatalog | undefined,
  secrets: {} as Record<string, string>,
}));

vi.mock("./catalog", () => ({ getProviderCatalog: () => state.catalog }));
vi.mock("./credentials", () => ({ readSecrets: async () => state.secrets }));
vi.mock("../paths", () => ({ cortexHome: () => "/tmp/cortex-gateway-test" }));
vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { buildGatewayProviderJson, discoverGatewayModels, modelsEndpointCandidates } from "./gateway-onboarding";
import { validateCustomProviderJson } from "./custom-providers";

/** 一份最小 Catalog：gpt-4o 是多模态推理模型，带 compat 与 thinkingLevelMap。 */
const CATALOG: ProviderCatalog = {
  schemaVersion: 1,
  piVersion: "0.82.1",
  hash: "test",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      api: "openai-responses",
      auth: ["api-key"],
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          api: "openai-responses",
          input: ["text", "image"],
          reasoning: true,
          thinkingLevelMap: { low: "low", high: "high" },
          contextWindow: 272_000,
          maxTokens: 128_000,
          cost: { input: 2.5, output: 10 },
          compat: { systemRole: "developer" },
        },
      ],
    },
  ],
};

/** 造一个 `GET /v1/models` 的成功响应。 */
function okModelsResponse(ids: string[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "x" })) }),
  } as unknown as Response;
}

beforeEach(() => {
  state.catalog = CATALOG;
  state.secrets = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("modelsEndpointCandidates", () => {
  it("带 /v1 前缀：先试带前缀，再试去掉前缀（DeepSeek 一类的 /models 在版本前缀之外）", () => {
    expect(modelsEndpointCandidates("https://gw.example/v1")).toEqual([
      "https://gw.example/v1/models",
      "https://gw.example/models",
    ]);
  });

  it("没填 /v1：先试原样，再补一个 /v1 候选（用户漏填是最常见写法，多试一次能救回来）", () => {
    expect(modelsEndpointCandidates("https://gw.example")).toEqual([
      "https://gw.example/models",
      "https://gw.example/v1/models",
    ]);
  });

  it("容忍尾部多余斜杠与首尾空白", () => {
    expect(modelsEndpointCandidates("  https://gw.example/v1///  ")[0]).toBe("https://gw.example/v1/models");
  });
});

describe("discoverGatewayModels", () => {
  it("命中目录的模型带完整能力与来源标注；未命中的是显式 unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okModelsResponse(["gpt-4o", "gpt-5.6-luna"])));

    const res = await discoverGatewayModels({ baseUrl: "https://gw.example/v1", api: "openai-completions" });

    expect(res.ok).toBe(true);
    const [known, unknown] = res.models!;
    expect(known).toMatchObject({ id: "gpt-4o", status: "known", capabilitySource: "openai/gpt-4o" });
    // 能力逐字段来自目录，且 api 被改写成网关实际协议。
    expect(known!.model).toMatchObject({
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 272_000,
      maxTokens: 128_000,
      api: "openai-completions",
    });
    // 红线：unknown 不得带任何能力字段（不能有 input:["text"] 这类兜底）。
    expect(unknown).toEqual({ id: "gpt-5.6-luna", status: "unknown" });
  });

  it("带 Secret 名时用金库真值发 Bearer，且明文不出现在返回值里", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okModelsResponse(["gpt-4o"]));
    vi.stubGlobal("fetch", fetchMock);
    state.secrets = { GW_KEY: "sk-real-gateway-key" };

    const res = await discoverGatewayModels({
      baseUrl: "https://gw.example/v1",
      api: "openai-completions",
      secretName: "GW_KEY",
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-real-gateway-key");
    expect(JSON.stringify(res)).not.toContain("sk-real-gateway-key");
  });

  it("Secret 名在金库里不存在 → 当场失败，不发一次必然 401 的请求", async () => {
    const fetchMock = vi.fn(async () => okModelsResponse(["gpt-4o"]));
    vi.stubGlobal("fetch", fetchMock);

    const res = await discoverGatewayModels({
      baseUrl: "https://gw.example/v1",
      api: "openai-completions",
      secretName: "MISSING",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("MISSING");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401/403 与 404 给出方向不同的提示（Key 不对 vs 地址不对）", async () => {
    // 401 换个地址也一样，必须立即失败而不是把第二个候选也等一遍超时。
    const auth = vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response);
    vi.stubGlobal("fetch", auth);
    await expect(
      discoverGatewayModels({ baseUrl: "https://gw.example/v1", api: "openai-completions" }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("API Key") });
    expect(auth).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    const res404 = await discoverGatewayModels({ baseUrl: "https://gw.example/v1", api: "openai-completions" });
    // 用户最常见的错法就是把 baseUrl 填成完整端点，提示要把方向指到「地址填过头了」，
    // 并列出实际试过哪些地址。断言里同样不写补全端点的字面路径 ——
    // no-direct-endpoint.test.ts 会扫到这个测试文件。
    expect(res404.error).toContain("填到 /v1 为止");
    expect(res404.error).toContain("https://gw.example/v1/models");
    expect(res404.error).toContain("https://gw.example/models");
  });

  it("地址非 http(s) / 网关返回空列表 → 拒绝，不允许带着失败状态往下走", async () => {
    await expect(discoverGatewayModels({ baseUrl: "gw.example", api: "openai-completions" })).resolves.toMatchObject({
      ok: false,
    });
    vi.stubGlobal("fetch", vi.fn(async () => okModelsResponse([])));
    await expect(
      discoverGatewayModels({ baseUrl: "https://gw.example/v1", api: "openai-completions" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("第一个候选地址 404、第二个成功 → 整体成功（用户漏填 /v1 也能救回来）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response)
      .mockResolvedValueOnce(okModelsResponse(["gpt-4o"]));
    vi.stubGlobal("fetch", fetchMock);

    const res = await discoverGatewayModels({ baseUrl: "https://gw.example", api: "openai-completions" });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Catalog 不可用时全部 unknown，而不是编一份能力出来", async () => {
    state.catalog = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => okModelsResponse(["gpt-4o"])));

    const res = await discoverGatewayModels({ baseUrl: "https://gw.example/v1", api: "openai-completions" });
    expect(res.models).toEqual([{ id: "gpt-4o", status: "unknown" }]);
  });
});

describe("buildGatewayProviderJson", () => {
  const base: Omit<GatewayBuildRequest, "models"> = {
    id: "corp-gw",
    name: "公司网关",
    baseUrl: "https://gw.example/v1",
    api: "openai-completions",
    secretName: "GW_KEY",
  };

  it("已识别模型：能力整套来自目录，apiKey 只写 ${secret:} 引用", () => {
    const built = buildGatewayProviderJson({ ...base, models: [{ id: "gpt-4o" }] }, CATALOG);

    expect(built.ok).toBe(true);
    const parsed = JSON.parse(built.json!);
    expect(parsed.apiKey).toBe("${secret:GW_KEY}");
    expect(parsed.baseUrl).toBe("https://gw.example/v1");
    expect(parsed.models[0]).toMatchObject({
      id: "gpt-4o",
      api: "openai-completions",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 272_000,
      maxTokens: 128_000,
    });
    // compat 必须跟着一起写进去：它带的 supportsDeveloperRole:false / maxTokensField 正是
    // 让请求能被非 OpenAI 上游接受的关键，丢掉会让推理模型踩到 role: developer 的 400。
    expect(parsed.models[0].compat).toEqual({ systemRole: "developer" });
  });

  it("未识别模型且没给参照模型 → 用保守兜底照常启用（「目录不认识」不等于「不能用」）", () => {
    // 早先这里整体拒绝生成，导致 new-api 上大量模型（Kimi、各家自研…）根本没法启用。
    // 目录只是 pi 的内置快照，不是可用模型的全集；兜底只作用于目录里本来就没有的模型，
    // 不覆盖任何已知为真的值，且来源如实标成 fallback。
    const built = buildGatewayProviderJson({ ...base, models: [{ id: "gpt-5.6-luna" }] }, CATALOG);
    expect(built.ok).toBe(true);
    const model = JSON.parse(built.json!).models[0];
    expect(model.capabilitySource).toBe("fallback");
    // 兜底值逐字等于 pi 自己对缺失字段的默认，不是新发明的数字。
    expect(model).toMatchObject({ input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 16_384 });
    // 非 OpenAI 上游的保守 compat，防止推理链路踩到 role: developer / max_completion_tokens。
    expect(model.compat).toEqual({ supportsDeveloperRole: false, maxTokensField: "max_tokens" });
  });

  it("兜底生成的 JSON 同样通过 validateCustomProviderJson", () => {
    const built = buildGatewayProviderJson({ ...base, models: [{ id: "whatever-model" }] }, CATALOG);
    expect(validateCustomProviderJson(built.json!, ["GW_KEY"])).toEqual({ ok: true, errors: [] });
  });

  it("未识别模型给了参照模型 → 能力等于参照模型，id/name 用网关自己的", () => {
    const built = buildGatewayProviderJson(
      {
        ...base,
        models: [{ id: "gpt-5.6-luna", referenceProviderId: "openai", referenceModelId: "gpt-4o" }],
      },
      CATALOG,
    );

    expect(built.ok).toBe(true);
    const model = JSON.parse(built.json!).models[0];
    expect(model.id).toBe("gpt-5.6-luna");
    expect(model.name).toBe("gpt-5.6-luna");
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(272_000);
    expect(model.maxTokens).toBe(128_000);
  });

  it("参照模型指向不存在的条目 → 退到保守兜底（仍可用，且来源如实标成 fallback）", () => {
    const built = buildGatewayProviderJson(
      { ...base, models: [{ id: "x", referenceProviderId: "openai", referenceModelId: "nope" }] },
      CATALOG,
    );
    expect(built.ok).toBe(true);
    expect(JSON.parse(built.json!).models[0].capabilitySource).toBe("fallback");
  });

  it("没勾选模型 / 地址非法 → 拒绝", () => {
    expect(buildGatewayProviderJson({ ...base, models: [] }, CATALOG).ok).toBe(false);
    expect(buildGatewayProviderJson({ ...base, baseUrl: "gw", models: [{ id: "gpt-4o" }] }, CATALOG).ok).toBe(false);
  });

  it("没填 Key 时不写 apiKey 字段（无鉴权的本地端点是合法形态）", () => {
    const built = buildGatewayProviderJson(
      { ...base, secretName: undefined, models: [{ id: "gpt-4o" }] },
      CATALOG,
    );
    expect(JSON.parse(built.json!).apiKey).toBeUndefined();
  });

  it("每个模型都带 capabilitySource：目录命中标 <provider>/<model>，参照补全标 reference: 前缀", () => {
    // 方案 §B2：能力可追溯。没有它，保存之后就再也说不清某个 contextWindow 是「目录里查到的」
    // 还是「照着哪个模型抄的」——而那正是能力可追溯性的全部意义。
    const built = buildGatewayProviderJson(
      {
        ...base,
        models: [
          { id: "gpt-4o" },
          { id: "gpt-5.6-luna", referenceProviderId: "openai", referenceModelId: "gpt-4o" },
        ],
      },
      CATALOG,
    );
    const models = JSON.parse(built.json!).models;
    expect(models[0].capabilitySource).toBe("openai/gpt-4o");
    expect(models[1].capabilitySource).toBe("reference:openai/gpt-4o");
  });

  it("带 capabilitySource 的生成物仍通过 validateCustomProviderJson（校验器不因未知字段翻脸）", () => {
    const built = buildGatewayProviderJson({ ...base, models: [{ id: "gpt-4o" }] }, CATALOG);
    expect(validateCustomProviderJson(built.json!, ["GW_KEY"])).toEqual({ ok: true, errors: [] });
  });

  it("生成物不含任何明文密钥（明文红线）", () => {
    state.secrets = { GW_KEY: "sk-should-never-appear" };
    const built = buildGatewayProviderJson({ ...base, models: [{ id: "gpt-4o" }] }, CATALOG);
    expect(built.json).not.toContain("sk-should-never-appear");
  });
});

// 方案 §B5.4：生成器与校验器**同契约**。这是整条阶段B 链路的收口断言——生成物随后要经
// providerCustom:save 落盘，那条路径会用同一个校验器；两者一旦漂移，用户会在「向导说保存成功、
// 实际被拒」和「保存了但 pi 加载不了」之间二选一，都很难查。
describe("生成物与保存时的校验器同契约", () => {
  it("已识别模型生成的 JSON 通过 validateCustomProviderJson 全部校验", () => {
    const built = buildGatewayProviderJson(
      {
        id: "corp-gw",
        name: "公司网关",
        baseUrl: "https://gw.example/v1",
        api: "openai-completions",
        secretName: "GW_KEY",
        models: [{ id: "gpt-4o" }],
      },
      CATALOG,
    );
    expect(validateCustomProviderJson(built.json!, ["GW_KEY"])).toEqual({ ok: true, errors: [] });
  });

  it("参照模型补全生成的 JSON 同样通过校验", () => {
    const built = buildGatewayProviderJson(
      {
        id: "corp-gw",
        name: "公司网关",
        baseUrl: "https://gw.example/v1",
        api: "openai-completions",
        models: [{ id: "gpt-5.6-luna", referenceProviderId: "openai", referenceModelId: "gpt-4o" }],
      },
      CATALOG,
    );
    expect(validateCustomProviderJson(built.json!, [])).toEqual({ ok: true, errors: [] });
  });
});
