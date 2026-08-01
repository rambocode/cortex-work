// media-provider-directory.test.ts — 媒体供应商目录数据完整性 + 查询函数单测。
// 重点守卫：catalog 型 id 必须存在于 pi Provider Catalog（防 pi 升级 id 漂移）、
// baseUrl 全 https、secretName 符合金库命名约束、minimax 图片国内域不被"统一"。

import { describe, expect, it } from "vitest";
import {
  MEDIA_PROVIDER_DIRECTORY,
  findMediaProvider,
  mediaCapabilityOf,
  mediaCustomSecretName,
  mediaProvidersForModality,
  type MediaModality,
} from "./media-provider-directory";
import { PI_PROVIDER_CATALOG_IDS } from "./__fixtures__/pi-provider-catalog-ids";

// 与主进程 providers/secrets.ts 的 SECRET_NAME_RE 一致（跨包契约，勿单侧修改）。
const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const ALL_MODALITIES: readonly MediaModality[] = ["image", "speech", "music", "video"];

describe("MEDIA_PROVIDER_DIRECTORY — 数据完整性", () => {
  it("id 唯一", () => {
    const ids = MEDIA_PROVIDER_DIRECTORY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("catalog 型条目 id 必须存在于 pi Provider Catalog fixture（防 pi 升级 id 漂移）", () => {
    for (const entry of MEDIA_PROVIDER_DIRECTORY) {
      if (entry.kind === "catalog") {
        expect(PI_PROVIDER_CATALOG_IDS, `catalog 条目 "${entry.id}" 不在 pi catalog 中`).toContain(entry.id);
      }
    }
  });

  it("standalone 型条目必须带合法 secretName；catalog 型不带", () => {
    for (const entry of MEDIA_PROVIDER_DIRECTORY) {
      if (entry.kind === "standalone") {
        expect(entry.secretName, `standalone 条目 "${entry.id}" 缺 secretName`).toBeTruthy();
        expect(entry.secretName).toMatch(SECRET_NAME_RE);
      } else {
        expect(entry.secretName).toBeUndefined();
      }
    }
  });

  it("每个条目至少配置一项媒体能力", () => {
    for (const entry of MEDIA_PROVIDER_DIRECTORY) {
      const capCount = ALL_MODALITIES.filter((m) => mediaCapabilityOf(entry, m)).length;
      expect(capCount, `条目 "${entry.id}" 无任何媒体能力`).toBeGreaterThan(0);
    }
  });

  it("全部 capability.baseUrl 为 https 且模型列表非空", () => {
    for (const entry of MEDIA_PROVIDER_DIRECTORY) {
      for (const modality of ALL_MODALITIES) {
        const cap = mediaCapabilityOf(entry, modality);
        if (!cap) continue;
        expect(cap.baseUrl, `${entry.id}.${modality} baseUrl 非 https`).toMatch(/^https:\/\//);
        expect(cap.models.length, `${entry.id}.${modality} 模型列表为空`).toBeGreaterThan(0);
        expect(cap.protocol).toBeTruthy();
      }
    }
  });

  it("minimax 图片走国内域 minimaxi.com、其余走国际域 minimax.io（同 key 跨域，勿统一）", () => {
    for (const id of ["minimax", "minimax-cn"]) {
      const entry = findMediaProvider(id)!;
      expect(entry.image!.baseUrl).toBe("https://api.minimaxi.com");
      expect(entry.textToSpeech!.baseUrl).toBe("https://api.minimax.io");
      expect(entry.music!.baseUrl).toBe("https://api.minimax.io");
      expect(entry.video!.baseUrl).toBe("https://api.minimax.io");
    }
  });

  it("volcengine 为 standalone，Seedream/Seedance 挂在 ark 端点", () => {
    const entry = findMediaProvider("volcengine")!;
    expect(entry.kind).toBe("standalone");
    expect(entry.secretName).toBe("media.provider.volcengine");
    expect(entry.image!.protocol).toBe("volcengine-ark-image");
    expect(entry.image!.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(entry.video!.protocol).toBe("volcengine-ark-video");
    expect(entry.image!.models[0]).toMatch(/seedream/);
    expect(entry.video!.models[0]).toMatch(/seedance/);
  });
});

describe("查询函数", () => {
  it("mediaProvidersForModality 只返回配置了该模态的条目", () => {
    const imageProviders = mediaProvidersForModality("image").map((e) => e.id);
    expect(imageProviders).toEqual(expect.arrayContaining(["minimax", "minimax-cn", "xai", "volcengine"]));
    expect(imageProviders).not.toContain("xiaomi");

    const speechProviders = mediaProvidersForModality("speech").map((e) => e.id);
    expect(speechProviders).toEqual(expect.arrayContaining(["minimax", "minimax-cn", "xiaomi"]));
    expect(speechProviders).not.toContain("xai");
    expect(speechProviders).not.toContain("volcengine");

    const musicProviders = mediaProvidersForModality("music").map((e) => e.id);
    expect(musicProviders).toEqual(["minimax", "minimax-cn"]);

    const videoProviders = mediaProvidersForModality("video").map((e) => e.id);
    expect(videoProviders).toEqual(expect.arrayContaining(["minimax", "minimax-cn", "xai", "volcengine"]));
  });

  it("mediaCapabilityOf 的 speech 模态映射到 textToSpeech 字段", () => {
    const xiaomi = findMediaProvider("xiaomi")!;
    expect(mediaCapabilityOf(xiaomi, "speech")).toBe(xiaomi.textToSpeech);
    expect(mediaCapabilityOf(xiaomi, "image")).toBeUndefined();
  });

  it("findMediaProvider 未知 id 返回 undefined", () => {
    expect(findMediaProvider("nope")).toBeUndefined();
    expect(findMediaProvider("")).toBeUndefined();
  });

  it("mediaCustomSecretName 输出符合 SECRET_NAME_RE 的固定命名", () => {
    for (const modality of ALL_MODALITIES) {
      const name = mediaCustomSecretName(modality);
      expect(name).toBe(`media.${modality}.custom`);
      expect(name).toMatch(SECRET_NAME_RE);
    }
  });
});
