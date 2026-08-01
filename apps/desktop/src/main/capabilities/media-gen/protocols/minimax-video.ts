// MiniMax 视频生成协议实现（主进程，异步轮询）。
// 自原 minimax.ts 按模态拆出（纯移动，行为不变）；公共辅助改从 shared.ts 导入。
//
// 规格（KTD6，对齐 Kun MiniMaxVideoClient）：
//   1. POST {baseUrl}/v1/video_generation → 拿 task_id
//      （first_frame_image / last_frame_image 以 dataUri 随载荷上传，做首末帧引导）
//   2. 轮询 GET {baseUrl}/v1/query/video_generation?task_id={task_id}
//      直到 status==='Success'|'Fail' 或超时
//   3. 完成后 GET {baseUrl}/v1/files/retrieve?file_id={file_id} → download_url
//   4. 流式下载写盘

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToFile } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { checkMinimaxBaseResp, delay } from "./shared";

// ── 轮询参数 ──────────────────────────────────────────────────────────────────

/** 视频任务轮询间隔（ms），使用 config.pollIntervalMs 或此默认值。*/
const DEFAULT_POLL_INTERVAL_MS = 5_000;

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface MinimaxVideoArgs {
  prompt: string;
  model: string;
  /** 首帧图片 dataUri（client 层 collectFrameImage 已做边界/大小/魔数校验后产出）。*/
  firstFrameImage?: string;
  /** 尾帧图片 dataUri（同上）。*/
  lastFrameImage?: string;
  duration?: number;
  resolution?: string;
  /**
   * 视频产物绝对路径（调用方提前生成并经 workspace 边界校验）。
   * 视频最大 500MB，直接写盘避免整块 Buffer 进堆（KTD11 / ADV-006）。
   */
  destPath: string;
}

// ── 响应类型 ──────────────────────────────────────────────────────────────────

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
 * 调用 MiniMax 视频生成接口（异步轮询），将视频流式写入 args.destPath。
 *
 * 返回写入字节数（而非 Buffer）。视频最大 500MB，直接写盘避免整块响应进堆
 * （KTD11 / ADV-006）：边读边计数，超过 MAX_RESPONSE_BYTES.video 立即中止。
 */
export async function minimaxGenerateVideo(
  args: MinimaxVideoArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<number> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  // ── 1. 提交任务 ───────────────────────────────────────────────────────────
  const genBody: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    ...(args.duration ? { duration: args.duration } : {}),
    ...(args.resolution ? { resolution: args.resolution } : {}),
    // 首末帧引导：dataUri 直接进 JSON 载荷（对齐 Kun MiniMaxVideoClient 的 first/last_frame_image）。
    ...(args.firstFrameImage ? { first_frame_image: args.firstFrameImage } : {}),
    ...(args.lastFrameImage ? { last_frame_image: args.lastFrameImage } : {}),
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

  // ── 4. 流式下载视频并直接写盘（KTD11 / ADV-006）────────────────────────────
  // 视频最大 500MB，用 streamDownloadToFile 边读边计数，超限立即中止不进堆。
  return streamDownloadToFile(downloadUrl, {
    signal,
    maxBytes: MAX_RESPONSE_BYTES.video,
    destPath: args.destPath,
    modality: "video",
  });
}
