// 火山方舟（Volcengine Ark / Seedance）视频生成协议实现（主进程，异步轮询，
// 对齐 Kun VolcengineArkVideoClient）。
//
// 规格：
//   1. POST {baseUrl}/contents/generations/tasks（URL 经 volcengineArkVideoTasksUrl 规整，
//      容忍用户 baseUrl 已带完整路径）→ 拿任务 id
//      - 载荷为内容数组：text 项 + 可选 first_frame / last_frame 的 image_url 项（dataUri）
//      - duration 4-15s；resolution 480P/720P/1080P/4K（提交时转小写）
//      - aspect_ratio 走 ratio 字段，含 'adaptive'（由模型按内容自选比例，不传具体宽高比）
//   2. 轮询 GET {tasksUrl}/{id} 直到终态或超时
//      - 终态语义：'succeeded' 成功；'failed' | 'expired' | 'cancelled' | 'canceled' 失败
//        （失败时携带 error.code/message 诊断）；'queued' | 'running' 等继续轮询
//   3. 成功后双通道下载：优先 content.video_url 流式写盘；
//      无 URL 时回落 content.binary_data_base64（对齐 Ark 图片接口的 b64 返回约定）解码写盘

import { writeFile } from "node:fs/promises";

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToFile } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { delay, volcengineArkVideoTasksUrl } from "./shared";

// ── 轮询参数 ──────────────────────────────────────────────────────────────────

/** 视频任务轮询间隔（ms），使用 config.pollIntervalMs 或此默认值。*/
const DEFAULT_POLL_INTERVAL_MS = 5_000;

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface VolcengineArkVideoArgs {
  prompt: string;
  model: string;
  /** 首帧图片 dataUri（client 层 collectFrameImage 已做边界/大小/魔数校验后产出）。*/
  firstFrameImage?: string;
  /** 尾帧图片 dataUri（同上）。*/
  lastFrameImage?: string;
  /** 视频时长（秒，4-15，schema 层已约束）。*/
  duration?: number;
  /** 分辨率档位 '480P' | '720P' | '1080P' | '4K'（提交时转小写）。*/
  resolution?: string;
  /** 输出比例（含 'adaptive'——模型自选比例），进载荷的 ratio 字段。*/
  aspectRatio?: string;
  /**
   * 视频产物绝对路径（调用方提前生成并经 workspace 边界校验）。
   * 视频最大 500MB，URL 通道直接流式写盘避免整块 Buffer 进堆（KTD11 / ADV-006）。
   */
  destPath: string;
  /**
   * 状态更新回调。MCP 语境下无进度通道，默认 no-op；保留形参与 Kun VideoGenRequest
   * 同构，便于 diff 对照（计划 §3.3）。
   */
  onUpdate?: (update: { status: string; taskId: string }) => void;
}

// ── 载荷/响应类型（对齐 Kun VolcengineArkVideo* 类型） ─────────────────────────

type VolcengineArkVideoContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" };

interface VolcengineArkVideoCreateResponse {
  id?: string;
}

interface VolcengineArkVideoTaskResponse {
  status?: string; // 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled'
  content?: {
    video_url?: string;
    /** b64 通道：部分部署/模型直接内联返回 base64 视频（对齐 Ark 图片接口约定）。*/
    binary_data_base64?: string[];
  };
  error?: { code?: string; message?: string };
}

/**
 * 调用火山方舟 Seedance 视频生成接口（异步轮询），将视频写入 args.destPath。
 * 返回写入字节数（而非 Buffer）；两条下载通道均受 MAX_RESPONSE_BYTES.video 上限约束。
 */
export async function volcengineArkGenerateVideo(
  args: VolcengineArkVideoArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<number> {
  const tasksUrl = volcengineArkVideoTasksUrl(config.baseUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  // ── 1. 提交任务（内容数组载荷：text + 可选首末帧 image_url） ────────────────
  const content: VolcengineArkVideoContent[] = [{ type: "text", text: args.prompt }];
  if (args.firstFrameImage) {
    content.push({ type: "image_url", image_url: { url: args.firstFrameImage }, role: "first_frame" });
  }
  if (args.lastFrameImage) {
    content.push({ type: "image_url", image_url: { url: args.lastFrameImage }, role: "last_frame" });
  }

  const genBody: Record<string, unknown> = {
    model: args.model,
    content,
    // 对齐 Kun：默认带音频、不带水印。
    generate_audio: true,
    // ratio 字段承载 aspect_ratio；'adaptive' 表示由模型自选比例，原样透传。
    ...(args.aspectRatio ? { ratio: args.aspectRatio } : {}),
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    ...(args.resolution ? { resolution: args.resolution.toLowerCase() } : {}),
    watermark: false,
  };

  const genRes = await fetch(tasksUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(genBody),
    signal,
  });

  if (!genRes.ok) {
    const errorBody = await genRes.text().catch(() => "");
    throw new Error(`火山方舟视频生成提交失败 HTTP ${genRes.status}: ${errorBody.slice(0, 300)}`);
  }

  const genData = (await genRes.json()) as VolcengineArkVideoCreateResponse;
  const taskId = genData.id?.trim();
  if (!taskId) {
    throw new Error("火山方舟视频生成接口未返回任务 id");
  }
  args.onUpdate?.({ status: "submitted", taskId });

  // ── 2. 轮询任务状态 ───────────────────────────────────────────────────────
  const pollInterval = (config.pollIntervalMs as number | undefined) ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + config.timeoutMs;
  let lastStatus = "submitted";

  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(
        `火山方舟视频生成超时（task_id=${taskId}，timeoutMs=${config.timeoutMs}，最后状态=${lastStatus}）`,
      );
    }
    if (signal.aborted) {
      throw new Error("视频生成已取消（AbortSignal）");
    }

    await delay(pollInterval, signal);

    const pollRes = await fetch(`${tasksUrl}/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers,
      signal,
    });

    if (!pollRes.ok) {
      const errorBody = await pollRes.text().catch(() => "");
      throw new Error(`火山方舟视频状态查询失败 HTTP ${pollRes.status}: ${errorBody.slice(0, 200)}`);
    }

    const pollData = (await pollRes.json()) as VolcengineArkVideoTaskResponse;
    // 状态统一转小写判定（供应商大小写不保证；空状态沿用上一轮，对齐 Kun）。
    lastStatus = pollData.status?.trim().toLowerCase() || lastStatus;
    args.onUpdate?.({ status: lastStatus, taskId });

    // 失败终态：cancelled/canceled 双拼写都收（对齐 Kun），并透出 error 诊断。
    if (["failed", "expired", "cancelled", "canceled"].includes(lastStatus)) {
      const detail = pollData.error?.message?.trim() || pollData.error?.code?.trim();
      throw new Error(
        `火山方舟视频生成失败（task_id=${taskId}，status=${lastStatus}）${detail ? `: ${detail}` : ""}`,
      );
    }
    if (lastStatus !== "succeeded") continue; // queued / running 等非终态继续轮询

    // ── 3. 成功：双通道下载 ──────────────────────────────────────────────────
    // 优先 URL 通道（流式写盘，大视频不进堆）；无 URL 回落 b64 内联通道。
    const downloadUrl = pollData.content?.video_url?.trim();
    if (downloadUrl) {
      return streamDownloadToFile(downloadUrl, {
        signal,
        maxBytes: MAX_RESPONSE_BYTES.video,
        destPath: args.destPath,
        modality: "video",
      });
    }

    const b64 = pollData.content?.binary_data_base64?.[0];
    if (b64) {
      const buffer = Buffer.from(b64, "base64");
      // b64 通道无法边读边停，只能解码后校验上限（响应 JSON 本身已进内存，此处兜底防写超大文件）。
      if (buffer.byteLength > MAX_RESPONSE_BYTES.video) {
        throw new Error(
          `[video] 响应体超过大小限制（${buffer.byteLength} > ${MAX_RESPONSE_BYTES.video} bytes）`,
        );
      }
      await writeFile(args.destPath, buffer);
      return buffer.byteLength;
    }

    throw new Error(`火山方舟视频生成完成但既无 video_url 也无 b64 数据（task_id=${taskId}）`);
  }
}
