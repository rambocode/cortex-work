import { describe, expect, it } from "vitest";
import {
  buildDesignAgentSwitchPatch,
  defaultDesignSettings,
  normalizeDesignSettings,
} from "./app-settings";
import type { ProviderSettings } from "../../desktop/types";

// 最小 ProviderSettings 构造（只填 buildDesignAgentSwitchPatch 读到的字段）。
function providers(partial: Partial<ProviderSettings> & { providers?: ProviderSettings["providers"] }): ProviderSettings {
  return {
    providers: [],
    ...partial,
  } as ProviderSettings;
}

describe("buildDesignAgentSwitchPatch", () => {
  it("切到 pi 时配齐 provider + 默认模型", () => {
    const ps = providers({
      providers: [
        { id: "p1", name: "P1", baseUrl: "", endpointFormat: "chat_completions", models: [{ id: "x" }], enabled: true },
      ] as ProviderSettings["providers"],
      defaultProviderId: "p1",
      defaultModel: "m1",
    });
    expect(buildDesignAgentSwitchPatch("pi", ps)).toEqual({
      agent: "pi",
      derivedAgentId: "",
      providerId: "p1",
      model: "m1",
    });
  });

  it("pi 无 defaultModel 时回落默认供应商首个模型", () => {
    const ps = providers({
      providers: [
        { id: "p1", name: "P1", baseUrl: "", endpointFormat: "chat_completions", models: [{ id: "first" }, { id: "second" }], enabled: true },
      ] as ProviderSettings["providers"],
      defaultProviderId: "p1",
    });
    expect(buildDesignAgentSwitchPatch("pi", ps).model).toBe("first");
  });

  it("切到 claude/codex 时清空 provider + model（根除 pi 模型名残留）", () => {
    const ps = providers({ defaultProviderId: "p1", defaultModel: "m1" });
    expect(buildDesignAgentSwitchPatch("claude", ps)).toEqual({
      agent: "claude",
      derivedAgentId: "",
      providerId: "",
      model: "",
    });
  });

  it("派生 agent：agent 落 base、derivedAgentId 落派生 id", () => {
    const ps = providers({});
    expect(buildDesignAgentSwitchPatch("claude", ps, { id: "my-claude", base: "claude" })).toEqual({
      agent: "claude",
      derivedAgentId: "my-claude",
      providerId: "",
      model: "",
    });
  });
});

describe("normalizeDesignSettings agent/derivedAgentId", () => {
  it("缺省时 agent/derivedAgentId 归一为空串", () => {
    const s = normalizeDesignSettings(undefined);
    expect(s.agent).toBe("");
    expect(s.derivedAgentId).toBe("");
  });

  it("非法 agent 值回落空串,合法值保留", () => {
    expect(normalizeDesignSettings({ agent: "bogus" as never }).agent).toBe("");
    expect(normalizeDesignSettings({ agent: "codex" }).agent).toBe("codex");
    expect(normalizeDesignSettings({ derivedAgentId: "  my-x  " }).derivedAgentId).toBe("my-x");
  });

  it("默认值经归一化 round-trip 不变（新字段回归）", () => {
    const d = defaultDesignSettings();
    expect(normalizeDesignSettings(d)).toEqual(d);
    expect(d.agent).toBe("");
    expect(d.derivedAgentId).toBe("");
  });
});
