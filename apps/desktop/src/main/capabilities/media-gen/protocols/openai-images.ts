// OpenAI Images 协议实现（主进程）。
// 对应接口：{baseUrl}/v1/images/generations 与 {baseUrl}/v1/images/edits（图生图）
//
// 规格（KTD6 + Kun OpenAiCompatImageClient 对齐）：
//   - generations: JSON body {model, prompt, n:1, size?, quality?, response_format:'b64_json'}
//   - edits: multipart FormData（model/prompt/size/quality/response_format + 参考图二进制）
//   - Authorization: Bearer {apiKey}
//   - 响应解析：data[0].b64_json → Buffer，或 data[0].url → 流式下载二进制
//   - 兼容降级链（为什么：各「OpenAI 兼容」后端对可选参数支持参差不齐，4xx 时逐级
//     去掉可疑参数重试，比一次性报错让用户改配置体验好得多）：
//       1) 4xx 且响应含 'quality' → 去掉 quality 重试（quality 是 gpt-image-1 系专属，
//          dall-e-3/SiliconFlow 等后端会直接 400）
//       2) 仍 4xx 且响应含 'response_format' → 去掉 response_format 重试
//          （部分兼容后端只支持默认 url 返回）
//   - edits 端点 404/405/501 → 抛 'edits_unsupported' 结构化错误：该后端没有
//     /images/edits 通道，上层（MCP handler / agent）据此提示「去掉参考图重试」降级。

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToBuffer } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { MediaGenHttpError, apiUrl, trimTrailingSlashes } from "./shared";

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface OpenAIImagesReferenceImage {
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface OpenAIImagesGenerateArgs {
  prompt: string;
  model: string;
  size?: string;
  /** 画质档（'auto'|'low'|'medium'|'high'）；'auto' 或缺省时不传给后端。*/
  quality?: string;
  /** 参考图（已经过 workspace 边界 + 魔数校验）；非空时走 /images/edits 图生图。*/
  referenceImages?: OpenAIImagesReferenceImage[];
}

// ── 响应体类型（宽松，实际字段由 API 返回） ────────────────────────────────────

interface OpenAIImagesResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

// ── 端点 URL ──────────────────────────────────────────────────────────────────

/**
 * 拼接 images/generations|edits 端点 URL（对齐 Kun openAiCompatImageUrl）。
 * 容忍用户把完整端点填进 baseUrl：先剥掉已带的 images/generations|edits 后缀，
 * 使 generations 与 edits 之间可互相改写（否则 edits 请求会拼出双端点路径）。
 */
export function openaiImagesUrl(baseUrl: string, endpoint: "generations" | "edits"): string {
  let normalized = trimTrailingSlashes(baseUrl.trim());
  const lower = normalized.toLowerCase();
  for (const known of ["/images/generations", "/images/edits"]) {
    if (lower.endsWith(known)) {
      normalized = trimTrailingSlashes(normalized.slice(0, -known.length));
      break;
    }
  }
  return apiUrl(normalized, `/v1/images/${endpoint}`);
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 调用 OpenAI 兼容图片生成/编辑接口，返回图片二进制 Buffer。
 * referenceImages 非空时走 /images/edits（FormData 上传参考图），否则 /images/generations。
 *
 * @throws 网络错误、HTTP 错误（MediaGenHttpError）、edits_unsupported、响应格式错误。
 */
export async function openaiImagesGenerate(
  args: OpenAIImagesGenerateArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const references = args.referenceImages ?? [];
  const endpoint: "generations" | "edits" = references.length > 0 ? "edits" : "generations";
  const url = openaiImagesUrl(config.baseUrl, endpoint);

  // 构造单次请求的 headers/body；includeQuality / includeResponseFormat 由降级链控制。
  const buildInit = (includeResponseFormat: boolean, includeQuality: boolean): RequestInit => {
    if (endpoint === "edits") {
      // edits 必须走 multipart/form-data（图片二进制无法进 JSON）；
      // 不手写 Content-Type——fetch 会自动带上 multipart boundary。
      const form = new FormData();
      form.set("model", args.model);
      form.set("prompt", args.prompt);
      if (args.size) form.set("size", args.size);
      if (includeQuality) form.set("quality", args.quality!);
      if (includeResponseFormat) form.set("response_format", "b64_json");
      // 字段名兼容（对齐 Kun）：单图用 'image'，多图用 'image[]'
      // （gpt-image-1 多参考图约定；单图沿用 dall-e-2 经典字段名以兼容旧后端）。
      const field = references.length > 1 ? "image[]" : "image";
      for (const image of references) {
        form.append(field, new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.name);
      }
      return { headers: { Authorization: `Bearer ${config.apiKey}` }, body: form };
    }
    return {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        prompt: args.prompt,
        n: 1,
        ...(args.size ? { size: args.size } : {}),
        ...(includeQuality ? { quality: args.quality } : {}),
        ...(includeResponseFormat ? { response_format: "b64_json" } : {}),
      }),
    };
  };

  const post = (includeResponseFormat: boolean, includeQuality: boolean): Promise<Response> =>
    fetch(url, { method: "POST", ...buildInit(includeResponseFormat, includeQuality), signal });

  // ── 降级链（对齐 Kun requestImage）：quality → response_format 逐级摘除 ──────
  let includeResponseFormat = true;
  let includeQuality = Boolean(args.quality && args.quality !== "auto");
  let response = await post(includeResponseFormat, includeQuality);
  if (!response.ok && response.status >= 400 && response.status < 500) {
    let errorBody = await response.text().catch(() => "");
    // 第一级：后端报文里提到 quality → 去掉 quality 重试一次。
    if (includeQuality && /quality/i.test(errorBody)) {
      includeQuality = false;
      response = await post(includeResponseFormat, includeQuality);
      if (!response.ok && response.status >= 400 && response.status < 500) {
        errorBody = await response.text().catch(() => "");
      }
    }
    // 第二级：仍 4xx 且报文里提到 response_format → 去掉该字段重试一次；
    // 与 response_format 无关的 4xx 直接抛出（重试无意义）。
    if (!response.ok && response.status >= 400 && response.status < 500) {
      if (!/response_format/i.test(errorBody)) {
        throw httpError(response.status, errorBody, endpoint);
      }
      includeResponseFormat = false;
      response = await post(includeResponseFormat, includeQuality);
    }
  }
  if (!response.ok) {
    throw httpError(response.status, await response.text().catch(() => ""), endpoint);
  }

  const data = (await response.json()) as OpenAIImagesResponse;
  return parseResponse(data, signal);
}

// ── 内部：HTTP 错误构造 ───────────────────────────────────────────────────────

/**
 * 把 HTTP 失败包装为可判定错误。edits 端点的 404/405/501 说明后端根本没有
 * /images/edits 通道（而非本次请求参数问题），转成 'edits_unsupported' 结构化
 * 错误——上层据此提示 agent 去掉 reference_image_paths 重试，而不是盲目换配置。
 */
function httpError(status: number, body: string, endpoint: "generations" | "edits"): Error {
  if (endpoint === "edits" && (status === 404 || status === 405 || status === 501)) {
    return new Error(
      `edits_unsupported：当前图片供应商不支持参考图编辑（/images/edits 返回 HTTP ${status}）；` +
      "请去掉 reference_image_paths 重试纯文生图。",
    );
  }
  return new MediaGenHttpError(status, body.slice(0, 300));
}

// ── 内部：解析响应 ────────────────────────────────────────────────────────────

async function parseResponse(data: OpenAIImagesResponse, signal: AbortSignal): Promise<Buffer> {
  const item = data.data?.[0];
  if (!item) {
    throw new Error("图片生成接口响应中 data 数组为空或缺失");
  }

  // 优先 b64_json
  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  }

  // 回退 url：下载二进制（必须传 signal，否则 CDN 卡住时 timeout 无法中止下载）。
  if (item.url) {
    return downloadUrl(item.url, signal);
  }

  throw new Error("图片生成接口响应中既无 b64_json 也无 url");
}

// ── 内部：从 URL 下载图片二进制 ────────────────────────────────────────────────
//
// 使用 streamDownloadToBuffer 而非 res.arrayBuffer()（KTD11 / ADV-006）：
// 边读边计数，累计超过 MAX_RESPONSE_BYTES.image 时立即 reader.cancel() 中止，
// 防止异常大响应在事后检查前就耗尽 V8 堆。图片上限 50MB，收集到 Buffer 可接受。

async function downloadUrl(url: string, signal: AbortSignal): Promise<Buffer> {
  // 必须传 signal：CDN 响应慢时若不绑 AbortSignal，超时触发后 AbortController abort 无法
  // 中止此 fetch，导致下载 Promise 悬挂，工具 handler 无法正常退出。
  return streamDownloadToBuffer(url, {
    signal,
    maxBytes: MAX_RESPONSE_BYTES.image,
    modality: "image",
  });
}
