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

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as pathResolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

import type { ResolvedMediaGenConfig } from "./resolve";
import { openaiImagesGenerate } from "./protocols/openai-images";
import { minimaxGenerateImage } from "./protocols/minimax-image";
import { grokImagineGenerateImage } from "./protocols/grok-imagine-image";
import { volcengineArkGenerateImage } from "./protocols/volcengine-ark-image";
import { minimaxGenerateMusic, minimaxGenerateTts } from "./protocols/minimax-audio";
import { minimaxGenerateVideo } from "./protocols/minimax-video";
import { dataUri, detectImageMime, mapImageSize, protocolSupportsImageEdit } from "./protocols/shared";

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
  /** 视频/图片宽高比（grok/volcengine 协议消费；波次 1 实装透传）。*/
  aspectRatio?: string;
  // 音频（TTS）特有
  voice?: string;
  speed?: number;
  /** 语音风格指令（MiMo 等支持的供应商消费；波次 1 实装透传）。*/
  style?: string;
  // 音乐特有
  lyrics?: string;
  /** 纯器乐（无人声）。*/
  instrumental?: boolean;
  /** 让供应商生成/润色歌词（MiniMax lyrics_optimizer；波次 1 实装透传）。*/
  lyricsOptimizer?: boolean;
  /** 翻唱/参考音频公网 URL（MiniMax audio_url；波次 1 实装透传）。*/
  referenceAudioUrl?: string;
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

// ── 音频格式白名单（安全 + 正确 mimeType） ───────────────────────────────────
//
// Agent 提供的 format 参数直接作为文件扩展名拼入路径，若不做校验则可能遭路径穿越攻击
// （例如 format='../../etc/passwd'）。此白名单只允许已知音频扩展名，非白名单回落 'mp3'。
// mimeType 映射确保落盘文件的 MIME 类型正确（而非一律 audio/mpeg）。

// 白名单为「Kun AUDIO_FORMATS ∪ 既有扩展名」并集：pcm/pcm16 → audio/L16（未压缩 PCM）。
export const AUDIO_EXT_WHITELIST = ["mp3", "wav", "ogg", "flac", "m4a", "aac", "pcm", "pcm16"] as const;
type AudioExt = (typeof AUDIO_EXT_WHITELIST)[number];

const AUDIO_MIME_MAP: Record<AudioExt, string> = {
  mp3:  "audio/mpeg",
  wav:  "audio/wav",
  ogg:  "audio/ogg",
  flac: "audio/flac",
  m4a:  "audio/mp4",
  aac:  "audio/mp4",
  pcm:  "audio/L16",
  pcm16: "audio/L16",
};

/**
 * 将 Agent 提供的 format 字符串规范化为安全扩展名与对应 mimeType。
 * 非白名单值一律回落到 'mp3'（防路径穿越 + 未知格式兜底）。
 * pcm16 的文件扩展名归一为 'pcm'（对齐 Kun audioExtension——pcm16 只是位深标注，
 * 落盘扩展名与 pcm 相同）。
 */
export function resolveAudioFormat(format: string | undefined): { ext: AudioExt; mimeType: string } {
  const lower = format?.toLowerCase() ?? "";
  if ((AUDIO_EXT_WHITELIST as readonly string[]).includes(lower)) {
    const fmt = lower as AudioExt;
    const ext = fmt === "pcm16" ? "pcm" : fmt;
    return { ext, mimeType: AUDIO_MIME_MAP[fmt] };
  }
  return { ext: "mp3", mimeType: AUDIO_MIME_MAP.mp3 };
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

/**
 * lexical 校验 + realpath 复核（防 symlink 逃逸/竞态），返回符号链接展开后的绝对路径。
 *
 * 为什么 lexical 校验不够：workspace 内一个指向外部（如 ~/.ssh）的 symlink，
 * lexical 上仍在 workspace 内——读侧会把任意文件读进 dataUri 外发给第三方 API，
 * 写侧（media 目录被替换成 symlink）会把产物写出 workspace。因此读/写两侧都必须
 * 经本函数二次复核；写侧还需在 mkdir 之后再调一次（对齐 Kun 的双重检查——
 * mkdir 与 writeFile 之间目录可能被并发替换为 symlink）。
 *
 * target 不存在时（写路径的新文件名），对其最近存在的祖先做 realpath，
 * 再拼回剩余段（lexical 已归一化，剩余段不含 ".."）。
 */
export async function assertRealWithinWorkspace(
  workspaceRoot: string,
  inputPath: string,
): Promise<string> {
  // 第一道：lexical（同步、无 IO），先挡掉明显的 ../ 与绝对路径越界。
  const lexical = assertWithinWorkspace(workspaceRoot, inputPath);

  // workspaceRoot 自身也要展开（根目录本身可能是 symlink，如 macOS /tmp → /private/tmp）。
  let realRoot: string;
  try {
    realRoot = await realpath(pathResolve(workspaceRoot));
  } catch {
    // 根目录不存在（测试/异常场景）：退回 lexical 根，后续比较仍然成立。
    realRoot = pathResolve(workspaceRoot);
  }

  // target 或其最近存在祖先做 realpath，展开路径中所有 symlink。
  let probe = lexical;
  const pendingSegments: string[] = [];
  let expanded: string;
  for (;;) {
    try {
      expanded = await realpath(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        // 已到文件系统根仍不存在：无 symlink 可展开，用 lexical 结果。
        expanded = probe;
        break;
      }
      pendingSegments.push(basename(probe));
      probe = parent;
    }
  }
  while (pendingSegments.length > 0) {
    expanded = join(expanded, pendingSegments.pop()!);
  }

  if (expanded !== realRoot && !expanded.startsWith(realRoot + sep)) {
    throw new Error(
      `路径越界: "${inputPath}" 经符号链接解析后不在 workspace 内（${workspaceRoot}）`,
    );
  }
  return expanded;
}

// ── 参考图/帧图收集（≤10MB + 魔数校验 → dataUri，供协议客户端上传） ───────────

export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
/** 参考图数量上限（对齐 Kun maxReferenceImages 默认值；v1 不做可配置）。*/
export const MAX_REFERENCE_IMAGES = 4;

export interface CollectedImage {
  name: string;
  mimeType: string;
  data: Buffer;
  /** data:{mime};base64,… 形态，协议客户端可直接塞进 JSON 载荷。*/
  dataUri: string;
}

/**
 * 读取并校验参考图片集合：workspace 边界（含 symlink 复核）→ ≤10MB → png/jpeg/webp 魔数。
 * 任一失败即抛错（fail loudly，不静默跳过）；返回带 dataUri 的图片列表。
 */
export async function collectReferenceImages(
  workspaceRoot: string,
  paths: string[] | undefined,
  maxCount: number = MAX_REFERENCE_IMAGES,
): Promise<CollectedImage[]> {
  if (!paths || paths.length === 0) return [];
  const trimmed = paths.filter((p) => typeof p === "string" && p.trim().length > 0);
  if (trimmed.length > maxCount) {
    throw new Error(`参考图片最多 ${maxCount} 张（收到 ${trimmed.length} 张）`);
  }
  const images: CollectedImage[] = [];
  for (const rawPath of trimmed) {
    images.push(await readWorkspaceImage(workspaceRoot, rawPath, "参考图片"));
  }
  return images;
}

/**
 * 读取并校验单张首/尾帧图片（视频协议用）；path 为空返回 undefined。
 */
export async function collectFrameImage(
  workspaceRoot: string,
  path: string | undefined,
  fieldName: string,
): Promise<CollectedImage | undefined> {
  if (!path || !path.trim()) return undefined;
  return readWorkspaceImage(workspaceRoot, path.trim(), fieldName);
}

/** 参考图/帧图共用读取管线：边界校验 → 读取 → 大小 → 魔数。*/
async function readWorkspaceImage(
  workspaceRoot: string,
  rawPath: string,
  fieldName: string,
): Promise<CollectedImage> {
  // 读侧必须走 realpath 复核：symlink 可把 workspace 外任意文件伪装进来。
  const resolved = await assertRealWithinWorkspace(workspaceRoot, rawPath);
  let data: Buffer;
  try {
    data = await readFile(resolved);
  } catch {
    throw new Error(`${fieldName}不存在或不可读: ${rawPath}`);
  }
  if (data.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`${fieldName}超过 ${MAX_REFERENCE_IMAGE_BYTES} 字节上限: ${rawPath}`);
  }
  const mimeType = detectImageMime(data);
  if (!mimeType) {
    throw new Error(`${fieldName}必须是 png/jpeg/webp 格式（按魔数校验）: ${rawPath}`);
  }
  return {
    name: rawPath.split("/").pop() || "reference.png",
    mimeType,
    data,
    dataUri: dataUri(mimeType, data),
  };
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

  // mkdir 后二次复核（对齐 Kun 双重检查）：已存在的 media 目录 symlink 是最常见的
  // 逃逸路径——mkdir recursive 对已有 symlink 目录静默成功，若不复核会把产物写出 workspace。
  const realDir = await assertRealWithinWorkspace(workspaceRoot, dir);

  const fileName = generateFileName(ext);
  const absolutePath = join(realDir, fileName);
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
 * 支持协议：openai-images、minimax-image、grok-imagine-image、volcengine-ark-image。
 */
export async function generateImage(
  args: GenerateMediaArgs,
  resolvedConfig: ResolvedMediaGenConfig,
  ctx: { workspaceRoot: string; signal?: AbortSignal },
): Promise<GenerateMediaResult> {
  const startTs = Date.now();
  const { workspaceRoot } = ctx;
  const protocol = resolvedConfig.protocol;

  // 参考图收集：workspace 边界（lexical + realpath 双重检查）→ ≤10MB → 魔数校验，
  // 返回带二进制的图片列表供协议客户端上传（FormData / dataUri）。
  const references = await collectReferenceImages(
    workspaceRoot,
    args.referenceImagePaths,
    (resolvedConfig.maxReferenceImages as number | undefined) ?? MAX_REFERENCE_IMAGES,
  );

  // edits 门控（防御纵深）：MCP 层已按运行时协议拦截，但 workflow/直调路径不经过
  // MCP handler，这里必须在任何网络调用前再拦一次——不支持真编辑的协议（minimax
  // 的 subject_reference 是角色保持、grok 无编辑端点）静默产出一张全新（错误）的
  // 图比报错更糟，报错后调用方可去掉参考图重试。
  if (references.length > 0 && !protocolSupportsImageEdit(protocol)) {
    throw new Error(
      "edits_unsupported：当前图片协议不支持参考图编辑（其参考图能力是角色/身份保持" +
      "而非忠实编辑）；请去掉 referenceImagePaths 重试。",
    );
  }

  // 尺寸决策（优先级：工具入参 > defaultSize > defaultResolution，经 mapImageSize）：
  // MCP 层已映射并经 args.size 传入；此兜底服务 workflow 等未映射的调用方。
  // defaultResolution 缺失（旧 resolve 路径未透传）时回落 "auto"——无比例则不上送
  // 尺寸、交给供应商默认，保持旧行为不强加 1K。
  const mappedSize =
    args.size ??
    mapImageSize(
      args.aspectRatio,
      undefined,
      (resolvedConfig.defaultSize as string | undefined) || undefined,
      (resolvedConfig.defaultResolution as "auto" | "1K" | "2K" | "3K" | "4K" | undefined) ?? "auto",
    );
  const size = mappedSize === "auto" ? undefined : mappedSize;
  // 画质档（openai-images 协议消费；'auto' 在协议层不上送）。
  const quality = resolvedConfig.quality as string | undefined;

  // 超时 AbortController（KTD8）
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), resolvedConfig.timeoutMs);
  const signal = ctx.signal
    ? mergeSignals([ctx.signal, abortCtrl.signal])
    : abortCtrl.signal;

  try {
    let buffer: Buffer;

    if (protocol === "openai-images") {
      // 参考图非空时协议内部自动切 /images/edits（FormData）。
      buffer = await openaiImagesGenerate(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          size,
          quality,
          referenceImages: references,
        },
        resolvedConfig,
        signal,
      );
    } else if (protocol === "minimax-image") {
      buffer = await minimaxGenerateImage(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          size,
          aspectRatio: args.aspectRatio,
        },
        resolvedConfig,
        signal,
      );
    } else if (protocol === "grok-imagine-image") {
      buffer = await grokImagineGenerateImage(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          size,
          aspectRatio: args.aspectRatio,
        },
        resolvedConfig,
        signal,
      );
    } else if (protocol === "volcengine-ark-image") {
      // 方舟图生图与文生图同端点（image dataUri 数组），参考图直接透传。
      buffer = await volcengineArkGenerateImage(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          size,
          referenceImages: references,
        },
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
    const rawFormat = (resolvedConfig.format as string | undefined) ?? "mp3";
    // 白名单校验：防止 Agent 提供的 format 含路径穿越字符，非白名单回落 mp3。
    const { ext, mimeType } = resolveAudioFormat(rawFormat);

    if (protocol === "openai-speech") {
      buffer = await openaiSpeechGenerate(
        {
          text: args.prompt,
          model: resolvedConfig.model,
          voice: args.voice ?? (resolvedConfig.voice as string | undefined),
          speed: args.speed,
          format: ext,
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
          format: ext,
        },
        resolvedConfig,
        signal,
      );
    } else {
      throw new Error(`不支持的语音生成协议: ${protocol}`);
    }

    assertResponseSize(buffer, MAX_RESPONSE_BYTES.speech, "speech");

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
    const rawFormat = (resolvedConfig.format as string | undefined) ?? "mp3";
    // 白名单校验：防止 Agent 提供的 format 含路径穿越字符，非白名单回落 mp3。
    const { ext, mimeType } = resolveAudioFormat(rawFormat);

    if (protocol === "minimax-music") {
      buffer = await minimaxGenerateMusic(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          lyrics: args.lyrics,
          format: ext,
        },
        resolvedConfig,
        signal,
      );
    } else {
      throw new Error(`不支持的音乐生成协议: ${protocol}`);
    }

    assertResponseSize(buffer, MAX_RESPONSE_BYTES.music, "music");

    const file = await saveToWorkspace(workspaceRoot, "music", buffer, ext, mimeType);
    return { files: [file], model: resolvedConfig.model, durationMs: Date.now() - startTs };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── 视频生成 ──────────────────────────────────────────────────────────────────

/**
 * 生成视频，产物落盘 {workspaceRoot}/.cortex/media/video/。
 * 支持协议：minimax-video（grok/volcengine 波次 1 实装）。
 */
export async function generateVideo(
  args: GenerateMediaArgs,
  resolvedConfig: ResolvedMediaGenConfig,
  ctx: { workspaceRoot: string; signal?: AbortSignal },
): Promise<GenerateMediaResult> {
  const startTs = Date.now();
  const { workspaceRoot } = ctx;

  // 安全校验：帧图片路径（lexical + realpath 双重检查，防 symlink 把外部文件读进上传）。
  const safeFirstFrame = args.firstFrameImagePath
    ? await assertRealWithinWorkspace(workspaceRoot, args.firstFrameImagePath)
    : undefined;
  const safeLastFrame = args.lastFrameImagePath
    ? await assertRealWithinWorkspace(workspaceRoot, args.lastFrameImagePath)
    : undefined;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), resolvedConfig.timeoutMs);
  const signal = ctx.signal
    ? mergeSignals([ctx.signal, abortCtrl.signal])
    : abortCtrl.signal;

  try {
    const protocol = resolvedConfig.protocol;

    if (protocol === "minimax-video") {
      // 视频最大 500MB，提前生成落盘路径，协议函数直接流式写盘，不经过 Buffer（KTD11 / ADV-006）。
      const dir = mediaDir(workspaceRoot, "video");
      await mkdir(dir, { recursive: true });
      // mkdir 后二次复核（同 saveToWorkspace）：防已存在的 media 目录 symlink 把视频写出 workspace。
      const realDir = await assertRealWithinWorkspace(workspaceRoot, dir);
      const fileName = generateFileName("mp4");
      const absolutePath = join(realDir, fileName);
      const relativePath = `.cortex/media/video/${fileName}`;

      const byteSize = await minimaxGenerateVideo(
        {
          prompt: args.prompt,
          model: resolvedConfig.model,
          firstFrameImagePath: safeFirstFrame,
          lastFrameImagePath: safeLastFrame,
          duration: resolvedConfig.defaultDuration as number | undefined,
          resolution: resolvedConfig.defaultResolution as string | undefined,
          destPath: absolutePath,
        },
        resolvedConfig,
        signal,
      );

      const file: GeneratedFile = {
        relativePath,
        absolutePath,
        mimeType: "video/mp4",
        byteSize,
      };
      return { files: [file], model: resolvedConfig.model, durationMs: Date.now() - startTs };
    } else if (protocol === "grok-imagine-video" || protocol === "volcengine-ark-video") {
      // 骨架占位：协议已进枚举/目录，客户端由波次 1（WP4）实装。fail loudly 防静默误路由。
      throw new Error(`协议客户端未实现: ${protocol}（该协议将在后续版本提供，请暂换其它协议）`);
    } else {
      throw new Error(`不支持的视频生成协议: ${protocol}`);
    }
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

  // 语音响应直接是二进制流（非 JSON），使用 streamDownloadToBuffer 流式读取（KTD11 / ADV-006）：
  // 边读边计数，超过 MAX_RESPONSE_BYTES.speech（200MB）时立即中止，不等全量进堆。
  if (!res.body) {
    throw new Error("OpenAI Speech 响应缺少 body（ReadableStream）");
  }
  // 复用 streamDownloadToBuffer 的 drainStream 逻辑；此处 URL 已消耗，直接读 res.body
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES.speech) {
        await reader.cancel();
        throw new Error(
          `[speech] 响应体超过大小限制（已读 ${bytesRead} > ${MAX_RESPONSE_BYTES.speech} bytes），下载已中止`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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
