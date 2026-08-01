// 媒体供应商目录（Cortex 自维护，core 单份共享）。
//
// 背景：pi Provider Catalog（resources/pi/provider-catalog.json）只描述文本能力，
// 不含任何媒体能力字段；媒体能力（图片/语音/音乐/视频的协议 + 端点 + 模型表）
// 由本目录补充维护，形状对齐 Kun model-provider-presets.ts 的 capability。
//
// 跨包契约：本文件**不做双镜像**——main 进程直接 import 本子路径
// （@cortex-work/core/desktop/media-provider-directory，见 core package.json exports），
// 与 main/index.ts → core/reply/memory 等既有先例一致，避免数据双份漂移。
// 注意：MediaGenSettings 等持久化类型仍维持 core/desktop/media-gen-types.ts ↔
// apps/desktop/src/main/ipc/types.ts 的镜像约定，本目录是纯数据 + 纯函数，不在其列。

import type {
  ImageGenProtocol,
  SpeechGenProtocol,
  MusicGenProtocol,
  VideoGenProtocol,
} from "./media-gen-types";

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 单模态媒体能力：协议 + 端点 + 模型列表（照抄 Kun capability 形状）。*/
export interface MediaCapability<P extends string = string> {
  protocol: P;
  baseUrl: string;
  models: string[];
}

/** 媒体供应商目录条目。kind 决定密钥来源（见字段注释）。*/
export interface MediaProviderEntry {
  /** kind="catalog" 时必须等于 pi Provider Catalog 里的 providerId（凭据复用金库 credential）。*/
  id: string;
  name: string;
  /**
   * catalog    —— pi 目录里存在的 provider，API key 由用户在「Provider 设置」页配置（金库 credential）；
   * standalone —— pi 目录没有的媒体专用供应商（volcengine），key 存金库命名 Secret（secretName）。
   */
  kind: "catalog" | "standalone";
  /** standalone 专用：金库命名 Secret 名（须匹配 SECRET_NAME_RE），如 "media.provider.volcengine"。*/
  secretName?: string;
  /** 取 key 的控制台地址，UI 提示用。*/
  apiKeyUrl?: string;
  image?: MediaCapability<ImageGenProtocol>;
  /** 语音（TTS）能力；字段名沿 Kun 叫 textToSpeech，与 MediaModality "speech" 经 mediaCapabilityOf 映射。*/
  textToSpeech?: MediaCapability<SpeechGenProtocol>;
  music?: MediaCapability<MusicGenProtocol>;
  video?: MediaCapability<VideoGenProtocol>;
}

export type MediaModality = "image" | "speech" | "music" | "video";

// ── 目录数据（v1，模型列表照抄 Kun model-provider-presets.ts） ─────────────────

/**
 * MiniMax 四模态能力。
 *
 * ⚠️ baseUrl 跨域是刻意的（Kun 实测行为，勿"统一"）：
 * image 走 https://api.minimaxi.com（国内域），tts/music/video 走 https://api.minimax.io
 * （国际域）——同一把 API key 在两个域通用，但图片接口只在国内域可用。
 * minimax 与 minimax-cn（catalog 的 CN 变体）共用同一份媒体能力（Kun 单条目本就混域）。
 */
function minimaxMediaCapabilities(): Pick<
  MediaProviderEntry,
  "image" | "textToSpeech" | "music" | "video"
> {
  return {
    image: {
      protocol: "minimax-image",
      baseUrl: "https://api.minimaxi.com",
      models: ["image-01", "image-01-live"],
    },
    textToSpeech: {
      protocol: "minimax-t2a",
      baseUrl: "https://api.minimax.io",
      models: ["speech-2.8-hd", "speech-2.8-turbo"],
    },
    music: {
      protocol: "minimax-music",
      baseUrl: "https://api.minimax.io",
      models: ["music-2.6", "music-cover", "music-2.6-free", "music-cover-free"],
    },
    video: {
      protocol: "minimax-video",
      baseUrl: "https://api.minimax.io",
      models: ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"],
    },
  };
}

export const MEDIA_PROVIDER_DIRECTORY: readonly MediaProviderEntry[] = [
  {
    id: "minimax",
    name: "MiniMax",
    kind: "catalog",
    apiKeyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    ...minimaxMediaCapabilities(),
  },
  {
    // catalog 里的 CN 变体单列（文本侧端点不同）；媒体能力与 minimax 完全同一份。
    id: "minimax-cn",
    name: "MiniMax（中国）",
    kind: "catalog",
    apiKeyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    ...minimaxMediaCapabilities(),
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    kind: "catalog",
    apiKeyUrl: "https://platform.xiaomimimo.com",
    textToSpeech: {
      protocol: "mimo-tts",
      baseUrl: "https://api.xiaomimimo.com/v1",
      models: ["mimo-v2.5-tts", "mimo-v2.5-tts-voicedesign", "mimo-v2.5-tts-voiceclone"],
    },
  },
  {
    // 按量 API key 路径（xai 在 catalog 里支持 api-key）；刻意不做 Kun 的 grok-subscription OAuth。
    id: "xai",
    name: "xAI（Grok Imagine）",
    kind: "catalog",
    apiKeyUrl: "https://accounts.x.ai",
    image: {
      protocol: "grok-imagine-image",
      baseUrl: "https://api.x.ai/v1",
      models: ["grok-imagine-image-quality", "grok-imagine-image"],
    },
    video: {
      protocol: "grok-imagine-video",
      baseUrl: "https://api.x.ai/v1",
      models: ["grok-imagine-video-1.5-preview", "grok-imagine-video"],
    },
  },
  {
    // pi catalog 无 volcengine——只出现在媒体设置下拉，key 内联输入进金库命名 Secret。
    id: "volcengine",
    name: "火山方舟（Volcengine Ark）",
    kind: "standalone",
    secretName: "media.provider.volcengine",
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    image: {
      protocol: "volcengine-ark-image",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      models: [
        "doubao-seedream-5-0-pro-260628",
        "doubao-seedream-5-0-260128",
        "doubao-seedream-5-0-lite-260128",
      ],
    },
    video: {
      protocol: "volcengine-ark-video",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      models: [
        "doubao-seedance-2-0-260128",
        "doubao-seedance-2-0-fast-260128",
        "doubao-seedance-2-0-mini-260615",
      ],
    },
  },
];

// ── 查询函数 ──────────────────────────────────────────────────────────────────

/** 模态 → capability 字段映射（speech 模态对应 textToSpeech 能力，命名沿 Kun）。*/
export function mediaCapabilityOf(
  entry: MediaProviderEntry,
  modality: MediaModality,
): MediaCapability | undefined {
  switch (modality) {
    case "image":
      return entry.image;
    case "speech":
      return entry.textToSpeech;
    case "music":
      return entry.music;
    case "video":
      return entry.video;
  }
}

/** 配置了对应模态能力的目录条目（设置下拉数据源）。*/
export function mediaProvidersForModality(modality: MediaModality): MediaProviderEntry[] {
  return MEDIA_PROVIDER_DIRECTORY.filter((entry) => mediaCapabilityOf(entry, modality) !== undefined);
}

export function findMediaProvider(id: string): MediaProviderEntry | undefined {
  return MEDIA_PROVIDER_DIRECTORY.find((entry) => entry.id === id);
}

/**
 * 「自定义」路径的固定金库 Secret 名（UI 写入与主进程明文迁移共用同一组常量，
 * 均须匹配主进程 secrets.ts 的 SECRET_NAME_RE：/^[A-Za-z0-9_.-]{1,64}$/）。
 */
export function mediaCustomSecretName(modality: MediaModality): string {
  return `media.${modality}.custom`;
}
