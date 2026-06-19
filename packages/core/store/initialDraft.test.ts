import { describe, it, expect } from "vitest";
import { initialAgent, initialModelDraft, resolveDefaultAgent } from "./personal";
import { DEFAULT_GENERAL_SETTINGS, DEFAULT_PROVIDER_SETTINGS, type GeneralSettings } from "../desktop/types";

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
  const base = { agentsAvailable: { claude: true, codex: true }, providerSettings: DEFAULT_PROVIDER_SETTINGS };
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
  it("记忆 agent 不可用回退后不沿用旧 model（取新 agent 默认）", () => {
    const d = initialModelDraft({
      agentsAvailable: { claude: true, codex: false },
      providerSettings: DEFAULT_PROVIDER_SETTINGS,
      lastAgent: "codex",
      lastModel: "gpt-5.4",
      lastProviderId: undefined,
    });
    expect(d.agent).toBe("claude");
    expect(d.model).toBe("sonnet");
  });
});
