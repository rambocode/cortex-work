// OpenAI Images 协议实现（主进程）。
// 对应接口：{baseUrl}/v1/images/generations
//
// 规格（KTD6）：
//   - body: {model, prompt, n:1, size, response_format:'b64_json'}
//   - Authorization: Bearer {apiKey}
//   - 响应解析：data[0].b64_json → Buffer，或 data[0].url → 下载二进制
//   - 4xx 且响应含 'response_format' 字符串 → 去掉该字段重试一次
//     （兼容部分兼容 API 不支持 response_format 参数的情况）

import type { ResolvedMediaGenConfig } from "../resolve";

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface OpenAIImagesGenerateArgs {
  prompt: string;
  model: string;
  size?: string;
  /** 参考图片绝对路径（已经过 assertWithinWorkspace 安全校验）。*/
  referenceImagePaths?: string[];
}

// ── 响应体类型（宽松，实际字段由 API 返回） ────────────────────────────────────

interface OpenAIImagesResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 调用 OpenAI 兼容图片生成接口，返回图片二进制 Buffer。
 *
 * @throws 网络错误、HTTP 错误、响应格式错误均会抛出 Error。
 */
export async function openaiImagesGenerate(
  args: OpenAIImagesGenerateArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/images/generations`;
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    n: 1,
    ...(args.size ? { size: args.size } : {}),
    response_format: "b64_json",
  };

  // ── 首次请求 ──────────────────────────────────────────────────────────────
  const result = await doRequest(url, body, config.apiKey, signal);

  // ── 4xx + 响应体含 response_format 字样 → 去字段重试 ──────────────────────
  if (result.status === "retry") {
    const retryBody = { ...body };
    delete retryBody.response_format;
    const retryResult = await doRequest(url, retryBody, config.apiKey, signal);
    if (retryResult.status === "retry") {
      // 重试后仍然 4xx，抛出错误
      throw new Error(
        `图片生成接口 HTTP ${retryResult.httpStatus}（重试后仍失败）: ${retryResult.errorBody}`,
      );
    }
    return parseResponse(retryResult.data, signal);
  }

  return parseResponse(result.data, signal);
}

// ── 内部：发单次请求 ──────────────────────────────────────────────────────────

type RequestResult =
  | { status: "ok"; data: OpenAIImagesResponse }
  | { status: "retry"; httpStatus: number; errorBody: string };

async function doRequest(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
): Promise<RequestResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    // 4xx 且响应含 'response_format' → 触发去字段重试
    if (res.status >= 400 && res.status < 500 && errorBody.includes("response_format")) {
      return { status: "retry", httpStatus: res.status, errorBody };
    }
    throw new Error(
      `图片生成接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as OpenAIImagesResponse;
  return { status: "ok", data };
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

async function downloadUrl(url: string, signal: AbortSignal): Promise<Buffer> {
  // 安全：只允许 https://
  if (!url.startsWith("https://")) {
    throw new Error(`图片下载 URL 必须为 https://，当前: ${url}`);
  }
  // 必须传 signal：CDN 响应慢时若不绑 AbortSignal，超时触发后 AbortController abort 无法
  // 中止此 fetch，导致下载 Promise 悬挂，工具 handler 无法正常退出。
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`下载图片失败 HTTP ${res.status}: ${url}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
