// media-gen-types.test.ts — normalizeMediaGenSettings 旧档归一化单测。
// 覆盖：缺档回落默认、缺字段 deep-merge、枚举兜底、providerId 合法化、
// 数值按 MAX_TIMEOUT_MS_BY_MODALITY 钳制、defaultSize 正则校验。

import { describe, expect, it } from "vitest";
import {
  MAX_TIMEOUT_MS_BY_MODALITY,
  MIN_TIMEOUT_MS,
  defaultAsrSettings,
  defaultMediaGenSettings,
  isLocalStreamingAsrProtocol,
  normalizeAsrSettings,
  normalizeMediaGenSettings,
} from "./media-gen-types";

describe("normalizeMediaGenSettings", () => {
  it("undefined / null / 非对象 → 完整工厂默认", () => {
    expect(normalizeMediaGenSettings(undefined)).toEqual(defaultMediaGenSettings());
    expect(normalizeMediaGenSettings(null)).toEqual(defaultMediaGenSettings());
    expect(normalizeMediaGenSettings("garbage")).toEqual(defaultMediaGenSettings());
  });

  it("旧档缺新字段（quality/defaultResolution）→ deep-merge 补默认，已有字段保留", () => {
    // 模拟 quality 时代之前的旧档：image 子对象没有 quality/defaultResolution。
    const legacy = {
      image: {
        enabled: true,
        providerId: "custom",
        protocol: "openai-images",
        baseUrl: "https://api.openai.com",
        apiKey: "${secret:media.image.custom}",
        model: "gpt-image-1",
        defaultSize: "1024x1024",
        timeoutMs: 120_000,
      },
    };
    const result = normalizeMediaGenSettings(legacy);
    expect(result.image.quality).toBe("auto");
    expect(result.image.defaultResolution).toBe("1K");
    expect(result.image.enabled).toBe(true);
    expect(result.image.baseUrl).toBe("https://api.openai.com");
    expect(result.image.model).toBe("gpt-image-1");
    expect(result.image.defaultSize).toBe("1024x1024");
    // 其余模态整体回落默认。
    expect(result.speech).toEqual(defaultMediaGenSettings().speech);
  });

  it("非法枚举（protocol/quality/defaultResolution）→ 回落默认", () => {
    const result = normalizeMediaGenSettings({
      image: { protocol: "not-a-protocol", quality: "ultra", defaultResolution: "8K" },
      video: { protocol: "codex-responses-image" },
    });
    expect(result.image.protocol).toBe("openai-images");
    expect(result.image.quality).toBe("auto");
    expect(result.image.defaultResolution).toBe("1K");
    expect(result.video.protocol).toBe("minimax-video");
  });

  it("新协议枚举值合法保留（grok/volcengine）", () => {
    const result = normalizeMediaGenSettings({
      image: { protocol: "grok-imagine-image" },
      video: { protocol: "volcengine-ark-video" },
    });
    expect(result.image.protocol).toBe("grok-imagine-image");
    expect(result.video.protocol).toBe("volcengine-ark-video");
  });

  it("providerId 不在目录且非空非 custom → 改写 custom，且保留自填字段", () => {
    const result = normalizeMediaGenSettings({
      image: {
        providerId: "legacy-profile-123",
        baseUrl: "https://my.example.com",
        apiKey: "${secret:media.image.custom}",
        model: "my-model",
      },
    });
    expect(result.image.providerId).toBe("custom");
    // 自填字段不清空（切回自定义仍可用）。
    expect(result.image.baseUrl).toBe("https://my.example.com");
    expect(result.image.apiKey).toBe("${secret:media.image.custom}");
    expect(result.image.model).toBe("my-model");
  });

  it("providerId 命中目录 / 为空 / 为 custom → 原样保留", () => {
    expect(normalizeMediaGenSettings({ image: { providerId: "minimax" } }).image.providerId).toBe("minimax");
    expect(normalizeMediaGenSettings({ video: { providerId: "volcengine" } }).video.providerId).toBe("volcengine");
    expect(normalizeMediaGenSettings({ image: { providerId: "" } }).image.providerId).toBe("");
    expect(normalizeMediaGenSettings({ image: { providerId: "custom" } }).image.providerId).toBe("custom");
  });

  it("timeoutMs 按模态钳制（表上限），下限 MIN_TIMEOUT_MS", () => {
    const result = normalizeMediaGenSettings({
      image: { timeoutMs: 9_999_999 },
      speech: { timeoutMs: 1 },
      music: { timeoutMs: 9_999_999 },
      video: { timeoutMs: 9_999_999 },
    });
    expect(result.image.timeoutMs).toBe(MAX_TIMEOUT_MS_BY_MODALITY.image);
    expect(result.speech.timeoutMs).toBe(MIN_TIMEOUT_MS);
    expect(result.music.timeoutMs).toBe(MAX_TIMEOUT_MS_BY_MODALITY.music);
    expect(result.video.timeoutMs).toBe(MAX_TIMEOUT_MS_BY_MODALITY.video);
  });

  it("timeoutMs 非数值（NaN/字符串）→ 回落默认再钳制", () => {
    const result = normalizeMediaGenSettings({
      image: { timeoutMs: Number.NaN },
      video: { timeoutMs: "fast" },
    });
    expect(result.image.timeoutMs).toBe(defaultMediaGenSettings().image.timeoutMs);
    expect(result.video.timeoutMs).toBe(defaultMediaGenSettings().video.timeoutMs);
  });

  it("video defaultDuration 钳 [1,30]、pollIntervalMs 钳 [1000,120000]", () => {
    const result = normalizeMediaGenSettings({
      video: { defaultDuration: 999, pollIntervalMs: 10 },
    });
    expect(result.video.defaultDuration).toBe(30);
    expect(result.video.pollIntervalMs).toBe(1_000);
  });

  it("defaultSize 不匹配 WxH 正则且非空 → 置空；合法值与空串保留", () => {
    expect(normalizeMediaGenSettings({ image: { defaultSize: "banana" } }).image.defaultSize).toBe("");
    expect(normalizeMediaGenSettings({ image: { defaultSize: "1x1" } }).image.defaultSize).toBe("");
    expect(normalizeMediaGenSettings({ image: { defaultSize: "1024x1024" } }).image.defaultSize).toBe("1024x1024");
    expect(normalizeMediaGenSettings({ image: { defaultSize: "" } }).image.defaultSize).toBe("");
  });

  it("isKnownProvider 注入点可覆盖目录判定（供测试/扩展）", () => {
    const result = normalizeMediaGenSettings(
      { image: { providerId: "my-private-provider" } },
      { isKnownProvider: (id) => id === "my-private-provider" },
    );
    expect(result.image.providerId).toBe("my-private-provider");
  });

  it("默认工厂本身过 normalize 后不变（幂等基线）", () => {
    const defaults = defaultMediaGenSettings();
    expect(normalizeMediaGenSettings(defaults)).toEqual(defaults);
  });
});

describe("normalizeAsrSettings", () => {
  it("新安装默认选中但不启用本地 SenseVoiceSmall", () => {
    expect(defaultAsrSettings()).toMatchObject({
      enabled: false,
      protocol: "local-sensevoice",
      model: "sensevoice-small-q8",
      localModelDownloadSource: "huggingface",
    });
  });

  it("旧 local-whisper 配置不迁移，回落到禁用的 SenseVoiceSmall 默认值", () => {
    expect(normalizeAsrSettings({
      enabled: true,
      protocol: "local-whisper",
      model: "whisper-small-q5_1",
      localWhisperDownloadSource: "hf-sufy",
    })).toEqual(defaultAsrSettings());
  });

  it("合法在线配置保留，缺失字段由默认值补齐", () => {
    expect(normalizeAsrSettings({
      enabled: true,
      providerId: "custom",
      protocol: "openai-transcriptions",
      baseUrl: "https://asr.example.com",
      apiKey: "${secret:asr.custom}",
      model: "whisper-1",
      language: "en",
      timeoutMs: 90_000,
    })).toMatchObject({
      enabled: true,
      protocol: "openai-transcriptions",
      baseUrl: "https://asr.example.com",
      model: "whisper-1",
      language: "en",
      timeoutMs: 90_000,
      localModelDownloadSource: "huggingface",
    });
  });

  it("保留流式 Zipformer 协议与其模型 id", () => {
    expect(normalizeAsrSettings({
      enabled: true,
      protocol: "local-zipformer-stream",
      model: "zipformer-bilingual-zh-en-int8",
    })).toMatchObject({
      enabled: true,
      protocol: "local-zipformer-stream",
      model: "zipformer-bilingual-zh-en-int8",
    });
  });

  it("流式协议配着 SenseVoice 的 model 时纠正回流式默认模型", () => {
    // 协议与 model 取值域不同，半写入的旧档若不纠正，主进程只会抛「无效模型」且无法自愈。
    expect(normalizeAsrSettings({
      enabled: true,
      protocol: "local-zipformer-stream",
      model: "sensevoice-small-q8",
    })).toMatchObject({
      protocol: "local-zipformer-stream",
      model: "zipformer-bilingual-zh-en-int8",
    });
  });

  it("非流式协议不受模型纠正逻辑影响", () => {
    expect(normalizeAsrSettings({
      protocol: "openai-transcriptions",
      model: "whisper-1",
    })).toMatchObject({ protocol: "openai-transcriptions", model: "whisper-1" });
  });
});

describe("isLocalStreamingAsrProtocol", () => {
  it("两个本地协议都走实时 PCM 通道", () => {
    expect(isLocalStreamingAsrProtocol("local-sensevoice")).toBe(true);
    expect(isLocalStreamingAsrProtocol("local-zipformer-stream")).toBe(true);
  });

  it("在线协议不走实时 PCM 通道", () => {
    expect(isLocalStreamingAsrProtocol("openai-transcriptions")).toBe(false);
    expect(isLocalStreamingAsrProtocol("mimo-asr")).toBe(false);
  });
});
