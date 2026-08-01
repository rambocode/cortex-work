// resolve.test.ts — resolveMediaGenSettings() 单测
// 不涉及网络，全纯函数测试。

import { describe, it, expect } from "vitest";
import {
  resolveMediaGenSettings,
  assertHttps,
  MAX_TIMEOUT_MS,
} from "./resolve";
import type { MediaGenSettings, ProviderSettings } from "@cortex-work/core/desktop/types";
import {
  defaultMediaGenSettings,
} from "@cortex-work/core/desktop/types";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeProviderSettings(override?: Partial<ProviderSettings>): ProviderSettings {
  return {
    providers: [],
    ...override,
  };
}

function makeMediaGenSettings(override?: Partial<MediaGenSettings>): MediaGenSettings {
  const defaults = defaultMediaGenSettings();
  return { ...defaults, ...override };
}

// 创建一个有效的图片设置（custom 模式）
function customImageSettings() {
  return makeMediaGenSettings({
    image: {
      enabled: true,
      providerId: "custom",
      protocol: "openai-images",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test-key",
      model: "dall-e-3",
      quality: "auto",
      defaultResolution: "1K",
      defaultSize: "1024x1024",
      timeoutMs: 180_000,
    },
  });
}

// ── assertHttps ────────────────────────────────────────────────────────────────

describe("assertHttps", () => {
  it("https:// 通过校验", () => {
    expect(() => assertHttps("https://api.example.com")).not.toThrow();
  });

  it("http:// 被拒绝", () => {
    expect(() => assertHttps("http://api.example.com")).toThrowError(/https/);
  });

  it("空字符串被拒绝", () => {
    expect(() => assertHttps("")).toThrowError(/https/);
  });

  it("非 URL 字符串被拒绝", () => {
    expect(() => assertHttps("api.example.com")).toThrowError(/https/);
  });
});

// ── providerId = '' 或 'custom' → 使用自填字段 ────────────────────────────────

describe("resolveMediaGenSettings - 自定义模式", () => {
  it("providerId='' 时直接使用自填字段", () => {
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "",
        protocol: "openai-images",
        baseUrl: "https://api.example.com",
        apiKey: "sk-key",
        model: "dall-e-3",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "512x512",
        timeoutMs: 180_000,
      },
    });
    const result = resolveMediaGenSettings("image", mediaGen, makeProviderSettings());
    expect(result.baseUrl).toBe("https://api.example.com");
    expect(result.apiKey).toBe("sk-key");
    expect(result.model).toBe("dall-e-3");
    expect(result.protocol).toBe("openai-images");
  });

  it("providerId='custom' 时直接使用自填字段", () => {
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "custom",
        protocol: "openai-images",
        baseUrl: "https://custom.api.com/v1",
        apiKey: "custom-key",
        model: "image-gen-model",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "1024x1024",
        timeoutMs: 180_000,
      },
    });
    const result = resolveMediaGenSettings("image", mediaGen, makeProviderSettings());
    expect(result.apiKey).toBe("custom-key");
    expect(result.baseUrl).toBe("https://custom.api.com/v1");
  });

  it("speech 模态自定义模式可以解析", () => {
    const mediaGen = makeMediaGenSettings({
      speech: {
        enabled: true,
        providerId: "",
        protocol: "openai-speech",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-speech-key",
        model: "tts-1",
        voice: "alloy",
        format: "mp3",
        timeoutMs: 120_000,
      },
    });
    const result = resolveMediaGenSettings("speech", mediaGen, makeProviderSettings());
    expect(result.voice).toBe("alloy");
    expect(result.format).toBe("mp3");
  });

  it("music 模态自定义模式可以解析", () => {
    const mediaGen = makeMediaGenSettings({
      music: {
        enabled: true,
        providerId: "",
        protocol: "minimax-music",
        baseUrl: "https://api.minimax.chat",
        apiKey: "minimax-key",
        model: "music-01",
        format: "mp3",
        timeoutMs: 280_000,
      },
    });
    const result = resolveMediaGenSettings("music", mediaGen, makeProviderSettings());
    expect(result.model).toBe("music-01");
    expect(result.protocol).toBe("minimax-music");
  });

  it("video 模态自定义模式可以解析", () => {
    const mediaGen = makeMediaGenSettings({
      video: {
        enabled: true,
        providerId: "",
        protocol: "minimax-video",
        baseUrl: "https://api.minimax.chat",
        apiKey: "minimax-key",
        model: "video-01",
        defaultDuration: 6,
        defaultResolution: "1080P",
        timeoutMs: 280_000,
        pollIntervalMs: 5_000,
      },
    });
    const result = resolveMediaGenSettings("video", mediaGen, makeProviderSettings());
    expect(result.defaultDuration).toBe(6);
    expect(result.defaultResolution).toBe("1080P");
    expect(result.pollIntervalMs).toBe(5_000);
  });
});

// ── 有效 provider → 继承 apiKey/baseUrl ────────────────────────────────────────

describe("resolveMediaGenSettings - 供应商继承", () => {
  it("指向有效供应商时继承 apiKey 和 baseUrl", () => {
    const providerSettings = makeProviderSettings({
      providers: [
        {
          id: "minimax",
          name: "MiniMax",
          baseUrl: "https://api.minimax.chat",
          apiKey: "provider-key",
          endpointFormat: "chat_completions",
          models: [],
          enabled: true,
        },
      ],
    });
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "minimax",
        protocol: "minimax-image",
        baseUrl: "", // 继承供应商的
        apiKey: "", // 继承供应商的
        model: "image-01",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "",
        timeoutMs: 180_000,
      },
    });
    const result = resolveMediaGenSettings("image", mediaGen, providerSettings);
    expect(result.apiKey).toBe("provider-key");
    expect(result.baseUrl).toBe("https://api.minimax.chat");
    expect(result.model).toBe("image-01");
  });

  it("指向供应商时，模态设置的 protocol 和 model 保持优先", () => {
    const providerSettings = makeProviderSettings({
      providers: [
        {
          id: "my-provider",
          name: "My Provider",
          baseUrl: "https://api.my-provider.com",
          apiKey: "provider-api-key",
          endpointFormat: "chat_completions",
          models: [],
          enabled: true,
        },
      ],
    });
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "my-provider",
        protocol: "openai-images",
        baseUrl: "",
        apiKey: "",
        model: "dall-e-3",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "1024x1024",
        timeoutMs: 180_000,
      },
    });
    const result = resolveMediaGenSettings("image", mediaGen, providerSettings);
    expect(result.protocol).toBe("openai-images");
    expect(result.model).toBe("dall-e-3");
  });
});

// ── 找不到 provider → 抛出诊断错误 ──────────────────────────────────────────

describe("resolveMediaGenSettings - 供应商查找失败", () => {
  it("指向不存在的 provider 时抛出含诊断信息的 Error", () => {
    const providerSettings = makeProviderSettings({ providers: [] });
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "nonexistent-provider",
        protocol: "openai-images",
        baseUrl: "",
        apiKey: "",
        model: "dall-e-3",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "",
        timeoutMs: 180_000,
      },
    });
    expect(() => resolveMediaGenSettings("image", mediaGen, providerSettings)).toThrowError(
      /nonexistent-provider/,
    );
  });

  it("错误信息包含已配置的供应商列表", () => {
    const providerSettings = makeProviderSettings({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-key",
          endpointFormat: "chat_completions",
          models: [],
          enabled: true,
        },
      ],
    });
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "missing-provider",
        protocol: "openai-images",
        baseUrl: "",
        apiKey: "",
        model: "dall-e-3",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "",
        timeoutMs: 180_000,
      },
    });
    let errorMsg = "";
    try {
      resolveMediaGenSettings("image", mediaGen, providerSettings);
    } catch (e) {
      errorMsg = (e as Error).message;
    }
    // 错误信息中应包含已配置的 openai 供应商（便于诊断）
    expect(errorMsg).toContain("openai");
  });
});

// ── 缺 apiKey/model → 报 unavailable 错误 ────────────────────────────────────

describe("resolveMediaGenSettings - 字段校验", () => {
  it("baseUrl 为空时报错", () => {
    const mediaGen = customImageSettings();
    mediaGen.image.baseUrl = "";
    expect(() =>
      resolveMediaGenSettings("image", mediaGen, makeProviderSettings()),
    ).toThrowError(/baseUrl/);
  });

  it("apiKey 为空时报 unavailable 错误", () => {
    const mediaGen = customImageSettings();
    mediaGen.image.apiKey = "";
    expect(() =>
      resolveMediaGenSettings("image", mediaGen, makeProviderSettings()),
    ).toThrowError(/apiKey|unavailable/i);
  });

  it("model 为空时报 unavailable 错误", () => {
    const mediaGen = customImageSettings();
    mediaGen.image.model = "";
    expect(() =>
      resolveMediaGenSettings("image", mediaGen, makeProviderSettings()),
    ).toThrowError(/model|unavailable/i);
  });

  it("baseUrl 为 http:// 时被拒（非 https）", () => {
    const mediaGen = customImageSettings();
    mediaGen.image.baseUrl = "http://api.example.com";
    expect(() =>
      resolveMediaGenSettings("image", mediaGen, makeProviderSettings()),
    ).toThrowError(/https/);
  });
});

// ── timeoutMs 夹紧（OQ1/KTD8，防止超过看门狗 300s） ──────────────────────────

describe("resolveMediaGenSettings - timeoutMs 夹紧", () => {
  it("image: timeoutMs 超过 MAX_TIMEOUT_MS 时被夹紧", () => {
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "custom",
        protocol: "openai-images",
        baseUrl: "https://api.example.com",
        apiKey: "sk-key",
        model: "dall-e-3",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "1024x1024",
        timeoutMs: 500_000, // 超过 290s
      },
    });
    const result = resolveMediaGenSettings("image", mediaGen, makeProviderSettings());
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("speech: timeoutMs 超过 MAX_TIMEOUT_MS 时被夹紧", () => {
    const mediaGen = makeMediaGenSettings({
      speech: {
        enabled: true,
        providerId: "custom",
        protocol: "openai-speech",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-key",
        model: "tts-1",
        voice: "alloy",
        format: "mp3",
        timeoutMs: 999_000,
      },
    });
    const result = resolveMediaGenSettings("speech", mediaGen, makeProviderSettings());
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("music: timeoutMs 超过 MAX_TIMEOUT_MS 时被夹紧", () => {
    const mediaGen = makeMediaGenSettings({
      music: {
        enabled: true,
        providerId: "custom",
        protocol: "minimax-music",
        baseUrl: "https://api.minimax.chat",
        apiKey: "key",
        model: "music-01",
        format: "mp3",
        timeoutMs: 400_000,
      },
    });
    const result = resolveMediaGenSettings("music", mediaGen, makeProviderSettings());
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("video: timeoutMs 超过 MAX_TIMEOUT_MS 时被夹紧", () => {
    const mediaGen = makeMediaGenSettings({
      video: {
        enabled: true,
        providerId: "custom",
        protocol: "minimax-video",
        baseUrl: "https://api.minimax.chat",
        apiKey: "key",
        model: "video-01",
        defaultDuration: 6,
        defaultResolution: "1080P",
        timeoutMs: 600_000,
        pollIntervalMs: 5_000,
      },
    });
    const result = resolveMediaGenSettings("video", mediaGen, makeProviderSettings());
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("timeoutMs 未超过 MAX_TIMEOUT_MS 时保持原值", () => {
    const mediaGen = makeMediaGenSettings({
      image: {
        enabled: true,
        providerId: "custom",
        protocol: "openai-images",
        baseUrl: "https://api.example.com",
        apiKey: "sk-key",
        model: "dall-e-3",
        quality: "auto",
        defaultResolution: "1K",
        defaultSize: "1024x1024",
        timeoutMs: 180_000, // 180s < 290s，保持原值
      },
    });
    const result = resolveMediaGenSettings("image", mediaGen, makeProviderSettings());
    expect(result.timeoutMs).toBe(180_000);
  });
});
