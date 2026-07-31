import { describe, it, expect } from "vitest";
import { initialAgent, initialModelDraft, resolveDefaultAgent } from "./personal";
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettings } from "../desktop/types";

const general = (patch: Partial<GeneralSettings>): GeneralSettings => ({ ...DEFAULT_GENERAL_SETTINGS, ...patch });

describe("resolveDefaultAgent", () => {
  it("未设置时按安装情况派生（claude 可用 → claude）", () => {
    expect(resolveDefaultAgent({ generalSettings: general({}), agentsAvailable: { claude: true } })).toBe("claude");
  });
  it("用户设置且可用则沿用", () => {
    expect(
      resolveDefaultAgent({ generalSettings: general({ defaultAgent: "codex" }), agentsAvailable: { claude: true, codex: true } }),
    ).toBe("codex");
  });
  it("用户设置但不可用则回退派生", () => {
    expect(
      resolveDefaultAgent({ generalSettings: general({ defaultAgent: "codex" }), agentsAvailable: { claude: true, codex: false } }),
    ).toBe("claude");
  });
  it("pi 恒可用", () => {
    expect(resolveDefaultAgent({ generalSettings: general({ defaultAgent: "pi" }), agentsAvailable: {} })).toBe("pi");
  });
});

describe("initialAgent", () => {
  it("无记忆时按安装情况派生（claude 可用 → claude）", () => {
    expect(initialAgent({ agentsAvailable: { claude: true } })).toBe("claude");
  });
  it("记忆 agent 不可用时回退 defaultAgent", () => {
    expect(initialAgent({ lastAgent: "codex", agentsAvailable: { claude: true, codex: false } })).toBe("claude");
  });
  it("记忆 pi 恒可用", () => {
    expect(initialAgent({ lastAgent: "pi", agentsAvailable: {} })).toBe("pi");
  });
  it("记忆 agent 可用则沿用", () => {
    expect(initialAgent({ lastAgent: "codex", agentsAvailable: { claude: true, codex: true } })).toBe("codex");
  });
});

describe("initialModelDraft", () => {
  const base = { agentsAvailable: { claude: true, codex: true }, defaultModelRef: undefined };
  it("无记忆 → 该 agent 默认模型", () => {
    const d = initialModelDraft({ ...base, lastAgent: undefined, lastModel: undefined, lastProviderId: undefined });
    expect(d.agent).toBe("claude");
    expect(d.model).toBe("sonnet");
    expect(d.providerId).toBeUndefined();
  });
  it("记忆 agent+model 一致则沿用 lastModel", () => {
    const d = initialModelDraft({ ...base, lastAgent: "codex", lastModel: "gpt-5.4", lastProviderId: undefined });
    expect(d.agent).toBe("codex");
    expect(d.model).toBe("gpt-5.4");
  });
  // pi 分支：来源只有「上次用过的」与「全局 defaultModelRef」，没有任何「取第一个」兜底（§5）。
  it("pi 无任何记忆且无全局默认 → 供应商与模型都为 undefined（进阻断态，不擅自挑一个）", () => {
    const d = initialModelDraft({ ...base, lastAgent: "pi", lastModel: undefined, lastProviderId: undefined });
    expect(d.agent).toBe("pi");
    expect(d.providerId).toBeUndefined();
    expect(d.model).toBeUndefined();
  });

  it("pi 回落全局 defaultModelRef", () => {
    const d = initialModelDraft({
      ...base,
      defaultModelRef: { providerId: "openai", modelId: "gpt-5" },
      lastAgent: "pi",
      lastModel: undefined,
      lastProviderId: undefined,
    });
    expect(d).toMatchObject({ agent: "pi", providerId: "openai", model: "gpt-5" });
  });

  it("pi 换了供应商时不沿用旧 modelId（否则拼出 Catalog 里不存在的组合）", () => {
    const d = initialModelDraft({
      ...base,
      defaultModelRef: { providerId: "anthropic", modelId: "claude-sonnet-4" },
      lastAgent: "pi",
      lastModel: "gpt-5",
      lastProviderId: "openai",
    });
    // lastProviderId 优先，但 lastModel 属于同一个 provider，故沿用。
    expect(d).toMatchObject({ providerId: "openai", model: "gpt-5" });
  });

  it("记忆 agent 不可用回退后不沿用旧 model（取新 agent 默认）", () => {
    const d = initialModelDraft({
      agentsAvailable: { claude: true, codex: false },
      defaultModelRef: undefined,
      lastAgent: "codex",
      lastModel: "gpt-5.4",
      lastProviderId: undefined,
    });
    expect(d.agent).toBe("claude");
    expect(d.model).toBe("sonnet");
  });
});
