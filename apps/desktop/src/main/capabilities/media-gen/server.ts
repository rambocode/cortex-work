// 媒体生成 MCP server（U5）：注册 generate_image / generate_speech / generate_music /
// generate_video 四工具，供 claude/codex agent 在会话中调用。
//
// 架构复用：经 createMcpHost 工厂（doc-extract 同款），各工具 handler 在主进程内调 U4 client，
// 无状态 Streamable HTTP，每请求按 X-Cortex-Session 头注入的 sessionId 关联工作区 cwd。
//
// 工具禁用策略：每次调用时从 getPersistedState() 读最新设置 → resolveMediaGenSettings。
// 若该模态 enabled 为 false 则返回可读错误（不 throw），兼顾用户改设置后立即生效的体验。
//
// 看门狗：各工具超时由 U4 client 的 timeoutMs + AbortController 覆盖（<300s），
// 本层不叠加 cli:keepalive（OQ1/KTD8 已决）。

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle, type ToolContext } from "../mcp-host/server";
import type { McpServerConfig } from "../../ipc/types";
import { getPersistedState } from "../../ipc/store";
import { resolveMediaGenSettings } from "./resolve";
import { generateImage, generateSpeech, generateMusic, generateVideo, MAX_REFERENCE_IMAGES } from "./client";
import {
  AUDIO_FORMATS,
  COMMON_ASPECT_RATIOS,
  DEFAULT_IMAGE_SIZE_TIERS,
  GROK_IMAGINE_ASPECT_RATIOS,
  GROK_VIDEO_ASPECT_RATIOS,
  GROK_VIDEO_DURATIONS,
  GROK_VIDEO_RESOLUTIONS,
  MINIMAX_VIDEO_RESOLUTIONS,
  VOLCENGINE_IMAGE_SIZE_TIERS,
  VOLCENGINE_VIDEO_ASPECT_RATIOS,
  VOLCENGINE_VIDEO_RESOLUTIONS,
  mapImageSize,
  protocolSupportsImageEdit,
} from "./protocols/shared";

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（见 mcp-config.isValidServerId）。
export const MEDIA_GEN_SERVER_ID = "cortex-media-gen";

// 媒体生成 MCP host 实例（独立 port/token，与浏览器/文档抽取互不干扰）。
const mediaGenHost = createMcpHost(MEDIA_GEN_SERVER_ID);

// ── 并发会话状态（session-scoped，解决多会话竞态） ─────────────────────────────
//
// 并发约定：token 是 host 级共享，但 cwd 与激活模态集均为 per-session 的。
// 多个并发 session 各自调用 buildMediaGenMcpServerConfig（不同 cwd/modalities），
// 必须按 sessionId 存储，而非用单一全局 Set 覆盖——后者会导致后来的 session 覆盖
// 前一 session 的模态集，使早期 session 的 per-request McpServer 拿到错误工具集。
//
// per-request McpServer 注册时从 sessionStateMap.get(ctx.sessionId) 取本 session 状态；
// host 级 token 仍共享（认证），session 级状态独立（工具集 + cwd）。

type Modality = "image" | "speech" | "music" | "video";

interface SessionState {
  cwd: string;
  modalities: Set<Modality>;
  /**
   * 注入时快照的「模态→协议」映射，驱动四工具的动态 schema（枚举档位按协议出/隐字段）。
   * 快照语义与 modalities 相同：**滞后一轮**——buildMediaGenMcpServerConfig 注入时从
   * settings 冻结，会话中途改协议要下一轮注入才更新 schema；handler 每次调用仍读最新
   * 设置做 enabled gate 与配置解析，运行期正确性不依赖 schema。
   */
  protocols: Partial<Record<Modality, string>>;
}

const sessionStateMap = new Map<string, SessionState>();

export function registerMediaGenSession(
  sessionId: string,
  cwd: string,
  modalities: Set<Modality>,
  protocols: Partial<Record<Modality, string>> = {},
): void {
  // 幂等：同一 session 多轮 run 时用新 cwd/modalities/protocols 刷新（同会话 cwd 不变，
  // 但 modalities/protocols 可能随设置更改而变化）；清理时调 unregisterMediaGenSession。
  sessionStateMap.set(sessionId, { cwd, modalities, protocols });
}

export function unregisterMediaGenSession(sessionId: string): void {
  sessionStateMap.delete(sessionId);
}

// ── 构造结构化工具结果（文本 + resource 产物，供 agent 程序化提取路径） ──────────
//
// agent-native 要求：工具产物除可读文本外，须追加 resource 类型条目，
// 让 agent 能从 content 数组中程序化提取文件 URI 和 mimeType，而不必解析自由文本。
function makeSuccessResult(
  description: string,
  files: { absolutePath: string; relativePath: string; mimeType: string }[],
): { content: Array<{ type: "text"; text: string } | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }> } {
  const content: Array<
    { type: "text"; text: string } |
    { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  > = [{ type: "text", text: description }];

  for (const f of files) {
    content.push({
      type: "resource",
      resource: {
        uri: `file://${f.absolutePath}`,
        mimeType: f.mimeType,
        text: f.relativePath,
      },
    });
  }

  return { content };
}

// 工具失败时返回带 isError 标志的结果，让 agent 程序化判断失败态。
function makeErrorResult(message: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── 工具注册 ─────────────────────────────────────────────────────────────────

/**
 * 注册哪些模态工具由 per-session 的 modalities 参数控制：
 * 只有 enabled 的模态才注册对应工具，避免 agent 拿到永远失败的工具。
 *
 * 并发安全：此函数在 per-request McpServer 新建时调用（非全局单例），
 * enabledModalities/protocols 参数来自 sessionStateMap.get(ctx.sessionId)，
 * 保证每个 session 读取自己的模态集与协议快照，互不干扰。
 *
 * 动态 schema：四工具的枚举档位/字段增减按 protocols 快照构造（对齐 Kun）——
 * schema 滞后一轮（注入时冻结），运行期正确性由 handler 每次调用读最新设置保证。
 */
export function registerMediaGenTools(
  mcp: McpServer,
  ctx: ToolContext,
  enabledModalities: Set<Modality>,
  protocols: Partial<Record<Modality, string>> = {},
): void {
  // ── generate_image ──────────────────────────────────────────────────────────
  if (enabledModalities.has("image")) {
    // 协议快照缺失（旧注册路径/异常）时按默认协议 openai-images 构造 schema。
    const imageProtocol = protocols.image ?? "openai-images";
    const isGrokImage = imageProtocol === "grok-imagine-image";
    const isVolcImage = imageProtocol === "volcengine-ark-image";
    const supportsEdit = protocolSupportsImageEdit(imageProtocol);
    // 分辨率档位：火山 Seedream 只吃 2K/3K/4K，其余协议 1K/2K（Kun 同款特化）。
    const imageSizeTiers = isVolcImage ? VOLCENGINE_IMAGE_SIZE_TIERS : DEFAULT_IMAGE_SIZE_TIERS;
    const imageAspectRatios = isGrokImage ? GROK_IMAGINE_ASPECT_RATIOS : COMMON_ASPECT_RATIOS;
    mcp.registerTool(
      "generate_image",
      {
        description:
          "根据文字描述生成图片，产物落盘 workspace/.cortex/media/images/，返回相对路径供引用。" +
          "每次调用生成一张图；要变体请再次调用。画质档位由设置自动应用，与分辨率相互独立。" +
          (supportsEdit
            ? "可传 reference_image_paths（workspace 内图片）做图生图编辑。"
            : "当前协议不支持参考图编辑（图生图）。"),
        inputSchema: {
          prompt: z.string().min(1).describe("图片生成描述（英文效果最佳）"),
          aspect_ratio: z
            .enum(imageAspectRatios as unknown as [string, ...string[]])
            .optional()
            .describe("可选输出宽高比；改变比例但保持所选/默认分辨率档"),
          image_size: z
            .enum(imageSizeTiers as unknown as [string, ...string[]])
            .optional()
            .describe(
              `可选分辨率档覆盖（${imageSizeTiers.join("/")}）。仅在用户显式要求时设置，` +
              "否则省略以使用设置里的默认分辨率。分辨率与画质相互独立。",
            ),
          // reference_image_paths 仅在协议具备真编辑通道（edit-allowlist）时进 schema；
          // 不支持的协议连字段都不出现，模型不会尝试参考图编辑。
          ...(supportsEdit
            ? {
                reference_image_paths: z
                  .array(z.string())
                  .max(MAX_REFERENCE_IMAGES)
                  .optional()
                  .describe("参考图片路径（workspace 内，png/jpeg/webp，≤10MB，用于图生图编辑）"),
              }
            : {}),
        },
      },
      async ({
        prompt,
        aspect_ratio,
        image_size,
        reference_image_paths,
      }: {
        prompt: string;
        aspect_ratio?: string;
        image_size?: string;
        reference_image_paths?: string[];
      }) => {
        // 从 per-session 状态获取 cwd，避免跨 session 数据泄漏。
        const sessionState = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
        const workspaceRoot = sessionState?.cwd;
        if (!workspaceRoot) {
          return makeErrorResult("generate_image 错误：无法确定工作区路径（sessionId 未注册）");
        }
        // 每次调用读最新设置，支持用户在会话中途改设置立即生效。
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return makeErrorResult(`generate_image 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.image.enabled) {
          return makeErrorResult("图片生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("image", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return makeErrorResult(`generate_image 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        // 编辑门控按**运行时**协议判定（schema 快照可能滞后）：不支持真编辑的协议
        // 收到参考图必须在任何网络调用前 fail loudly——静默产出一张全新（错误）的图
        // 比报错更糟，报错后 agent 可去掉参考图重试。
        if (
          reference_image_paths &&
          reference_image_paths.length > 0 &&
          !protocolSupportsImageEdit(resolvedConfig.protocol)
        ) {
          return makeErrorResult(
            "generate_image 失败（edits_unsupported）：当前图片协议不支持参考图编辑" +
            "（其参考图能力是角色/身份保持而非忠实编辑）；请去掉 reference_image_paths 重试。",
          );
        }
        // 尺寸决策统一走 mapImageSize（工具入参 > defaultSize > defaultResolution），
        // 废除旧的「image_size ?? aspect_ratio 混塞进 size」做法。
        const mappedSize = mapImageSize(
          aspect_ratio,
          image_size,
          (resolvedConfig.defaultSize as string | undefined) || undefined,
          (resolvedConfig.defaultResolution as "auto" | "1K" | "2K" | "3K" | "4K" | undefined) ?? "1K",
        );
        try {
          const result = await generateImage(
            {
              prompt,
              // "auto" 表示交给供应商决定，不传具体尺寸。
              size: mappedSize === "auto" ? undefined : mappedSize,
              aspectRatio: aspect_ratio,
              referenceImagePaths: reference_image_paths,
            },
            resolvedConfig,
            { workspaceRoot },
          );
          const description = `图片生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${result.files.map((f) => f.relativePath).join("\n")}`;
          return makeSuccessResult(description, result.files);
        } catch (e) {
          return makeErrorResult(`generate_image 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }

  // ── generate_speech ─────────────────────────────────────────────────────────
  if (enabledModalities.has("speech")) {
    mcp.registerTool(
      "generate_speech",
      {
        description:
          "将文本转换为语音（TTS），产物落盘 workspace/.cortex/media/speech/，返回音频文件相对路径。" +
          "voice 为供应商声音 ID；style 为语音风格指令（支持的供应商如 Xiaomi MiMo 时使用）。",
        inputSchema: {
          text: z.string().min(1).describe("要合成为语音的文本内容"),
          voice: z.string().optional().describe("声音角色 ID（provider 相关，例如 'alloy' 'echo' 'nova'）"),
          style: z.string().optional().describe("可选语音风格指令（支持该能力的供应商生效）"),
          format: z
            .enum(AUDIO_FORMATS as unknown as [string, ...string[]])
            .optional()
            .describe("音频格式（默认 mp3）"),
        },
      },
      async ({ text: inputText, voice, style, format }: { text: string; voice?: string; style?: string; format?: string }) => {
        const sessionState = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
        const workspaceRoot = sessionState?.cwd;
        if (!workspaceRoot) {
          return makeErrorResult("generate_speech 错误：无法确定工作区路径（sessionId 未注册）");
        }
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return makeErrorResult(`generate_speech 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.speech.enabled) {
          return makeErrorResult("语音生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("speech", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return makeErrorResult(`generate_speech 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        // 将 format 参数注入 resolvedConfig（工具层 format 覆盖 config 层 format）。
        if (format) resolvedConfig = { ...resolvedConfig, format };
        try {
          const result = await generateSpeech(
            // style 透传到 client args（协议客户端按需消费；波次 1 实装）。
            { prompt: inputText, voice, style },
            resolvedConfig,
            { workspaceRoot },
          );
          const description = `语音生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${result.files.map((f) => f.relativePath).join("\n")}`;
          return makeSuccessResult(description, result.files);
        } catch (e) {
          return makeErrorResult(`generate_speech 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }

  // ── generate_music ──────────────────────────────────────────────────────────
  if (enabledModalities.has("music")) {
    mcp.registerTool(
      "generate_music",
      {
        description:
          "根据描述生成音乐，产物落盘 workspace/.cortex/media/music/，返回音频文件相对路径。" +
          "提供 prompt（风格/意图）、lyrics（带词歌曲）或 instrumental=true（纯器乐）三者至少其一。",
        inputSchema: {
          // 三选一约束（prompt / lyrics / instrumental）在 handler 校验——prompt 不再必填。
          prompt: z.string().optional().describe("音乐风格/情绪/编曲描述，例如 'upbeat jazz with piano'"),
          lyrics: z.string().optional().describe("歌词内容（留空则生成纯器乐或 AI 自动创作歌词）"),
          instrumental: z
            .boolean()
            .optional()
            .describe("true = 强制纯器乐（无歌词），与 lyrics 互斥时以此为准"),
          lyrics_optimizer: z
            .boolean()
            .optional()
            .describe("让供应商生成或润色歌词（支持该能力的供应商生效）"),
          reference_audio_url: z
            .string()
            .optional()
            .describe("可选翻唱/参考音频的公网 URL（支持该能力的供应商生效）"),
          format: z
            .enum(AUDIO_FORMATS as unknown as [string, ...string[]])
            .optional()
            .describe("音频格式（默认 mp3）"),
        },
      },
      async ({
        prompt,
        lyrics,
        instrumental,
        lyrics_optimizer,
        reference_audio_url,
        format,
      }: {
        prompt?: string;
        lyrics?: string;
        instrumental?: boolean;
        lyrics_optimizer?: boolean;
        reference_audio_url?: string;
        format?: string;
      }) => {
        // 三选一校验（对齐 Kun）：什么都不给无法定义一首歌，尽早给出参数错误。
        if (!prompt?.trim() && !lyrics?.trim() && instrumental !== true) {
          return makeErrorResult(
            "generate_music 参数错误：请至少提供 prompt、lyrics 或 instrumental=true 之一。",
          );
        }
        const sessionState = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
        const workspaceRoot = sessionState?.cwd;
        if (!workspaceRoot) {
          return makeErrorResult("generate_music 错误：无法确定工作区路径（sessionId 未注册）");
        }
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return makeErrorResult(`generate_music 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.music.enabled) {
          return makeErrorResult("音乐生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("music", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return makeErrorResult(`generate_music 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        // instrumental 覆盖 lyrics：明确要纯器乐时清空歌词字段。
        const effectiveLyrics = instrumental ? undefined : lyrics;
        // 工具层 format 覆盖 config 层 format（同 generate_speech）。
        if (format) resolvedConfig = { ...resolvedConfig, format };
        try {
          const result = await generateMusic(
            // lyricsOptimizer/referenceAudioUrl 透传到 client args（协议客户端波次 1 消费）。
            {
              prompt: prompt ?? "",
              lyrics: effectiveLyrics,
              instrumental,
              lyricsOptimizer: lyrics_optimizer,
              referenceAudioUrl: reference_audio_url,
            },
            resolvedConfig,
            { workspaceRoot },
          );
          const description = `音乐生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${result.files.map((f) => f.relativePath).join("\n")}`;
          return makeSuccessResult(description, result.files);
        } catch (e) {
          return makeErrorResult(`generate_music 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }

  // ── generate_video ──────────────────────────────────────────────────────────
  if (enabledModalities.has("video")) {
    // 按协议快照定制档位（对齐 Kun）：
    //   minimax   duration 1-30s、768P/1080P、无 aspect_ratio；
    //   grok      duration 只 6|10、480P/720P、有 aspect_ratio、**无末帧概念**；
    //   volcengine duration 4-15s、480P-4K、有 aspect_ratio（含 adaptive）。
    const videoProtocol = protocols.video ?? "minimax-video";
    const isGrokVideo = videoProtocol === "grok-imagine-video";
    const isVolcVideo = videoProtocol === "volcengine-ark-video";
    const videoResolutions = isGrokVideo
      ? GROK_VIDEO_RESOLUTIONS
      : isVolcVideo
        ? VOLCENGINE_VIDEO_RESOLUTIONS
        : MINIMAX_VIDEO_RESOLUTIONS;
    const durationSchema = isGrokVideo
      ? z.union([z.literal(GROK_VIDEO_DURATIONS[0]), z.literal(GROK_VIDEO_DURATIONS[1])])
          .optional()
          .describe(`视频时长（秒，仅支持 ${GROK_VIDEO_DURATIONS.join(" 或 ")}）`)
      : z
          .number()
          .int()
          .min(isVolcVideo ? 4 : 1)
          .max(isVolcVideo ? 15 : 30)
          .optional()
          .describe(`视频时长（秒，${isVolcVideo ? "4-15" : "1-30"}）`);
    mcp.registerTool(
      "generate_video",
      {
        description:
          "根据文字描述生成视频，产物落盘 workspace/.cortex/media/video/，返回视频文件相对路径。" +
          (isGrokVideo
            ? "可提供首帧图片做图生视频引导（该协议无末帧概念）。"
            : "可提供首帧/尾帧图片控制视频开头/结尾画面。") +
          "视频生成耗时较长（数分钟级）。",
        inputSchema: {
          prompt: z.string().min(1).describe("视频内容描述"),
          duration: durationSchema,
          resolution: z
            .enum(videoResolutions as unknown as [string, ...string[]])
            .optional()
            .describe(`分辨率档位（${videoResolutions.join("/")}）`),
          // aspect_ratio 仅 grok/volcengine 协议进 schema（minimax 接口无此参数）。
          ...(isGrokVideo || isVolcVideo
            ? {
                aspect_ratio: z
                  .enum(
                    (isVolcVideo
                      ? VOLCENGINE_VIDEO_ASPECT_RATIOS
                      : GROK_VIDEO_ASPECT_RATIOS) as unknown as [string, ...string[]],
                  )
                  .optional()
                  .describe(
                    isVolcVideo
                      ? "可选输出比例；adaptive 由模型自行选择"
                      : "可选文生视频输出比例",
                  ),
              }
            : {}),
          first_frame_image_path: z
            .string()
            .optional()
            .describe("首帧参考图片路径（workspace 内 png/jpeg/webp）"),
          // grok 无末帧概念：字段不进 schema。
          ...(!isGrokVideo
            ? {
                last_frame_image_path: z
                  .string()
                  .optional()
                  .describe("尾帧参考图片路径（workspace 内 png/jpeg/webp）"),
              }
            : {}),
        },
      },
      async ({
        prompt,
        duration,
        resolution,
        aspect_ratio,
        first_frame_image_path,
        last_frame_image_path,
      }: {
        prompt: string;
        duration?: number;
        resolution?: string;
        aspect_ratio?: string;
        first_frame_image_path?: string;
        last_frame_image_path?: string;
      }) => {
        const sessionState = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
        const workspaceRoot = sessionState?.cwd;
        if (!workspaceRoot) {
          return makeErrorResult("generate_video 错误：无法确定工作区路径（sessionId 未注册）");
        }
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return makeErrorResult(`generate_video 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.video.enabled) {
          return makeErrorResult("视频生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("video", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return makeErrorResult(`generate_video 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        // 工具参数 duration/resolution 覆盖 resolvedConfig 的默认值。
        if (duration !== undefined) resolvedConfig = { ...resolvedConfig, defaultDuration: duration };
        if (resolution) resolvedConfig = { ...resolvedConfig, defaultResolution: resolution };
        try {
          const result = await generateVideo(
            // aspectRatio 透传到 client args（grok/volcengine 协议客户端波次 1 消费）。
            {
              prompt,
              aspectRatio: aspect_ratio,
              firstFrameImagePath: first_frame_image_path,
              lastFrameImagePath: last_frame_image_path,
            },
            resolvedConfig,
            { workspaceRoot },
          );
          const description = `视频生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${result.files.map((f) => f.relativePath).join("\n")}`;
          return makeSuccessResult(description, result.files);
        } catch (e) {
          return makeErrorResult(`generate_video 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }
}

// ── host 生命周期 ─────────────────────────────────────────────────────────────

/**
 * 启动媒体生成 MCP host（index.ts 在 whenReady 调用）。
 *
 * per-request McpServer 在每次 HTTP 请求时新建，注册回调从 sessionStateMap 取本 session 的
 * modalities；cwd 同样按 sessionId 查取，确保并发 session 互不干扰。
 */
export function startMediaGenHost(): Promise<McpHostHandle> {
  return mediaGenHost.start((mcp, ctx) => {
    // 从 per-session 状态取本 session 的模态集与协议快照（并发安全：各 session 独立）。
    const sessionState = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
    const modalities = sessionState?.modalities ?? new Set<Modality>();
    registerMediaGenTools(mcp, ctx, modalities, sessionState?.protocols ?? {});
  });
}

export function stopMediaGenHost(): void {
  mediaGenHost.stop();
}

export function getMediaGenHostHandle(): McpHostHandle | null {
  return mediaGenHost.getHandle();
}

// ── 注入配置构建 ──────────────────────────────────────────────────────────────

/**
 * 构建媒体生成 MCP server 的注入配置。
 *
 * gate 逻辑：
 *   - 四模态全 enabled:false → 返回 null（不注入，避免给 agent 一个无工具的 server）。
 *   - 至少一个 enabled → 注入，token 经 Authorization 头（不进 URL）。
 *
 * 并发安全：本函数把 (sessionId → {cwd, modalities}) 存入 sessionStateMap，
 * 而非写全局变量。多个并发 session 各自持有独立状态，per-request McpServer 按
 * ctx.sessionId 查取本 session 的模态集与 cwd，不会互相覆盖。
 */
export function buildMediaGenMcpServerConfig(
  mediaGenSettings: import("../../ipc/types").MediaGenSettings | undefined,
  sessionId: string | undefined,
  cwd: string,
): McpServerConfig | null {
  // 计算本次激活的模态。
  const enabled: Set<Modality> = new Set();
  if (mediaGenSettings?.image.enabled) enabled.add("image");
  if (mediaGenSettings?.speech.enabled) enabled.add("speech");
  if (mediaGenSettings?.music.enabled) enabled.add("music");
  if (mediaGenSettings?.video.enabled) enabled.add("video");

  // 四模态全关 → 不注入（OQ5 已决：全关返回 null）。
  if (enabled.size === 0) return null;

  const handle = getMediaGenHostHandle();
  // host 未起或不可用 → 不注入，避免 agent 连接失败。
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;

  // 协议快照：注入时从 settings 冻结（滞后一轮，与 modalities 同语义）——
  // per-request McpServer 的注册回调是同步的，无法在注册时异步读设置，
  // 故在此把「模态→协议」一并存进 SessionState 供动态 schema 使用。
  const protocols: Partial<Record<Modality, string>> = {};
  if (mediaGenSettings?.image.enabled) protocols.image = mediaGenSettings.image.protocol;
  if (mediaGenSettings?.speech.enabled) protocols.speech = mediaGenSettings.speech.protocol;
  if (mediaGenSettings?.music.enabled) protocols.music = mediaGenSettings.music.protocol;
  if (mediaGenSettings?.video.enabled) protocols.video = mediaGenSettings.video.protocol;

  // 注册 per-session 状态（cwd + modalities + protocols）。
  // 幂等：同一 session 多轮 run 时覆盖写（cwd 通常不变，modalities/protocols 随设置更新），
  // 不影响同 session 下一轮继续使用；清理由 unregisterMediaGenSession 负责。
  if (sessionId) {
    registerMediaGenSession(sessionId, cwd, enabled, protocols);
  }

  return {
    id: MEDIA_GEN_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      ...(sessionId ? { "X-Cortex-Session": sessionId } : {}),
    },
  };
}
