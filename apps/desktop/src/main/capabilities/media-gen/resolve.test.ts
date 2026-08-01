// resolve.test.ts — resolveMediaGenSettings() 单测（async 版）。
// 金库依赖（readSecrets / readStoredCredential）全部 mock，不碰磁盘与 electron safeStorage。
// 覆盖：custom+secret 引用 / secret 缺失 / 历史明文兼容 / 目录继承（protocol 权威、baseUrl 覆盖、
// model 回落、能力缺失）/ oauth 拒绝 / standalone secret / https 校验 / 按模态 timeoutMs 钳制。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveMediaGenSettings, assertHttps } from "./resolve";
import { MAX_TIMEOUT_MS_BY_MODALITY } from "../../ipc/types";
import type { MediaGenSettings } from "@cortex-work/core/desktop/types";
import { defaultMediaGenSettings } from "@cortex-work/core/desktop/types";

// ── 金库 mock（resolve.ts 经 ../../providers/credentials 读金库） ─────────────

const vault = vi.hoisted(() => ({
  readSecrets: vi.fn<() => Promise<Record<string, string>>>(),
  readStoredCredential: vi.fn<(providerId: string) => Promise<unknown>>(),
}));

vi.mock("../../providers/credentials", () => ({
  readSecrets: vault.readSecrets,
  readStoredCredential: vault.readStoredCredential,
}));

beforeEach(() => {
  vault.readSecrets.mockReset().mockResolvedValue({});
  vault.readStoredCredential.mockReset().mockResolvedValue(undefined);
});

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeMediaGenSettings(override?: Partial<MediaGenSettings>): MediaGenSettings {
  return { ...defaultMediaGenSettings(), ...override };
}

/** 一份可解析的 custom 图片设置（各用例在其上做增量覆盖）。 */
function customImageSettings(imageOverride?: Partial<MediaGenSettings["image"]>): MediaGenSettings {
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
      ...imageOverride,
    },
  });
}

/** 指向目录条目的图片设置（baseUrl/model 留空 → 走目录继承）。 */
function directoryImageSettings(
  providerId: string,
  imageOverride?: Partial<MediaGenSettings["image"]>,
): MediaGenSettings {
  return makeMediaGenSettings({
    image: {
      enabled: true,
      providerId,
      protocol: "openai-images", // 刻意写错误协议：目录路径应忽略它、以 capability 为准
      baseUrl: "",
      apiKey: "",
      model: "",
      quality: "auto",
      defaultResolution: "1K",
      defaultSize: "",
      timeoutMs: 180_000,
      ...imageOverride,
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

// ── custom 路径：密钥解析 ─────────────────────────────────────────────────────

describe("resolveMediaGenSettings - custom 密钥解析", () => {
  it("apiKey 为 ${secret:NAME} 引用时从金库解密", async () => {
    vault.readSecrets.mockResolvedValue({ "media.image.custom": "sk-from-vault" });
    const mediaGen = customImageSettings({ apiKey: "${secret:media.image.custom}" });
    const result = await resolveMediaGenSettings("image", mediaGen);
    expect(result.apiKey).toBe("sk-from-vault");
  });

  it("secret 引用缺失时报错并点名缺失引用，且不夹带金库里其它值", async () => {
    vault.readSecrets.mockResolvedValue({ other: "sk-other-secret" });
    const mediaGen = customImageSettings({ apiKey: "${secret:media.image.custom}" });
    await expect(resolveMediaGenSettings("image", mediaGen)).rejects.toThrowError(
      /media\.image\.custom.*未在金库中定义/,
    );
    await expect(resolveMediaGenSettings("image", mediaGen)).rejects.not.toThrowError(/sk-other-secret/);
  });

  it("历史明文 apiKey 直接使用（迁移窗口期兼容），不触碰金库", async () => {
    const mediaGen = customImageSettings({ apiKey: "sk-legacy-plaintext" });
    const result = await resolveMediaGenSettings("image", mediaGen);
    expect(result.apiKey).toBe("sk-legacy-plaintext");
    expect(vault.readSecrets).not.toHaveBeenCalled();
  });

  it("providerId='' 等价 custom：使用自填字段", async () => {
    const mediaGen = customImageSettings({ providerId: "" });
    const result = await resolveMediaGenSettings("image", mediaGen);
    expect(result.baseUrl).toBe("https://api.example.com");
    expect(result.protocol).toBe("openai-images");
    expect(result.model).toBe("dall-e-3");
  });

  it("金库读取失败时报「读取密钥金库失败」且经 safeErrorMessage 清洗", async () => {
    vault.readSecrets.mockRejectedValue(new Error("boom token=sk-raw-leak"));
    const mediaGen = customImageSettings({ apiKey: "${secret:media.image.custom}" });
    const err = await resolveMediaGenSettings("image", mediaGen).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/读取密钥金库失败/);
    // safeErrorMessage 会把 token=... 之类的 kv 掐掉，不允许原样透传。
    expect((err as Error).message).not.toContain("sk-raw-leak");
  });
});

// ── 目录路径：能力继承 ────────────────────────────────────────────────────────

describe("resolveMediaGenSettings - 目录继承", () => {
  it("catalog 条目（minimax）：protocol 以目录为准、baseUrl/model 回落目录值", async () => {
    vault.readStoredCredential.mockResolvedValue({ type: "api_key", key: "mx-key" });
    const result = await resolveMediaGenSettings("image", directoryImageSettings("minimax"));
    // settings.protocol 写的是 openai-images，但目录 capability 是权威。
    expect(result.protocol).toBe("minimax-image");
    expect(result.baseUrl).toBe("https://api.minimaxi.com");
    expect(result.model).toBe("image-01"); // models[0] 回落
    expect(result.apiKey).toBe("mx-key");
    expect(vault.readStoredCredential).toHaveBeenCalledWith("minimax");
  });

  it("自填 baseUrl 非空时覆盖目录端点", async () => {
    vault.readStoredCredential.mockResolvedValue({ type: "api_key", key: "mx-key" });
    const result = await resolveMediaGenSettings(
      "image",
      directoryImageSettings("minimax", { baseUrl: "  https://proxy.example.com  " }),
    );
    expect(result.baseUrl).toBe("https://proxy.example.com");
  });

  it("自填 model 非空时优先于目录 models[0]", async () => {
    vault.readStoredCredential.mockResolvedValue({ type: "api_key", key: "mx-key" });
    const result = await resolveMediaGenSettings(
      "image",
      directoryImageSettings("minimax", { model: "image-01-live" }),
    );
    expect(result.model).toBe("image-01-live");
  });

  it("speech 模态映射 textToSpeech 能力（minimax 走国际域）", async () => {
    vault.readStoredCredential.mockResolvedValue({ type: "api_key", key: "mx-key" });
    const mediaGen = makeMediaGenSettings({
      speech: { ...defaultMediaGenSettings().speech, enabled: true, providerId: "minimax" },
    });
    const result = await resolveMediaGenSettings("speech", mediaGen);
    expect(result.protocol).toBe("minimax-t2a");
    expect(result.baseUrl).toBe("https://api.minimax.io");
    expect(result.model).toBe("speech-2.8-hd");
  });

  it("条目无该模态能力时报「不支持」（xiaomi 无图片能力）", async () => {
    await expect(resolveMediaGenSettings("image", directoryImageSettings("xiaomi"))).rejects.toThrowError(
      /不支持图片生成/,
    );
  });

  it("providerId 不在目录时报「找不到媒体供应商」", async () => {
    await expect(
      resolveMediaGenSettings("image", directoryImageSettings("nonexistent-provider")),
    ).rejects.toThrowError(/找不到媒体供应商.*nonexistent-provider/);
  });
});

// ── 目录路径：密钥来源 ────────────────────────────────────────────────────────

describe("resolveMediaGenSettings - 目录密钥", () => {
  it("catalog 条目无 credential 时引导到「设置 → Provider」", async () => {
    vault.readStoredCredential.mockResolvedValue(undefined);
    await expect(resolveMediaGenSettings("image", directoryImageSettings("minimax"))).rejects.toThrowError(
      /未配置密钥.*Provider/,
    );
  });

  it("catalog 条目为 oauth credential 时拒绝并引导改用 API Key", async () => {
    vault.readStoredCredential.mockResolvedValue({
      type: "oauth",
      access: "oauth-access-token-secret",
      refresh: "r",
      expires: 0,
    });
    const err = await resolveMediaGenSettings("image", directoryImageSettings("xai")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/OAuth 登录.*暂只支持 API Key/);
    // 错误文案不得夹带任何 token material。
    expect((err as Error).message).not.toContain("oauth-access-token-secret");
  });

  it("standalone 条目（volcengine）从金库命名 Secret 取 key", async () => {
    vault.readSecrets.mockResolvedValue({ "media.provider.volcengine": "vk-key" });
    const result = await resolveMediaGenSettings("image", directoryImageSettings("volcengine"));
    expect(result.apiKey).toBe("vk-key");
    expect(result.protocol).toBe("volcengine-ark-image");
    expect(result.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(result.model).toBe("doubao-seedream-5-0-pro-260628");
    // standalone 不读 credential 区。
    expect(vault.readStoredCredential).not.toHaveBeenCalled();
  });

  it("standalone Secret 缺失时引导到「设置 → 媒体生成」", async () => {
    vault.readSecrets.mockResolvedValue({});
    await expect(
      resolveMediaGenSettings("image", directoryImageSettings("volcengine")),
    ).rejects.toThrowError(/未配置密钥.*媒体生成/);
  });
});

// ── 字段校验（https + 非空三项） ───────────────────────────────────────────────

describe("resolveMediaGenSettings - 字段校验", () => {
  it("custom：baseUrl 为空时报错", async () => {
    await expect(
      resolveMediaGenSettings("image", customImageSettings({ baseUrl: "" })),
    ).rejects.toThrowError(/baseUrl/);
  });

  it("custom：baseUrl 为 http:// 时被拒（非 https）", async () => {
    await expect(
      resolveMediaGenSettings("image", customImageSettings({ baseUrl: "http://api.example.com" })),
    ).rejects.toThrowError(/https/);
  });

  it("目录路径：自填 baseUrl 覆盖值同样过 https 校验", async () => {
    vault.readStoredCredential.mockResolvedValue({ type: "api_key", key: "mx-key" });
    await expect(
      resolveMediaGenSettings("image", directoryImageSettings("minimax", { baseUrl: "http://evil.example.com" })),
    ).rejects.toThrowError(/https/);
  });

  it("custom：apiKey 为空时报 unavailable 错误", async () => {
    await expect(
      resolveMediaGenSettings("image", customImageSettings({ apiKey: "" })),
    ).rejects.toThrowError(/apiKey|unavailable/i);
  });

  it("custom：model 为空时报 unavailable 错误", async () => {
    await expect(
      resolveMediaGenSettings("image", customImageSettings({ model: "" })),
    ).rejects.toThrowError(/model|unavailable/i);
  });
});

// ── timeoutMs 按模态钳制（MAX_TIMEOUT_MS_BY_MODALITY 表） ─────────────────────

describe("resolveMediaGenSettings - timeoutMs 按模态钳制", () => {
  it("image: 超上限（290s）被夹紧", async () => {
    const result = await resolveMediaGenSettings("image", customImageSettings({ timeoutMs: 500_000 }));
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS_BY_MODALITY.image);
  });

  it("speech: 超上限（290s）被夹紧", async () => {
    const mediaGen = makeMediaGenSettings({
      speech: {
        ...defaultMediaGenSettings().speech,
        enabled: true,
        providerId: "custom",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-key",
        model: "tts-1",
        timeoutMs: 999_000,
      },
    });
    const result = await resolveMediaGenSettings("speech", mediaGen);
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS_BY_MODALITY.speech);
  });

  it("music: 上限为 600s（宽于 image）", async () => {
    const mediaGen = makeMediaGenSettings({
      music: {
        ...defaultMediaGenSettings().music,
        enabled: true,
        providerId: "custom",
        baseUrl: "https://api.minimax.io",
        apiKey: "key",
        model: "music-2.6",
        timeoutMs: 700_000,
      },
    });
    const result = await resolveMediaGenSettings("music", mediaGen);
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS_BY_MODALITY.music);
    expect(result.timeoutMs).toBe(600_000);
  });

  it("video: 上限为 1500s（宽于 music）", async () => {
    const mediaGen = makeMediaGenSettings({
      video: {
        ...defaultMediaGenSettings().video,
        enabled: true,
        providerId: "custom",
        baseUrl: "https://api.minimax.io",
        apiKey: "key",
        model: "MiniMax-Hailuo-2.3",
        timeoutMs: 2_000_000,
      },
    });
    const result = await resolveMediaGenSettings("video", mediaGen);
    expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS_BY_MODALITY.video);
    expect(result.timeoutMs).toBe(1_500_000);
  });

  it("未超上限时保持原值", async () => {
    const result = await resolveMediaGenSettings("image", customImageSettings({ timeoutMs: 180_000 }));
    expect(result.timeoutMs).toBe(180_000);
  });
});

// ── 模态特有字段透传 ──────────────────────────────────────────────────────────

describe("resolveMediaGenSettings - 特有字段透传", () => {
  it("image 透传 quality/defaultResolution/defaultSize", async () => {
    const result = await resolveMediaGenSettings(
      "image",
      customImageSettings({ quality: "high", defaultResolution: "2K", defaultSize: "512x512" }),
    );
    expect(result.quality).toBe("high");
    expect(result.defaultResolution).toBe("2K");
    expect(result.defaultSize).toBe("512x512");
  });

  it("speech 透传 voice/format", async () => {
    const mediaGen = makeMediaGenSettings({
      speech: {
        ...defaultMediaGenSettings().speech,
        enabled: true,
        providerId: "custom",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-key",
        model: "tts-1",
        voice: "alloy",
        format: "wav",
      },
    });
    const result = await resolveMediaGenSettings("speech", mediaGen);
    expect(result.voice).toBe("alloy");
    expect(result.format).toBe("wav");
  });

  it("video 透传 defaultDuration/defaultResolution/pollIntervalMs", async () => {
    const mediaGen = makeMediaGenSettings({
      video: {
        ...defaultMediaGenSettings().video,
        enabled: true,
        providerId: "custom",
        baseUrl: "https://api.minimax.io",
        apiKey: "key",
        model: "MiniMax-Hailuo-2.3",
        defaultDuration: 10,
        defaultResolution: "768P",
        pollIntervalMs: 5_000,
      },
    });
    const result = await resolveMediaGenSettings("video", mediaGen);
    expect(result.defaultDuration).toBe(10);
    expect(result.defaultResolution).toBe("768P");
    expect(result.pollIntervalMs).toBe(5_000);
  });
});
