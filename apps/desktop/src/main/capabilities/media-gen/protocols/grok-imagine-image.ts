// Grok Imagine 图片生成协议实现（主进程，对齐 Kun GrokImagineImageClient）。
// 对应接口：{baseUrl}/v1/images/generations（api.x.ai，OpenAI 兼容端点但载荷有专属字段）
//
// 协议怪癖（为什么与 openai-images 分开实现）：
//   - 不吃 "WxH" size，而是专属 resolution 档（'1k' | '2k'，小写）；
//   - aspect_ratio 支持 13 值扩展比例集（含 19.5:9 / 20:9 等手机屏比例），
//     未指定时传 'auto' 交给模型决定；
//   - 只回 b64_json，无 url 通道；
//   - 无 /images/edits 编辑端点（参考图门控在 shared.protocolSupportsImageEdit
//     的 allowlist 中排除，client 层在网络调用前 fail loudly）；
//   - config.headers 需透传（xAI 网关/代理场景），Authorization 后铺以保证不被覆盖。

import type { ResolvedMediaGenConfig } from "../resolve";
import { MediaGenHttpError, SIZE_TIERS } from "./shared";
import { openaiImagesUrl } from "./openai-images";

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface GrokImagineImageArgs {
  prompt: string;
  model: string;
  /** Grok 13 值比例集之一（见 shared.GROK_IMAGINE_ASPECT_RATIOS）；缺省传 'auto'。*/
  aspectRatio?: string;
  /** "WxH" 尺寸（经 mapImageSize 映射）；仅用于推导 resolution 档，不直接上送。*/
  size?: string;
}

// ── 响应体类型 ────────────────────────────────────────────────────────────────

interface GrokImagineImagesResponse {
  data?: Array<{ b64_json?: string }>;
}

// ── 内部：size → resolution 档位映射 ─────────────────────────────────────────

/**
 * 把 "WxH" 尺寸映射为 Grok 专属 resolution 档：长边 ≥2048 → '2k'，否则 '1k'。
 * Grok 不接受任意像素尺寸，只有这两档（对齐 Kun grokImagineResolution）。
 */
export function grokImagineResolution(size: string | undefined): "1k" | "2k" {
  const match = size ? /^(\d+)x(\d+)$/.exec(size.trim()) : null;
  if (!match) return "1k";
  const longEdge = Math.max(Number(match[1]), Number(match[2]));
  return Number.isFinite(longEdge) && longEdge >= SIZE_TIERS["2K"] ? "2k" : "1k";
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 调用 Grok Imagine 图片生成接口，返回图片二进制 Buffer。
 *
 * @throws 网络错误、HTTP 错误（MediaGenHttpError）、响应格式错误。
 */
export async function grokImagineGenerateImage(
  args: GrokImagineImageArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = openaiImagesUrl(config.baseUrl, "generations");

  // headers 透传：自定义 headers 在前、Authorization/Content-Type 在后，
  // 确保用户配置无法覆盖凭证与内容类型（对齐 Kun 的展开顺序）。
  const extraHeaders = (config.headers as Record<string, string> | undefined) ?? {};
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...extraHeaders,
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      prompt: args.prompt,
      n: 1,
      aspect_ratio: args.aspectRatio ?? "auto",
      resolution: grokImagineResolution(args.size),
      response_format: "b64_json",
    }),
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MediaGenHttpError(res.status, text.slice(0, 300));
  }

  let payload: GrokImagineImagesResponse;
  try {
    payload = JSON.parse(text) as GrokImagineImagesResponse;
  } catch {
    throw new Error("Grok Imagine 图片接口返回了非法 JSON");
  }

  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Grok Imagine 图片接口未返回图片数据（无 b64_json）");
  }
  return Buffer.from(b64, "base64");
}
