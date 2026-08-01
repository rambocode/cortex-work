// Grok Imagine 视频生成协议实现（主进程，异步轮询，对齐 Kun GrokImagineVideoClient）。
//
// 规格（api.x.ai）：
//   1. POST {baseUrl}/videos/generations → 拿 request_id
//      - duration 仅支持 6|10（秒），resolution 档位 480P/720P（提交时转小写）
//      - 首帧图生视频：image.url 传 dataUri；与 aspect_ratio 互斥——有首帧时比例由图片决定，
//        aspect_ratio 只在纯文生视频时进载荷（对齐 Kun 的三元分支）
//   2. 轮询 GET {baseUrl}/videos/{request_id} 直到终态或超时
//      - 终态语义：'done' 成功；'failed' | 'expired' 失败；其余状态（pending/generating…）继续轮询
//   3. 成功后从 video.url 流式下载写盘
//
// ⚠️ Grok Imagine **无末帧概念**：generate_video 的动态 schema 在 grok 协议下不生成
//    last_frame_image_path 字段，正常路径到不了这里；协议层仍防御性抛错（fail loudly），
//    防止未来 dispatch 改动把末帧静默丢弃、产出与用户预期不符的视频。

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToFile } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { delay, trimTrailingSlashes } from "./shared";

// ── 轮询参数 ──────────────────────────────────────────────────────────────────

/** 视频任务轮询间隔（ms），使用 config.pollIntervalMs 或此默认值。*/
const DEFAULT_POLL_INTERVAL_MS = 5_000;

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface GrokImagineVideoArgs {
  prompt: string;
  model: string;
  /** 首帧图片 dataUri（client 层 collectFrameImage 已做边界/大小/魔数校验后产出）。*/
  firstFrameImage?: string;
  /** Grok 无末帧概念：schema 层已挡；此处收到即抛错（防御性，见文件头注释）。*/
  lastFrameImage?: string;
  /** 视频时长（秒），仅 6|10（schema 层已约束，协议层不重复校验，对齐 Kun）。*/
  duration?: number;
  /** 分辨率档位 '480P' | '720P'（提交时转小写）。*/
  resolution?: string;
  /** 文生视频输出比例（有首帧时被忽略，不进载荷）。*/
  aspectRatio?: string;
  /**
   * 视频产物绝对路径（调用方提前生成并经 workspace 边界校验）。
   * 视频最大 500MB，直接写盘避免整块 Buffer 进堆（KTD11 / ADV-006）。
   */
  destPath: string;
  /**
   * 状态更新回调。MCP 语境下无进度通道，默认 no-op；保留形参与 Kun VideoGenRequest
   * 同构，便于 diff 对照（计划 §3.3）。
   */
  onUpdate?: (update: { status: string; taskId: string }) => void;
}

// ── 响应类型（对齐 Kun GrokVideoCreatePayload / GrokVideoPollPayload） ─────────

interface GrokVideoCreateResponse {
  request_id?: string;
}

interface GrokVideoPollResponse {
  status?: string; // 'pending' | 'generating' | 'done' | 'failed' | 'expired'（大小写不保证，统一转小写判定）
  video?: { url?: string };
}

/**
 * 调用 Grok Imagine 视频生成接口（异步轮询），将视频流式写入 args.destPath。
 * 返回写入字节数（而非 Buffer），下载超过 MAX_RESPONSE_BYTES.video 立即中止。
 */
export async function grokImagineGenerateVideo(
  args: GrokImagineVideoArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<number> {
  // 防御性红线：末帧不应到达本协议层（schema 已挡），到达说明上游 dispatch 有误。
  if (args.lastFrameImage) {
    throw new Error("Grok Imagine 视频不支持末帧图片（last_frame），请移除该参数或改用其它协议");
  }

  const rootUrl = trimTrailingSlashes(config.baseUrl.trim());
  // headers 透传：对齐 Kun 构造函数的 extraHeaders 形参——config 若带自定义 headers
  // （如网关鉴权头）则并入；Authorization/Content-Type 始终在后覆盖，不可被透传项顶掉。
  const extraHeaders = (config.headers as Record<string, string> | undefined) ?? {};
  const headers: Record<string, string> = {
    ...extraHeaders,
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  // ── 1. 提交任务 ───────────────────────────────────────────────────────────
  const genBody: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    ...(args.resolution ? { resolution: args.resolution.toLowerCase() } : {}),
    // 首帧与 aspect_ratio 互斥（对齐 Kun）：有首帧时比例随图片，aspect_ratio 不进载荷。
    ...(args.firstFrameImage
      ? { image: { url: args.firstFrameImage } }
      : args.aspectRatio
        ? { aspect_ratio: args.aspectRatio }
        : {}),
    reference_images: [],
  };

  const genRes = await fetch(`${rootUrl}/videos/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify(genBody),
    signal,
  });

  if (!genRes.ok) {
    const errorBody = await genRes.text().catch(() => "");
    throw new Error(`Grok Imagine 视频生成提交失败 HTTP ${genRes.status}: ${errorBody.slice(0, 300)}`);
  }

  const genData = (await genRes.json()) as GrokVideoCreateResponse;
  const requestId = genData.request_id?.trim();
  if (!requestId) {
    throw new Error("Grok Imagine 视频生成接口未返回 request_id");
  }
  args.onUpdate?.({ status: "submitted", taskId: requestId });

  // ── 2. 轮询任务状态 ───────────────────────────────────────────────────────
  const pollInterval = (config.pollIntervalMs as number | undefined) ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + config.timeoutMs;
  let lastStatus = "submitted";

  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Grok Imagine 视频生成超时（request_id=${requestId}，timeoutMs=${config.timeoutMs}，最后状态=${lastStatus}）`,
      );
    }
    if (signal.aborted) {
      throw new Error("视频生成已取消（AbortSignal）");
    }

    await delay(pollInterval, signal);

    const pollRes = await fetch(`${rootUrl}/videos/${encodeURIComponent(requestId)}`, {
      method: "GET",
      headers,
      signal,
    });

    if (!pollRes.ok) {
      const errorBody = await pollRes.text().catch(() => "");
      throw new Error(`Grok Imagine 视频状态查询失败 HTTP ${pollRes.status}: ${errorBody.slice(0, 200)}`);
    }

    const pollData = (await pollRes.json()) as GrokVideoPollResponse;
    // 状态统一转小写判定（供应商大小写不保证；空状态沿用上一轮，对齐 Kun）。
    lastStatus = pollData.status?.trim().toLowerCase() || lastStatus;
    args.onUpdate?.({ status: lastStatus, taskId: requestId });

    if (lastStatus === "failed" || lastStatus === "expired") {
      throw new Error(`Grok Imagine 视频生成失败（request_id=${requestId}，status=${lastStatus}）`);
    }
    if (lastStatus !== "done") continue; // pending / generating 等非终态继续轮询

    // ── 3. 成功：流式下载写盘（KTD11 / ADV-006） ─────────────────────────────
    const downloadUrl = pollData.video?.url?.trim();
    if (!downloadUrl) {
      throw new Error(`Grok Imagine 视频生成完成但未返回下载 URL（request_id=${requestId}）`);
    }
    return streamDownloadToFile(downloadUrl, {
      signal,
      maxBytes: MAX_RESPONSE_BYTES.video,
      destPath: args.destPath,
      modality: "video",
    });
  }
}
