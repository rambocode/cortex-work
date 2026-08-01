// MiniMax 图片生成协议实现（主进程）。
// 自原 minimax.ts 按模态拆出（纯移动，行为不变）；公共辅助改从 shared.ts 导入。
//
// 规格（KTD6）：POST {baseUrl}/v1/image_generation
//   body: {model, prompt, aspect_ratio, prompt_optimizer:true, response_format:'base64', n:1}
//   header: Authorization: Bearer {apiKey}
//   解析: data.image_base64[0] → Buffer；或 data.image_urls[0] → 下载
//   base_resp.status_code !== 0 视为失败（含 status_msg）

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToBuffer } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { checkMinimaxBaseResp } from "./shared";

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface MinimaxImageArgs {
  prompt: string;
  model: string;
  aspectRatio?: string; // 如 '16:9'、'1:1'
}

// ── 响应类型 ──────────────────────────────────────────────────────────────────

interface MinimaxImageResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: {
    image_base64?: string[];
    image_urls?: string[];
  };
}

/**
 * 调用 MiniMax 图片生成接口，返回图片二进制 Buffer。
 */
export async function minimaxGenerateImage(
  args: MinimaxImageArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/image_generation`;
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    prompt_optimizer: true,
    response_format: "base64",
    n: 1,
    ...(args.aspectRatio ? { aspect_ratio: args.aspectRatio } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`MiniMax 图片生成接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as MinimaxImageResponse;

  // MiniMax 特有：base_resp.status_code !== 0 视为失败
  checkMinimaxBaseResp(data.base_resp, "图片生成");

  // 优先 base64
  const base64 = data.data?.image_base64?.[0];
  if (base64) {
    return Buffer.from(base64, "base64");
  }

  // 回退 url：流式下载，超过图片限制时立即中止（CDN 卡住时 signal 可中止下载）。
  const imageUrl = data.data?.image_urls?.[0];
  if (imageUrl) {
    return streamDownloadToBuffer(imageUrl, {
      signal,
      maxBytes: MAX_RESPONSE_BYTES.image,
      modality: "image",
    });
  }

  throw new Error("MiniMax 图片生成响应中既无 image_base64 也无 image_urls");
}
