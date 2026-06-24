// 媒体生成客户端（主进程）。
// 提供四模态生成函数：generateImage / generateSpeech / generateMusic / generateVideo。
//
// 设计原则：
//   - 生成结果落盘到 {workspaceRoot}/.cortex/media/{modality}/
//   - 文件名：{timestamp}-{randomId}.{ext}
//   - 主进程发网络，renderer 不直连（与 probeProvider 等既有模式一致）
//   - 各模态独立 AbortController + timeoutMs（KTD8）
//   - 所有 Agent 提供路径在读写前必须过 assertWithinWorkspace（KTD11）
//   - 响应体大小受 MAX_RESPONSE_BYTES 限制（KTD11）

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as pathResolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

import type { ResolvedMediaGenConfig } from "./resolve";
import { openaiImagesGenerate } from "./protocols/openai-images";
import {
  minimaxGenerateImage,
  minimaxGenerateVideo,
  minimaxGenerateMusic,
  minimaxGenerateTts,
} from "./protocols/minimax";

// ── 响应体大小限制（KTD11） ────────────────────────────────────────────────────

export const MAX_RESPONSE_BYTES: Record<"image" | "speech" | "music" | "video", number> = {
  image: 50 * 1024 * 1024,    // 50MB
  speech: 200 * 1024 * 1024,  // 200MB
  music: 200 * 1024 * 1024,   // 200MB
  video: 500 * 1024 * 1024,   // 500MB
};

// ── 参数与返回类型 ────────────────────────────────────────────────────────────

export interface GenerateMediaArgs {
  prompt: string;
  // 图片特有
  size?: string;
  /** Agent 传入的参考图片路径（相对 workspaceRoot 或绝对）。*/
  referenceImagePaths?: string[];
  // 视频特有
  firstFrameImagePath?: string;
  lastFrameImagePath?: string;
  // 音频（TTS）特有
  voice?: string;
  speed?: number;
  // 音乐特有
  lyrics?: string;
}

export interface GeneratedFile {
  /** 相对 workspaceRoot 的路径，供 Agent 引用。*/
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  byteSize: number;
}

export interface GenerateMediaResult {
  files: GeneratedFile[];
  model: string;
  durationMs: number;
}

// ── 安全收口（KTD11） ─────────────────────────────────────────────────────────

/**
 * 断言 inputPath 解析后落在 workspaceRoot 内，返回解析后的绝对路径。
 * 防止 Agent 提供的路径越界（路径遍历攻击）。
 */
export function assertWithinWorkspace(workspaceRoot: string, inputPath: string): string {
  const resolvedRoot = pathResolve(workspaceRoot);
  const resolvedPath = pathResolve(workspaceRoot, inputPath);
  // 必须是 workspaceRoot 本身或其子路径
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(resolvedRoot + sep)
  ) {
    throw new Error(`路径越界: "${inputPath}" 不在 workspace 内（${workspaceRoot}）`);
  }
  return resolvedPath;
}

// ── 产物目录 ───────────────────────────────────────────────────────────────────

function mediaDir(workspaceRoot: string, modality: "images" | "speech" | "music" | "video"): string {
  return join(workspaceRoot, ".cortex", "media", modality);
}

// ── 文件名生成 ─────────────────────────────────────────────────────────────────

function generateFileName(ext: string): string {
  const ts = Date.now();
  const id = randomBytes(4).toString("hex");
  return `${ts}-${id}.${ext}`;
}

// ── 通用：落盘并构造返回值 ────────────────────────────────────────────────────

async function saveToWorkspace(
  workspaceRoot: string,
  modality: "images" | "speech" | "music" | "video",
  buffer: Buffer,
  ext: string,
  mimeType: string,
): Promise<GeneratedFile> {
  const dir = mediaDir(workspaceRoot, modality);
  await mkdir(dir, { recursive: true });

  const fileName = generateFileName(ext);
  const absolutePath = join(dir, fileName);
  await writeFile(absolutePath, buffer);

  // 相对路径（相对 workspaceRoot）
  const relativePath = `.cortex/media/${modality}/${fileName}`;

  return {
    relativePath,
    absolutePath,
    mimeType,
    byteSize: buffer.byteLength,
  };
}

// ── 通用：检查 buffer 大小 ─────────────────────────────────────────────────────

function assertResponseSize(buffer: Buffer, maxBytes: number, modality: string): void {
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `[${modality}] 响应体超过大小限制（${buffer.byteLength} > ${maxBytes} bytes）`,
    );
  }
}

// ── 图片生成 ──────────────────────────────────────────────────────────────────

/**
 * 生成图片，产物落盘 {workspaceRoot}/.cortex/media/images/。
 * 支持协议：openai-images、minimax-image。
 */
export async function generateImage(
  args: GenerateMediaArgs,
  resolvedConfig: ResolvedMediaGenConfig,
  ctx: { workspaceRoot: string; signal?: AbortSignal },
): Promise<GenerateMediaResult> {
  const startTs = Date.now();
  const { workspaceRoot } = ctx;

  // 安全校验：参考图片路径
  const safeRefPaths = args.referenceImagePaths?.map((p) =>
    assertWithinWorkspace(workspaceRoot, p),
  );

  // 超时 AbortController（KTD8）
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), resolvedConfig.timeoutMs);
  const signal = ctx.signal
    ? mergeSignals([ctx.signal, abortCtrl.signal])
    : abortCtrl.signal;

  try {
    let buffer: Buffer;
    const protocol = resolvedConfig.protocol;

    if (protocol === "openai-images") {
      buffer = await openaiImagesGenerate(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          size: args.size ?? (resolvedConfig.defaultSize as string | undefined),
          referenceImagePaths: safeRefPaths,
        },
        resolvedConfig,
        signal,
      );
    } else if (protocol === "minimax-image") {
      buffer = await minimaxGenerateImage(
        { prompt: args.prompt, model: resolvedConfig.model },
        resolvedConfig,
        signal,
      );
    } else {
      throw new Error(`不支持的图片生成协议: ${protocol}`);
    }

    assertResponseSize(buffer, MAX_RESPONSE_BYTES.image, "image");

    const file = await saveToWorkspace(workspaceRoot, "images", buffer, "png", "image/png");
    return { files: [file], model: resolvedConfig.model, durationMs: Date.now() - startTs };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── 语音生成（TTS） ────────────────────────────────────────────────────────────

/**
 * 生成语音，产物落盘 {workspaceRoot}/.cortex/media/speech/。
 * 支持协议：openai-speech、minimax-t2a、mimo-tts。
 */
export async function generateSpeech(
  args: GenerateMediaArgs,
  resolvedConfig: ResolvedMediaGenConfig,
  ctx: { workspaceRoot: string; signal?: AbortSignal },
): Promise<GenerateMediaResult> {
  const startTs = Date.now();
  const { workspaceRoot } = ctx;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), resolvedConfig.timeoutMs);
  const signal = ctx.signal
    ? mergeSignals([ctx.signal, abortCtrl.signal])
    : abortCtrl.signal;

  try {
    let buffer: Buffer;
    const protocol = resolvedConfig.protocol;
    const format = (resolvedConfig.format as string | undefined) ?? "mp3";

    if (protocol === "openai-speech") {
      buffer = await openaiSpeechGenerate(
        {
          text: args.prompt,
          model: resolvedConfig.model,
          voice: args.voice ?? (resolvedConfig.voice as string | undefined),
          speed: args.speed,
          format,
        },
        resolvedConfig,
        signal,
      );
    } else if (protocol === "minimax-t2a" || protocol === "mimo-tts") {
      buffer = await minimaxGenerateTts(
        {
          text: args.prompt,
          model: resolvedConfig.model,
          voice: args.voice ?? (resolvedConfig.voice as string | undefined),
          speed: args.speed,
          format,
        },
        resolvedConfig,
        signal,
      );
    } else {
      throw new Error(`不支持的语音生成协议: ${protocol}`);
    }

    assertResponseSize(buffer, MAX_RESPONSE_BYTES.speech, "speech");

    const ext = format || "mp3";
    const mimeType = ext === "wav" ? "audio/wav" : "audio/mpeg";
    const file = await saveToWorkspace(workspaceRoot, "speech", buffer, ext, mimeType);
    return { files: [file], model: resolvedConfig.model, durationMs: Date.now() - startTs };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── 音乐生成 ──────────────────────────────────────────────────────────────────

/**
 * 生成音乐，产物落盘 {workspaceRoot}/.cortex/media/music/。
 * 支持协议：minimax-music。
 */
export async function generateMusic(
  args: GenerateMediaArgs,
  resolvedConfig: ResolvedMediaGenConfig,
  ctx: { workspaceRoot: string; signal?: AbortSignal },
): Promise<GenerateMediaResult> {
  const startTs = Date.now();
  const { workspaceRoot } = ctx;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), resolvedConfig.timeoutMs);
  const signal = ctx.signal
    ? mergeSignals([ctx.signal, abortCtrl.signal])
    : abortCtrl.signal;

  try {
    let buffer: Buffer;
    const protocol = resolvedConfig.protocol;
    const format = (resolvedConfig.format as string | undefined) ?? "mp3";

    if (protocol === "minimax-music") {
      buffer = await minimaxGenerateMusic(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          lyrics: args.lyrics,
          format,
        },
        resolvedConfig,
        signal,
      );
    } else {
      throw new Error(`不支持的音乐生成协议: ${protocol}`);
    }

    assertResponseSize(buffer, MAX_RESPONSE_BYTES.music, "music");

    const ext = format || "mp3";
    const mimeType = "audio/mpeg";
    const file = await saveToWorkspace(workspaceRoot, "music", buffer, ext, mimeType);
    return { files: [file], model: resolvedConfig.model, durationMs: Date.now() - startTs };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── 视频生成 ──────────────────────────────────────────────────────────────────

/**
 * 生成视频，产物落盘 {workspaceRoot}/.cortex/media/video/。
 * 支持协议：minimax-video。
 */
export async function generateVideo(
  args: GenerateMediaArgs,
  resolvedConfig: ResolvedMediaGenConfig,
  ctx: { workspaceRoot: string; signal?: AbortSignal },
): Promise<GenerateMediaResult> {
  const startTs = Date.now();
  const { workspaceRoot } = ctx;

  // 安全校验：帧图片路径
  const safeFirstFrame = args.firstFrameImagePath
    ? assertWithinWorkspace(workspaceRoot, args.firstFrameImagePath)
    : undefined;
  const safeLastFrame = args.lastFrameImagePath
    ? assertWithinWorkspace(workspaceRoot, args.lastFrameImagePath)
    : undefined;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), resolvedConfig.timeoutMs);
  const signal = ctx.signal
    ? mergeSignals([ctx.signal, abortCtrl.signal])
    : abortCtrl.signal;

  try {
    let buffer: Buffer;
    const protocol = resolvedConfig.protocol;

    if (protocol === "minimax-video") {
      buffer = await minimaxGenerateVideo(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          firstFrameImagePath: safeFirstFrame,
          lastFrameImagePath: safeLastFrame,
          duration: resolvedConfig.defaultDuration as number | undefined,
          resolution: resolvedConfig.defaultResolution as string | undefined,
        },
        resolvedConfig,
        signal,
      );
    } else {
      throw new Error(`不支持的视频生成协议: ${protocol}`);
    }

    assertResponseSize(buffer, MAX_RESPONSE_BYTES.video, "video");

    const file = await saveToWorkspace(workspaceRoot, "video", buffer, "mp4", "video/mp4");
    return { files: [file], model: resolvedConfig.model, durationMs: Date.now() - startTs };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── OpenAI Speech（在线 TTS）内部实现 ─────────────────────────────────────────

interface OpenAISpeechArgs {
  text: string;
  model: string;
  voice?: string;
  speed?: number;
  format?: string;
}

/**
 * 调用 OpenAI 兼容 /v1/audio/speech 接口。
 */
async function openaiSpeechGenerate(
  args: OpenAISpeechArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/audio/speech`;
  const body: Record<string, unknown> = {
    model: args.model,
    input: args.text,
    ...(args.voice ? { voice: args.voice } : {}),
    ...(args.speed !== undefined ? { speed: args.speed } : {}),
    ...(args.format ? { response_format: args.format } : {}),
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
    throw new Error(`OpenAI Speech 接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── AbortSignal 合并（两个信号任一触发则整体 abort） ─────────────────────────

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      ctrl.abort();
      return ctrl.signal;
    }
    sig.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
