// 火山方舟（Volcengine Ark / Seedream）图片生成协议实现（主进程，对齐 Kun VolcengineArkImageClient）。
// 对应接口：POST {baseUrl}/images/generations（baseUrl 通常已含 /api/v3，故不再插 /v1）
//
// 协议怪癖（为什么与 openai-images 分开实现）：
//   - size 接受 "WxH" 或 '2K'/'3K'/'4K' 档位字面量；未指定时必须显式给 '2K'
//     （Seedream 不给 size 会用低分辨率默认档，产出观感差）；
//   - 图生图不走 /images/edits，而是同一 generations 端点带 image 数组
//     （dataUri 形态），因此在 protocolSupportsImageEdit allowlist 中；
//   - 需显式关闭连续生成/流式/水印（sequential_image_generation/stream/watermark），
//     否则默认行为与单图工具语义不符；
//   - 响应 b64_json / url 双通道，无数据时 error.message/code 里有可读原因。

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToBuffer } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { MediaGenHttpError, dataUri, trimTrailingSlashes } from "./shared";

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface VolcengineArkReferenceImage {
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface VolcengineArkImageArgs {
  prompt: string;
  model: string;
  /** "WxH" 或 '2K'/'3K'/'4K'；缺省回落 '2K'。*/
  size?: string;
  /** 参考图（已经过 workspace 边界 + 魔数校验）；非空时走图生图（image 数组字段）。*/
  referenceImages?: VolcengineArkReferenceImage[];
}

// ── 响应体类型 ────────────────────────────────────────────────────────────────

interface VolcengineArkImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { code?: string; message?: string };
}

// ── 端点 URL ──────────────────────────────────────────────────────────────────

/**
 * 图片端点：{baseUrl}/images/generations（容忍用户已把完整路径填进 baseUrl）。
 * 不复用 apiUrl：方舟 baseUrl 已带 /api/v3 版本段，再插 /v1 会 404。
 */
export function volcengineArkImageUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim());
  if (!normalized) return "/images/generations";
  if (normalized.toLowerCase().endsWith("/images/generations")) return normalized;
  return `${normalized}/images/generations`;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 调用火山方舟 Seedream 图片生成/编辑接口，返回图片二进制 Buffer。
 * referenceImages 非空时在载荷里带 image 数组（dataUri）做图生图。
 *
 * @throws 网络错误、HTTP 错误（MediaGenHttpError）、响应格式错误。
 */
export async function volcengineArkGenerateImage(
  args: VolcengineArkImageArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = volcengineArkImageUrl(config.baseUrl);
  const images = args.referenceImages ?? [];

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      prompt: args.prompt,
      // 图生图：参考图以 dataUri 数组进 image 字段（同一 generations 端点）。
      ...(images.length > 0 ? { image: images.map((img) => dataUri(img.mimeType, img.data)) } : {}),
      // 缺省强制 '2K'：Seedream 无 size 时的默认档观感差（对齐 Kun）。
      size: args.size ?? "2K",
      output_format: "png",
      response_format: "b64_json",
      sequential_image_generation: "disabled",
      stream: false,
      watermark: false,
    }),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new MediaGenHttpError(res.status, errorBody.slice(0, 300));
  }

  const payload = (await res.json()) as VolcengineArkImagesResponse;
  const entry = payload.data?.[0];

  // 优先 b64_json
  if (entry?.b64_json) {
    return Buffer.from(entry.b64_json, "base64");
  }

  // 回退 url：流式下载，超限即中止（signal 绑定使超时可中断 CDN 慢速下载）。
  if (entry?.url) {
    return streamDownloadToBuffer(entry.url, {
      signal,
      maxBytes: MAX_RESPONSE_BYTES.image,
      modality: "image",
    });
  }

  // 无图片数据：把方舟 error 里的可读原因带出来（配额/审核拒绝等都在这里）。
  const detail = payload.error?.message?.trim() || payload.error?.code?.trim();
  throw new Error(
    detail
      ? `火山方舟图片接口未返回图片数据：${detail}`
      : "火山方舟图片接口未返回图片数据",
  );
}
