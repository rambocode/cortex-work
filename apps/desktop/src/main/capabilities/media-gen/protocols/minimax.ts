// MiniMax 媒体生成协议实现（主进程）。
// 覆盖四类媒体：图片、视频（异步轮询）、音乐、TTS。
//
// 规格（来自 plan KTD6）：
//
// 图片：POST {baseUrl}/v1/image_generation
//   body: {model, prompt, aspect_ratio, prompt_optimizer:true, response_format:'base64', n:1}
//   header: Authorization: Bearer {apiKey}
//   解析: data.image_base64[0] → Buffer；或 data.image_urls[0] → 下载
//   base_resp.status_code !== 0 视为失败（含 status_msg）
//
// 视频（异步轮询）：
//   1. POST {baseUrl}/v1/video_generation → 拿 task_id
//   2. 轮询 GET {baseUrl}/v1/query/video_generation?task_id={task_id}，每 5s 一次
//      直到 status==='Success'|'Fail' 或超时
//   3. 完成后 GET {baseUrl}/v1/files/retrieve?file_id={file_id} → download_url
//   4. 下载二进制
//
// 音乐：POST {baseUrl}/v1/music_generation
// TTS：POST {baseUrl}/v1/t2a_v2

import type { ResolvedMediaGenConfig } from "../resolve";

// ── 视频轮询参数 ──────────────────────────────────────────────────────────────

/** 视频任务轮询间隔（ms），使用 config.pollIntervalMs 或此默认值。*/
const DEFAULT_POLL_INTERVAL_MS = 5_000;

// ── 图片生成参数 ──────────────────────────────────────────────────────────────

export interface MinimaxImageArgs {
  prompt: string;
  model: string;
  aspectRatio?: string; // 如 '16:9'、'1:1'
}

// ── 视频生成参数 ──────────────────────────────────────────────────────────────

export interface MinimaxVideoArgs {
  prompt: string;
  model: string;
  firstFrameImagePath?: string; // 已经安全校验的绝对路径
  lastFrameImagePath?: string;
  duration?: number;
  resolution?: string;
}

// ── 音乐生成参数 ──────────────────────────────────────────────────────────────

export interface MinimaxMusicArgs {
  prompt: string;
  model: string;
  lyrics?: string;
  format?: string;
}

// ── TTS 参数 ──────────────────────────────────────────────────────────────────

export interface MinimaxTtsArgs {
  text: string;
  model: string;
  voice?: string;
  speed?: number;
  format?: string;
}

// ── 图片生成 ──────────────────────────────────────────────────────────────────

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
  const statusCode = data.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(
      `MiniMax 图片生成失败（status_code=${statusCode}）: ${data.base_resp?.status_msg ?? "未知错误"}`,
    );
  }

  // 优先 base64
  const base64 = data.data?.image_base64?.[0];
  if (base64) {
    return Buffer.from(base64, "base64");
  }

  // 回退 url（传 signal：CDN 卡住时 abort 可中止下载，与 openai-images 行为对齐）。
  const imageUrl = data.data?.image_urls?.[0];
  if (imageUrl) {
    return downloadHttpsUrl(imageUrl, signal);
  }

  throw new Error("MiniMax 图片生成响应中既无 image_base64 也无 image_urls");
}

// ── 视频生成（异步轮询） ──────────────────────────────────────────────────────

interface MinimaxVideoGenResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  task_id?: string;
}

interface MinimaxVideoQueryResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  status?: string; // 'Queueing' | 'Processing' | 'Success' | 'Fail'
  file_id?: string;
}

interface MinimaxFileRetrieveResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  file?: {
    file_id?: string;
    download_url?: string;
  };
}

/**
 * 调用 MiniMax 视频生成接口（异步轮询），返回视频二进制 Buffer。
 */
export async function minimaxGenerateVideo(
  args: MinimaxVideoArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  // ── 1. 提交任务 ───────────────────────────────────────────────────────────
  const genBody: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    ...(args.duration ? { duration: args.duration } : {}),
    ...(args.resolution ? { resolution: args.resolution } : {}),
    // first_frame_image 与 last_frame_image 为可选参数（图片路径→需 base64 上传，v1 暂不实现）
  };

  const genRes = await fetch(`${baseUrl}/v1/video_generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(genBody),
    signal,
  });

  if (!genRes.ok) {
    const errorBody = await genRes.text().catch(() => "");
    throw new Error(`MiniMax 视频生成提交失败 HTTP ${genRes.status}: ${errorBody.slice(0, 300)}`);
  }

  const genData = (await genRes.json()) as MinimaxVideoGenResponse;
  checkMinimaxBaseResp(genData.base_resp, "视频生成提交");

  const taskId = genData.task_id;
  if (!taskId) {
    throw new Error("MiniMax 视频生成接口未返回 task_id");
  }

  // ── 2. 轮询任务状态 ───────────────────────────────────────────────────────
  const pollInterval = (config.pollIntervalMs as number | undefined) ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + config.timeoutMs;

  let fileId: string | undefined;
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(`MiniMax 视频生成超时（task_id=${taskId}，timeoutMs=${config.timeoutMs}）`);
    }
    // signal 被 abort 时提前退出
    if (signal.aborted) {
      throw new Error("视频生成已取消（AbortSignal）");
    }

    await delay(pollInterval, signal);

    const queryRes = await fetch(
      `${baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal,
      },
    );

    if (!queryRes.ok) {
      const errorBody = await queryRes.text().catch(() => "");
      throw new Error(`MiniMax 视频状态查询失败 HTTP ${queryRes.status}: ${errorBody.slice(0, 200)}`);
    }

    const queryData = (await queryRes.json()) as MinimaxVideoQueryResponse;
    checkMinimaxBaseResp(queryData.base_resp, "视频状态查询");

    const status = queryData.status;
    if (status === "Fail") {
      throw new Error(`MiniMax 视频生成失败（task_id=${taskId}，status=Fail）`);
    }
    if (status === "Success") {
      fileId = queryData.file_id;
      break;
    }
    // 'Queueing' | 'Processing' 继续轮询
  }

  if (!fileId) {
    throw new Error("MiniMax 视频生成成功但未返回 file_id");
  }

  // ── 3. 获取下载 URL ───────────────────────────────────────────────────────
  const retrieveRes = await fetch(
    `${baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal,
    },
  );

  if (!retrieveRes.ok) {
    const errorBody = await retrieveRes.text().catch(() => "");
    throw new Error(`MiniMax 文件获取失败 HTTP ${retrieveRes.status}: ${errorBody.slice(0, 200)}`);
  }

  const retrieveData = (await retrieveRes.json()) as MinimaxFileRetrieveResponse;
  checkMinimaxBaseResp(retrieveData.base_resp, "文件获取");

  const downloadUrl = retrieveData.file?.download_url;
  if (!downloadUrl) {
    throw new Error(`MiniMax 文件获取响应中无 download_url（file_id=${fileId}）`);
  }

  // ── 4. 下载视频二进制 ─────────────────────────────────────────────────────
  return downloadHttpsUrl(downloadUrl, signal);
}

// ── 音乐生成 ──────────────────────────────────────────────────────────────────

interface MinimaxMusicResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: {
    audio?: string; // base64
    audio_url?: string;
  };
}

/**
 * 调用 MiniMax 音乐生成接口，返回音频二进制 Buffer。
 */
export async function minimaxGenerateMusic(
  args: MinimaxMusicArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/music_generation`;
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    ...(args.lyrics ? { lyrics: args.lyrics } : {}),
    ...(args.format ? { format: args.format } : {}),
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
    throw new Error(`MiniMax 音乐生成接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as MinimaxMusicResponse;
  checkMinimaxBaseResp(data.base_resp, "音乐生成");

  const base64 = data.data?.audio;
  if (base64) {
    return Buffer.from(base64, "base64");
  }

  const audioUrl = data.data?.audio_url;
  if (audioUrl) {
    return downloadHttpsUrl(audioUrl, signal);
  }

  throw new Error("MiniMax 音乐生成响应中既无 audio（base64）也无 audio_url");
}

// ── TTS 生成 ──────────────────────────────────────────────────────────────────

interface MinimaxTtsResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  audio_file?: string; // base64
  data?: {
    audio?: string; // 某些版本把 audio 放在 data 下
  };
}

/**
 * 调用 MiniMax TTS 接口，返回音频二进制 Buffer。
 */
export async function minimaxGenerateTts(
  args: MinimaxTtsArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/t2a_v2`;
  const body: Record<string, unknown> = {
    model: args.model,
    text: args.text,
    ...(args.voice ? { voice_id: args.voice } : {}),
    ...(args.speed !== undefined ? { speed: args.speed } : {}),
    ...(args.format ? { audio_setting: { format: args.format } } : {}),
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
    throw new Error(`MiniMax TTS 接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as MinimaxTtsResponse;
  checkMinimaxBaseResp(data.base_resp, "TTS 生成");

  const base64 = data.audio_file ?? data.data?.audio;
  if (base64) {
    return Buffer.from(base64, "base64");
  }

  throw new Error("MiniMax TTS 响应中无 audio_file 字段（base64）");
}

// ── 内部辅助 ──────────────────────────────────────────────────────────────────

/**
 * 检查 MiniMax 通用 base_resp 状态码。
 * status_code !== 0 时抛出带诊断信息的 Error。
 */
function checkMinimaxBaseResp(
  baseResp: { status_code?: number; status_msg?: string } | undefined,
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

/**
 * 从 HTTPS URL 下载二进制数据。
 */
async function downloadHttpsUrl(url: string, signal?: AbortSignal): Promise<Buffer> {
  if (!url.startsWith("https://")) {
    throw new Error(`下载 URL 必须为 https://，当前: ${url}`);
  }
  const res = await fetch(url, { ...(signal ? { signal } : {}) });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * 可取消的延迟（AbortSignal 触发时提前 reject）。
 *
 * 预中止检测（ADV-007）：若 signal 在调用时已处于 aborted 状态，
 * abort 事件不会再次触发（事件已过），定时器会跑满整个 pollInterval。
 * 因此必须在注册监听前先检查 signal.aborted，提前 reject。
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  // 若 signal 已中止，立即 reject，不等待定时器。
  if (signal.aborted) {
    return Promise.reject(new Error("已中止"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("延迟被取消（AbortSignal）"));
    }, { once: true });
  });
}
