import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "./types";
import {
  migratePiChannelToProvider,
  migratePiSettings,
  normalizeProviderProfile,
  providerFromPreset,
} from "./providers";

describe("migratePiChannelToProvider", () => {
  it("maps old PiChannel shape to ProviderProfile (label→name, +endpointFormat)", () => {
    const out = migratePiChannelToProvider({
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-x",
      models: [{ id: "deepseek-chat", label: "Chat" }],
      enabled: true,
    });
    expect(out).toEqual({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-x",
      endpointFormat: "chat_completions",
      models: [{ id: "deepseek-chat", label: "Chat" }],
      enabled: true,
    });
  });

  it("defaults name to id when label missing and enabled to true", () => {
    const out = migratePiChannelToProvider({ id: "x" });
    expect(out.name).toBe("x");
    expect(out.enabled).toBe(true);
    expect(out.endpointFormat).toBe("chat_completions");
    expect(out.models).toEqual([]);
  });
});

describe("normalizeProviderProfile", () => {
  it("falls back endpointFormat to chat_completions for invalid values", () => {
    expect(normalizeProviderProfile({ id: "a", endpointFormat: "bogus" as never }).endpointFormat).toBe(
      "chat_completions",
    );
  });

  it("dedupes models by id and sorts by id", () => {
    const out = normalizeProviderProfile({
      id: "a",
      models: [
        { id: "z-model" },
        { id: "a-model", label: "A" },
        { id: "a-model", label: "dupe" },
      ],
    });
    expect(out.models).toEqual([{ id: "a-model", label: "A" }, { id: "z-model" }]);
  });

  it("treats enabled:false as disabled, anything else as enabled", () => {
    expect(normalizeProviderProfile({ id: "a", enabled: false }).enabled).toBe(false);
    expect(normalizeProviderProfile({ id: "a" }).enabled).toBe(true);
  });
});

describe("migratePiSettings", () => {
  it("maps channels→providers and defaultChannelId→defaultProviderId", () => {
    const out = migratePiSettings({
      channels: [
        { id: "a", label: "A", baseUrl: "u1", models: [], enabled: true },
        { id: "b", label: "B", baseUrl: "u2", models: [], enabled: false },
      ],
      defaultChannelId: "a",
      defaultModel: "m1",
    });
    expect(out.providers.map((p) => p.id)).toEqual(["a", "b"]);
    expect(out.providers[1]?.enabled).toBe(false);
    expect(out.defaultProviderId).toBe("a");
    expect(out.defaultModel).toBe("m1");
  });

  it("returns empty providers for missing channels", () => {
    expect(migratePiSettings({}).providers).toEqual([]);
  });
});

describe("PROVIDER_PRESETS", () => {
  it("every preset carries a valid endpointFormat and templateKey", () => {
    const valid = new Set(["chat_completions", "responses", "messages", "custom"]);
    for (const preset of PROVIDER_PRESETS) {
      expect(valid.has(preset.endpointFormat)).toBe(true);
      expect(preset.templateKey).toBeTruthy();
      expect(typeof preset.nameKey).toBe("string");
    }
  });

  it("providerFromPreset instantiates a normalized provider with the given id", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.templateKey === "deepseek")!;
    const out = providerFromPreset(preset, "deepseek-1");
    expect(out.id).toBe("deepseek-1");
    expect(out.name).toBe("DeepSeek");
    expect(out.endpointFormat).toBe("chat_completions");
    expect(out.enabled).toBe(true);
  });

  // 持久化防护:preset.nameKey 必须在实例化时被解析为具体本地化串写入 ProviderProfile.name,
  // 绝不能让翻译 key（如 "providers.preset.qwen"）落进持久态。默认语言 zh-Hans → 「通义千问」。
  it("providerFromPreset resolves nameKey to a concrete localized name, never a raw key", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.templateKey === "qwen")!;
    const out = providerFromPreset(preset, "qwen-1");
    // 不是 key 本身。
    expect(out.name).not.toBe(preset.nameKey);
    expect(out.name).not.toContain("providers.preset.");
    // 默认 zh 源串。
    expect(out.name).toBe("通义千问");
  });

  it("providerFromPreset persists a concrete name for every preset (no leaked keys)", () => {
    for (const preset of PROVIDER_PRESETS) {
      const out = providerFromPreset(preset, `${preset.templateKey}-x`);
      expect(out.name).not.toContain("providers.preset.");
      expect(out.name.trim().length).toBeGreaterThan(0);
    }
  });
});
