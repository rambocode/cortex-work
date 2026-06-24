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
import { generateImage, generateSpeech, generateMusic, generateVideo } from "./client";

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（见 mcp-config.isValidServerId）。
export const MEDIA_GEN_SERVER_ID = "cortex-media-gen";

// 媒体生成 MCP host 实例（独立 port/token，与浏览器/文档抽取互不干扰）。
const mediaGenHost = createMcpHost(MEDIA_GEN_SERVER_ID);

// ── sessionId → cwd 映射 ─────────────────────────────────────────────────────
// inject.ts 在构造注入配置时传入 (sessionId, cwd)，工具 handler 据此找到工作区根目录。
// cwd 穿透路径：cli.ts → buildMediaGenMcpServerConfig(cwd) → registerSession(sid, cwd)
// → 工具调用时 ctx.sessionId → sessionCwdMap.get(sid)。
// 无此映射则工具返回错误（cwd 未知不能落盘产物）。
const sessionCwdMap = new Map<string, string>();

export function registerMediaGenSession(sessionId: string, cwd: string): void {
  sessionCwdMap.set(sessionId, cwd);
}

export function unregisterMediaGenSession(sessionId: string): void {
  sessionCwdMap.delete(sessionId);
}

// ── 工具文本回包辅助 ─────────────────────────────────────────────────────────

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// ── 工具注册 ─────────────────────────────────────────────────────────────────

/**
 * 注册哪些模态工具由 inject.ts 的 enabledModalities 参数控制：
 * 只有 enabled 的模态才注册对应工具，避免 agent 拿到永远失败的工具。
 */
export function registerMediaGenTools(
  mcp: McpServer,
  ctx: ToolContext,
  enabledModalities: Set<"image" | "speech" | "music" | "video">,
): void {
  // ── generate_image ──────────────────────────────────────────────────────────
  if (enabledModalities.has("image")) {
    mcp.registerTool(
      "generate_image",
      {
        description:
          "根据文字描述生成图片，产物落盘 workspace/.cortex/media/images/，返回相对路径供引用。" +
          "支持参考图片（image_to_image）：提供 reference_image_paths 时进行图片变换/风格迁移。",
        inputSchema: {
          prompt: z.string().min(1).describe("图片生成描述（英文效果最佳）"),
          aspect_ratio: z.string().optional().describe("宽高比，例如 '1:1' '16:9' '4:3'（部分 provider 支持）"),
          image_size: z
            .string()
            .optional()
            .describe("图片尺寸，例如 '1024x1024' '512x512'（优先于 aspect_ratio）"),
          reference_image_paths: z
            .array(z.string())
            .optional()
            .describe("参考图片的绝对路径或相对 workspace 的路径（image-to-image）"),
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
        const workspaceRoot = ctx.sessionId ? sessionCwdMap.get(ctx.sessionId) : undefined;
        if (!workspaceRoot) {
          return text("generate_image 错误：无法确定工作区路径（sessionId 未注册）");
        }
        // 每次调用读最新设置，支持用户在会话中途改设置立即生效。
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return text(`generate_image 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.image.enabled) {
          return text("图片生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("image", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return text(`generate_image 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        try {
          const result = await generateImage(
            {
              prompt,
              size: image_size ?? aspect_ratio,
              referenceImagePaths: reference_image_paths,
            },
            resolvedConfig,
            { workspaceRoot },
          );
          const paths = result.files.map((f) => f.relativePath).join("\n");
          return text(
            `图片生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${paths}`,
          );
        } catch (e) {
          return text(`generate_image 失败：${e instanceof Error ? e.message : String(e)}`);
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
          "将文本转换为语音（TTS），产物落盘 workspace/.cortex/media/speech/，返回音频文件相对路径。",
        inputSchema: {
          text: z.string().min(1).describe("要合成为语音的文本内容"),
          voice: z.string().optional().describe("声音角色 ID（provider 相关，例如 'alloy' 'echo' 'nova'）"),
          format: z.string().optional().describe("音频格式，例如 'mp3' 'wav'（默认 mp3）"),
        },
      },
      async ({ text: inputText, voice, format }: { text: string; voice?: string; format?: string }) => {
        const workspaceRoot = ctx.sessionId ? sessionCwdMap.get(ctx.sessionId) : undefined;
        if (!workspaceRoot) {
          return text("generate_speech 错误：无法确定工作区路径（sessionId 未注册）");
        }
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return text(`generate_speech 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.speech.enabled) {
          return text("语音生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("speech", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return text(`generate_speech 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        // 将 format 参数注入 resolvedConfig（工具层 format 覆盖 config 层 format）。
        if (format) resolvedConfig = { ...resolvedConfig, format };
        try {
          const result = await generateSpeech(
            { prompt: inputText, voice },
            resolvedConfig,
            { workspaceRoot },
          );
          const paths = result.files.map((f) => f.relativePath).join("\n");
          return text(
            `语音生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${paths}`,
          );
        } catch (e) {
          return text(`generate_speech 失败：${e instanceof Error ? e.message : String(e)}`);
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
          "支持提供歌词（lyrics）生成带词歌曲，或设置 instrumental=true 生成纯器乐。",
        inputSchema: {
          prompt: z.string().min(1).describe("音乐风格/情绪描述，例如 'upbeat jazz with piano'"),
          lyrics: z.string().optional().describe("歌词内容（留空则生成纯器乐或 AI 自动创作歌词）"),
          instrumental: z
            .boolean()
            .optional()
            .describe("true = 强制纯器乐（无歌词），与 lyrics 互斥时以此为准"),
        },
      },
      async ({
        prompt,
        lyrics,
        instrumental,
      }: {
        prompt: string;
        lyrics?: string;
        instrumental?: boolean;
      }) => {
        const workspaceRoot = ctx.sessionId ? sessionCwdMap.get(ctx.sessionId) : undefined;
        if (!workspaceRoot) {
          return text("generate_music 错误：无法确定工作区路径（sessionId 未注册）");
        }
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return text(`generate_music 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.music.enabled) {
          return text("音乐生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("music", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return text(`generate_music 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        // instrumental 覆盖 lyrics：明确要纯器乐时清空歌词字段。
        const effectiveLyrics = instrumental ? undefined : lyrics;
        try {
          const result = await generateMusic(
            { prompt, lyrics: effectiveLyrics },
            resolvedConfig,
            { workspaceRoot },
          );
          const paths = result.files.map((f) => f.relativePath).join("\n");
          return text(
            `音乐生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${paths}`,
          );
        } catch (e) {
          return text(`generate_music 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }

  // ── generate_video ──────────────────────────────────────────────────────────
  if (enabledModalities.has("video")) {
    mcp.registerTool(
      "generate_video",
      {
        description:
          "根据文字描述生成视频，产物落盘 workspace/.cortex/media/video/，返回视频文件相对路径。" +
          "可提供首帧/尾帧图片控制视频开头/结尾画面。视频生成耗时较长（通常 30-180 秒）。",
        inputSchema: {
          prompt: z.string().min(1).describe("视频内容描述"),
          duration: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("视频时长（秒，provider 相关；通常 5-10 秒）"),
          resolution: z
            .string()
            .optional()
            .describe("分辨率，例如 '1280x720' '1920x1080'（provider 相关）"),
          first_frame_image_path: z
            .string()
            .optional()
            .describe("首帧参考图片路径（绝对路径或相对 workspace）"),
          last_frame_image_path: z
            .string()
            .optional()
            .describe("尾帧参考图片路径（绝对路径或相对 workspace）"),
        },
      },
      async ({
        prompt,
        duration,
        resolution,
        first_frame_image_path,
        last_frame_image_path,
      }: {
        prompt: string;
        duration?: number;
        resolution?: string;
        first_frame_image_path?: string;
        last_frame_image_path?: string;
      }) => {
        const workspaceRoot = ctx.sessionId ? sessionCwdMap.get(ctx.sessionId) : undefined;
        if (!workspaceRoot) {
          return text("generate_video 错误：无法确定工作区路径（sessionId 未注册）");
        }
        let state: Awaited<ReturnType<typeof getPersistedState>>;
        try {
          state = await getPersistedState();
        } catch (e) {
          return text(`generate_video 错误：读取配置失败 —— ${String(e)}`);
        }
        const mediaGenSettings = state.mediaGenSettings;
        const providerSettings = state.providerSettings;
        if (!mediaGenSettings?.video.enabled) {
          return text("视频生成工具已禁用，请在「设置 → 媒体生成」中启用。");
        }
        let resolvedConfig;
        try {
          resolvedConfig = resolveMediaGenSettings("video", mediaGenSettings, providerSettings ?? { providers: [] });
        } catch (e) {
          return text(`generate_video 配置错误：${e instanceof Error ? e.message : String(e)}`);
        }
        // 工具参数 duration/resolution 覆盖 resolvedConfig 的默认值。
        if (duration !== undefined) resolvedConfig = { ...resolvedConfig, defaultDuration: duration };
        if (resolution) resolvedConfig = { ...resolvedConfig, defaultResolution: resolution };
        try {
          const result = await generateVideo(
            {
              prompt,
              firstFrameImagePath: first_frame_image_path,
              lastFrameImagePath: last_frame_image_path,
            },
            resolvedConfig,
            { workspaceRoot },
          );
          const paths = result.files.map((f) => f.relativePath).join("\n");
          return text(
            `视频生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：\n${paths}`,
          );
        } catch (e) {
          return text(`generate_video 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }
}

// ── host 生命周期 ─────────────────────────────────────────────────────────────

/**
 * 启动媒体生成 MCP host（index.ts 在 whenReady 调用）。
 * enabledModalities 在首次 buildMediaGenMcpServerConfig 调用时确定，
 * 但 host 需要提前启动以获取 port/token；工具注册在 start 时通过 enabledModalities 闭包延迟绑定。
 * 注意：host 生命周期常驻（随 app），enabledModalities 由注入侧每次 buildMediaGenMcpServerConfig
 * 调用时按最新 settings 计算，通过 McpServer per-request 新建实例特性实现动态工具列表。
 */
export function startMediaGenHost(): Promise<McpHostHandle> {
  // registerTools 在每个 MCP 请求新建 McpServer 实例时调用，此时从 sessionCwdMap 取 cwd。
  // enabledModalities 在工具注册时从最新 inject 侧参数取（见 buildMediaGenMcpServerConfig）。
  // 因为 createMcpHost 的 makeServer 是 per-request 的，enabledModalities 需在 handler 里从外部取。
  // 解决方案：存一个可被 inject.ts 更新的全局 enabledModalities，handler 每次读取最新值。
  return mediaGenHost.start((mcp, ctx) => {
    registerMediaGenTools(mcp, ctx, currentEnabledModalities);
  });
}

export function stopMediaGenHost(): void {
  mediaGenHost.stop();
}

export function getMediaGenHostHandle(): McpHostHandle | null {
  return mediaGenHost.getHandle();
}

// 当前激活的模态集合，由 inject.ts 在每次 buildMediaGenMcpServerConfig 调用时更新。
// per-request McpServer 新建时读取此值，实现动态工具列表（settings 变更后新请求立即生效）。
let currentEnabledModalities: Set<"image" | "speech" | "music" | "video"> = new Set();

export function updateEnabledModalities(modalities: Set<"image" | "speech" | "music" | "video">): void {
  currentEnabledModalities = modalities;
}

// ── 注入配置构建 ──────────────────────────────────────────────────────────────

/**
 * 构建媒体生成 MCP server 的注入配置。
 *
 * gate 逻辑：
 *   - 四模态全 enabled:false → 返回 null（不注入，避免给 agent 一个无工具的 server）。
 *   - 至少一个 enabled → 注入，token 经 Authorization 头（不进 URL）。
 *
 * cwd 穿透：registerMediaGenSession 把 sessionId→cwd 映射存入 sessionCwdMap，
 * 工具 handler 在调用时据此找到工作区根目录。
 *
 * 本函数同时更新 currentEnabledModalities，使 per-request McpServer 注册时读到最新模态集。
 */
export function buildMediaGenMcpServerConfig(
  mediaGenSettings: import("../../ipc/types").MediaGenSettings | undefined,
  sessionId: string | undefined,
  cwd: string,
): McpServerConfig | null {
  // 计算本次激活的模态。
  const enabled: Set<"image" | "speech" | "music" | "video"> = new Set();
  if (mediaGenSettings?.image.enabled) enabled.add("image");
  if (mediaGenSettings?.speech.enabled) enabled.add("speech");
  if (mediaGenSettings?.music.enabled) enabled.add("music");
  if (mediaGenSettings?.video.enabled) enabled.add("video");

  // 四模态全关 → 不注入（OQ5 已决：全关返回 null）。
  if (enabled.size === 0) return null;

  // 更新全局模态集合，供 per-request 工具注册回调读取。
  updateEnabledModalities(enabled);

  const handle = getMediaGenHostHandle();
  // host 未起或不可用 → 不注入，避免 agent 连接失败。
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;

  // 注册 sessionId → cwd 映射，供工具 handler 定位工作区。
  if (sessionId) {
    registerMediaGenSession(sessionId, cwd);
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
