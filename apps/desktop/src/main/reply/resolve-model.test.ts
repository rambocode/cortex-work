import { describe, it, expect } from "vitest";
import { resolveReplyModel } from "./resolve-model";
import type { ProviderProfile, ProviderSettings } from "../ipc/types";

// 构造一个 chat_completions、enabled、带一个模型的合法供应商；可 override 任意字段做反例。
function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "p1",
    name: "P1",
    baseUrl: "https://api.p1.test/v1",
    apiKey: "sk-p1",
    endpointFormat: "chat_completions",
    models: [{ id: "m1" }, { id: "m2" }],
    enabled: true,
    ...overrides,
  };
}

function settingsWith(providers: ProviderProfile[], extra: Partial<ProviderSettings> = {}): ProviderSettings {
  return { providers, ...extra };
}

describe("resolveReplyModel 专属级", () => {
  it("专属 providerId 合法 + 显式 model → 采用专属选择", () => {
    const ps = settingsWith([provider({ id: "reply", name: "Reply" })], {
      defaultProviderId: "reply",
      defaultModel: "should-not-win",
    });
    const res = resolveReplyModel({ providerId: "reply", model: "m2" }, ps);
    expect(res).toEqual({
      providerId: "reply",
      providerName: "Reply",
      baseUrl: "https://api.p1.test/v1",
      apiKey: "sk-p1",
      model: "m2",
    });
  });

  it("专属 providerId 合法但未选 model → 回落供应商 models[0]", () => {
    const ps = settingsWith([provider({ id: "reply" })]);
    const res = resolveReplyModel({ providerId: "reply" }, ps);
    expect(res?.model).toBe("m1");
  });
});

describe("resolveReplyModel 专属失败 → 落默认链", () => {
  const defaultProvider = provider({ id: "def", name: "Def", models: [{ id: "dm" }] });

  it("专属供应商不存在 → 落默认", () => {
    const ps = settingsWith([defaultProvider], { defaultProviderId: "def" });
    const res = resolveReplyModel({ providerId: "missing" }, ps);
    expect(res?.providerId).toBe("def");
    expect(res?.model).toBe("dm");
  });

  it("专属供应商被禁用 → 落默认", () => {
    const ps = settingsWith([provider({ id: "reply", enabled: false }), defaultProvider], {
      defaultProviderId: "def",
    });
    const res = resolveReplyModel({ providerId: "reply" }, ps);
    expect(res?.providerId).toBe("def");
  });

  it("专属供应商非 chat_completions → 落默认", () => {
    const ps = settingsWith(
      [provider({ id: "reply", endpointFormat: "responses" }), defaultProvider],
      { defaultProviderId: "def" },
    );
    const res = resolveReplyModel({ providerId: "reply" }, ps);
    expect(res?.providerId).toBe("def");
  });

  it("专属选中但供应商无模型且未显式选 model → 落默认", () => {
    const ps = settingsWith([provider({ id: "reply", models: [] }), defaultProvider], {
      defaultProviderId: "def",
    });
    const res = resolveReplyModel({ providerId: "reply" }, ps);
    expect(res?.providerId).toBe("def");
  });
});

describe("resolveReplyModel 默认链校验", () => {
  it("defaultModel 显式 → 优先于 models[0]", () => {
    const ps = settingsWith([provider({ id: "def", models: [{ id: "a" }, { id: "b" }] })], {
      defaultProviderId: "def",
      defaultModel: "b",
    });
    const res = resolveReplyModel(null, ps);
    expect(res?.model).toBe("b");
  });

  it("默认供应商非 chat_completions → null", () => {
    const ps = settingsWith([provider({ id: "def", endpointFormat: "messages" })], {
      defaultProviderId: "def",
    });
    expect(resolveReplyModel(null, ps)).toBeNull();
  });

  it("默认供应商被禁用 → null", () => {
    const ps = settingsWith([provider({ id: "def", enabled: false })], {
      defaultProviderId: "def",
    });
    expect(resolveReplyModel(null, ps)).toBeNull();
  });
});

describe("resolveReplyModel 全缺失 / 边界", () => {
  it("settings 为 null 且无默认 → null", () => {
    expect(resolveReplyModel(null, settingsWith([provider()]))).toBeNull();
  });

  it("providerSettings 为 null → null", () => {
    expect(resolveReplyModel({ providerId: "reply" }, null)).toBeNull();
  });

  it("settings 为 null → 走默认链解析成功", () => {
    const ps = settingsWith([provider({ id: "def" })], { defaultProviderId: "def" });
    const res = resolveReplyModel(null, ps);
    expect(res?.providerId).toBe("def");
  });

  it("专属 providerId 仅空白 → 视为未选，走默认链", () => {
    const ps = settingsWith([provider({ id: "def" })], { defaultProviderId: "def" });
    const res = resolveReplyModel({ providerId: "   " }, ps);
    expect(res?.providerId).toBe("def");
  });
});
