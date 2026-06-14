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
      expect(typeof preset.name).toBe("string");
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
});
