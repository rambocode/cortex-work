// 媒体生成协议层公共工具（shared.ts）。
// 从 Kun image-gen-tool-provider.ts / media-gen-tool-provider.ts 移植的纯函数集合：
// HTTP 错误类型、网络错误展开、URL 规整、尺寸映射、魔数嗅探、hex/dataUri 编解码等。
// 约束：本文件不得 import client.ts / server.ts（避免循环依赖），保持纯函数 + 常量。

// ── HTTP 错误（携带 status，供 edits 404/405/501 降级判定） ────────────────────

/** 协议层 HTTP 错误：携带 status code，调用方可据此做降级（对齐 Kun ImageGenHttpError）。*/
export class MediaGenHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "MediaGenHttpError";
  }
}

/**
 * Node fetch 把所有网络失败都报成裸 `TypeError: fetch failed`，可诊断细节
 * （DNS/拒连/TLS…）藏在 cause 链里。此函数把 cause 链摊平成一条可读消息。
 */
export function describeNetworkError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof AggregateError && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    const codeText = typeof code === "string" ? code : "";
    const message = current.message.trim();
    if (message) {
      parts.push(codeText && !message.includes(codeText) ? `${message} (${codeText})` : message);
    } else if (codeText) {
      parts.push(codeText);
    }
    current = current.cause;
  }
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.join(": ") || "unknown network error";
}

// ── URL 规整 ──────────────────────────────────────────────────────────────────

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/**
 * 把 baseUrl 与 v1 路径拼成完整接口 URL，容忍用户 baseUrl 已带 /v1 或完整路径：
 * apiUrl("https://a.com", "/v1/images/generations") → https://a.com/v1/images/generations
 * apiUrl("https://a.com/v1", 同上) → https://a.com/v1/images/generations（不重复 /v1）
 * apiUrl("https://a.com/v1/images/generations", 同上) → 原样。
 */
export function apiUrl(baseUrl: string, v1Path: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim());
  const lower = normalized.toLowerCase();
  const path = v1Path.startsWith("/") ? v1Path : `/${v1Path}`;
  const pathWithoutV1 = path.startsWith("/v1/") ? path.slice("/v1".length) : path;
  if (!normalized) return path;
  if (lower.endsWith(path.toLowerCase()) || lower.endsWith(pathWithoutV1.toLowerCase())) return normalized;
  if (lower.endsWith("/v1")) return `${normalized}${pathWithoutV1}`;
  return `${normalized}${path}`;
}

/**
 * MiniMax 根 URL 提取：容忍用户把完整 video_generation 路径填进 baseUrl 的场景，
 * 剥掉已知后缀得到根域（后续再拼 /v1/query 等兄弟路径时不会重复）。
 */
export function minimaxRootUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim());
  if (!normalized) return "";
  for (const suffix of ["/v1/video_generation", "/video_generation", "/v1/query/video_generation"]) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      return trimTrailingSlashes(normalized.slice(0, -suffix.length));
    }
  }
  if (normalized.toLowerCase().endsWith("/v1")) return trimTrailingSlashes(normalized.slice(0, -3));
  return normalized;
}

/** 火山方舟视频任务端点：{baseUrl}/contents/generations/tasks（容忍已带完整路径）。*/
export function volcengineArkVideoTasksUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim());
  if (!normalized) return "/contents/generations/tasks";
  if (normalized.toLowerCase().endsWith("/contents/generations/tasks")) return normalized;
  return `${normalized}/contents/generations/tasks`;
}

// ── 编解码 ────────────────────────────────────────────────────────────────────

export function dataUri(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

/** hex 字符串 → Buffer（MiniMax t2a/music 的 output_format:'hex' 响应）。非法 hex 抛错。*/
export function bufferFromHex(value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error("供应商返回了非法的 hex 音频数据");
  }
  return Buffer.from(normalized, "hex");
}

// ── 可取消延迟 ────────────────────────────────────────────────────────────────

/**
 * 可取消的延迟（AbortSignal 触发时提前 reject）。
 * 预中止检测：若 signal 在调用时已 aborted，abort 事件不会再触发（事件已过），
 * 必须先检查 signal.aborted 立即 reject，否则定时器会跑满整个间隔。
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error("已中止"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("延迟被取消（AbortSignal）"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── 图片魔数嗅探 ──────────────────────────────────────────────────────────────
//
// Kun 依赖 attachment-store 的 detectImage，cortex 无此依赖故自带精简实现。
// 只识别参考图白名单三种格式（png/jpeg/webp），其余返回 undefined 由调用方拒绝。

export type DetectedImageMime = "image/png" | "image/jpeg" | "image/webp";

export function detectImageMime(data: Buffer): DetectedImageMime | undefined {
  if (data.byteLength >= 8 &&
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
      data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return "image/png";
  }
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  // WebP：RIFF????WEBP（4-7 字节是文件长度，跳过）。
  if (data.byteLength >= 12 &&
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return "image/webp";
  }
  return undefined;
}

// ── 图片尺寸映射（Kun image-gen-tool-provider.ts:160-209 移植） ────────────────

// 通用 8 值比例集与 Grok Imagine 13 值比例集（工具 schema 的 aspect_ratio enum 数据源）。
export const COMMON_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"] as const;
export const GROK_IMAGINE_ASPECT_RATIOS = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20",
] as const;
const KNOWN_ASPECT_RATIOS = new Set<string>([...COMMON_ASPECT_RATIOS, ...GROK_IMAGINE_ASPECT_RATIOS]);

// 分辨率档 → 长边像素。
export const SIZE_TIERS: Record<string, number> = {
  "1K": 1024,
  "2K": 2048,
  "3K": 3072,
  "4K": 4096,
};
export const DEFAULT_IMAGE_SIZE_TIERS = ["1K", "2K"] as const;
export const VOLCENGINE_IMAGE_SIZE_TIERS = ["2K", "3K", "4K"] as const;
const COMPATIBLE_SIZE_FALLBACK = SIZE_TIERS["1K"];
const SIZE_STEP = 64;
const MIN_EDGE = 256;

/**
 * 把「宽高比 + 分辨率档」映射为 OpenAI 兼容的 "WxH" 尺寸字符串。
 * 长边优先取显式档位（image_size），其次自定义 defaultSize，最后设置的 defaultResolution；
 * 短边按比例换算并对齐 64 的倍数、下限 256。无比例且分辨率为 "auto" 时透传 "auto"
 * （比例需要具体尺寸，故带比例的 "auto" 回落 1K 档）。
 */
export function mapImageSize(
  aspectRatio: string | undefined,
  imageSize: string | undefined,
  defaultSize: string | undefined,
  defaultResolution: "auto" | "1K" | "2K" | "3K" | "4K" = "1K",
): string | undefined {
  if (imageSize) {
    return sizeForLongEdge(aspectRatio, SIZE_TIERS[imageSize] ?? COMPATIBLE_SIZE_FALLBACK);
  }

  if (defaultSize) {
    if (!aspectRatio) return defaultSize;
    const longEdge = parseSizeLongEdge(defaultSize);
    if (longEdge) return sizeForLongEdge(aspectRatio, longEdge);
  }

  if (!aspectRatio && defaultResolution === "auto") return "auto";
  return sizeForLongEdge(
    aspectRatio,
    SIZE_TIERS[defaultResolution] ?? COMPATIBLE_SIZE_FALLBACK,
  );
}

export function sizeForLongEdge(aspectRatio: string | undefined, longEdge: number): string {
  const parsed = parseRatio(aspectRatio);
  if (!parsed) return `${longEdge}x${longEdge}`;
  const { w, h } = parsed;
  if (w === h) return `${longEdge}x${longEdge}`;
  const short = Math.max(
    MIN_EDGE,
    Math.round((longEdge * Math.min(w, h)) / Math.max(w, h) / SIZE_STEP) * SIZE_STEP,
  );
  return w > h ? `${longEdge}x${short}` : `${short}x${longEdge}`;
}

function parseSizeLongEdge(size: string): number | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return Math.max(width, height);
}

/** 解析已知比例字符串；未知比例返回 null（未知值不猜，回落方形）。*/
export function parseRatio(aspectRatio: string | undefined): { w: number; h: number } | null {
  if (!aspectRatio || !KNOWN_ASPECT_RATIOS.has(aspectRatio)) return null;
  const [w, h] = aspectRatio.split(":").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

// ── 图片编辑（图生图）协议白名单 ───────────────────────────────────────────────

/**
 * 该协议是否具备**真正的**图生图编辑通道（真 /images/edits 语义）。
 * 刻意用 allowlist：新协议默认「不支持编辑」，直到其 edit 路径被验证。
 * MiniMax 的 subject_reference 是角色/身份保持而非通用编辑，grok imagine 无编辑端点——
 * 把画布「改这张图」请求路由过去会静默产出一张全新（错误）的图，宁可 fail loudly。
 * （Kun 的 codex-responses-image 已仲裁砍掉，不在名单。）
 */
export function protocolSupportsImageEdit(protocol: string | undefined): boolean {
  return protocol === "openai-images" || protocol === "volcengine-ark-image";
}

// ── MiniMax 图片尺寸字段（Kun :1231-1252 移植） ───────────────────────────────

// 两个 MiniMax 图片模型都接受的 aspect_ratio 值（21:9 仅 image-01，而 image-01 走显式宽高）。
const MINIMAX_ASPECT_RATIOS: Array<{ label: string; value: number }> = [
  { label: "1:1", value: 1 },
  { label: "16:9", value: 16 / 9 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "9:16", value: 9 / 16 },
];

/**
 * 为 "WxH" 尺寸构造 MiniMax 维度字段。按 t2i 文档只有 image-01 接受显式
 * width/height（[512,2048]、8 的倍数）；image-01-live 会以 status 2013 拒绝，
 * 故其它模型改传「最接近的」aspect_ratio（最近而非精确：mapImageSize 会把边长
 * 对齐到 64 的倍数，例如 3:2 在 1K 档变成 1024x680）。
 */
export function minimaxImageDimensionFields(
  model: string,
  size: string | undefined,
): Record<string, unknown> {
  const match = size?.trim().match(/^(\d+)x(\d+)$/);
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {};
  if (model.trim() === "image-01") return { width, height };
  const target = width / height;
  let best = MINIMAX_ASPECT_RATIOS[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of MINIMAX_ASPECT_RATIOS) {
    const diff = Math.abs(Math.log(candidate.value / target));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return { aspect_ratio: best.label };
}

// ── MiniMax 通用响应校验 ──────────────────────────────────────────────────────

export interface MinimaxBaseResp {
  status_code?: number;
  status_msg?: string;
}

/** 检查 MiniMax 通用 base_resp 状态码；status_code !== 0 抛带诊断信息的 Error。*/
export function checkMinimaxBaseResp(
  baseResp: MinimaxBaseResp | undefined,
  operation: string,
): void {
  if (!baseResp) return;
  const code = baseResp.status_code;
  if (code !== undefined && code !== 0) {
    throw new Error(
      `MiniMax ${operation} 错误（status_code=${code}）: ${baseResp.status_msg ?? "未知错误"}`,
    );
  }
}

// ── 视频协议档位常量（server 动态 schema 与协议实现共用） ──────────────────────

export const MINIMAX_VIDEO_RESOLUTIONS = ["768P", "1080P"] as const;
export const GROK_VIDEO_RESOLUTIONS = ["480P", "720P"] as const;
export const GROK_VIDEO_DURATIONS = [6, 10] as const;
export const GROK_VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "3:2", "2:3"] as const;
export const VOLCENGINE_VIDEO_RESOLUTIONS = ["480P", "720P", "1080P", "4K"] as const;
export const VOLCENGINE_VIDEO_ASPECT_RATIOS = [
  "adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16",
] as const;

// ── 音频格式（speech/music 工具 schema 的 format enum 数据源，对齐 Kun AUDIO_FORMATS） ──

export const AUDIO_FORMATS = ["mp3", "wav", "flac", "pcm", "pcm16"] as const;
