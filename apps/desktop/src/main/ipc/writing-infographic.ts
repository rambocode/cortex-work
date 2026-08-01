// 写作信息图生成(U7)IPC 域:选区文本 → Kun 默认信息图提示词 → 对接 media-gen 生成 PNG →
// 落 <spaceRoot>/img/infographic-<ts>.png,返回落盘绝对路径;渲染端复用 U1 relativeImageLink 换算插链。
//
// 复用而非移植:cortex capabilities/media-gen 已有 openai-images / minimax-image 协议客户端与配置解析,
// 本域只做「选区→提示词→生成→落盘」编排 + Kun 的提示词模板(仅 infographic kind,design 见计划 Scope)。
// 落盘目标与粘贴图片共用空间根 img/ 目录(WRITING_IMAGE_DIR,对齐 Kun WORKSPACE_IMAGE_DIR)。
//
// 跨进程契约:writing:infographic(invoke)↔ WritingInfographicRequest/Result;
//             writing:infographicAvailable(invoke)→ boolean(media-gen 图片模态未配置则 false,渲染端隐藏入口)。
// 核心逻辑抽为纯函数(buildWritingInfographicPrompt / isWritingInfographicConfigured / runWritingInfographic)
// 便于就近单测;store/fs 依赖在 handler 内动态 import 注入(保持模块图轻、单测无需拉 electron/store/fs)。

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ipcMain } from "electron";
import type { MediaGenSettings, ProviderSettings } from "@cortex-work/core/desktop/types";
import { resolveMediaGenSettings, type ResolvedMediaGenConfig } from "../capabilities/media-gen/resolve";
import { openaiImagesGenerate } from "../capabilities/media-gen/protocols/openai-images";
// minimax 协议已按模态拆分（minimax-image / minimax-audio / minimax-video），图片段在 minimax-image。
import { minimaxGenerateImage } from "../capabilities/media-gen/protocols/minimax-image";
import { MAX_RESPONSE_BYTES } from "../capabilities/media-gen/client";
import type { WritingInfographicRequest, WritingInfographicResult } from "./writing-infographic-types";

// 选区正文进提示词前的最大字符数(对齐 Kun WRITE_INFOGRAPHIC_MAX_TEXT_CHARS):防超长选区撑爆提示词。
export const WRITING_INFOGRAPHIC_MAX_TEXT_CHARS = 6_000;

// 与 fs.ts WRITING_IMAGE_DIR 对齐:信息图与粘贴图片共用空间根下的 img/ 子目录(Kun WORKSPACE_IMAGE_DIR)。
// 本处独立声明(不 import fs.ts)是为避免把 electron/store/fs 依赖图拖进纯函数单测。
const WRITING_IMAGE_DIR = "img";

// Kun 默认信息图提示词前缀(逐字移植 WRITE_INFOGRAPHIC_DEFAULT_PROMPT):约束产出为成品信息图海报,
// 而非设备照 / 应用截图;选中正文追加在其后。本轮只做 infographic 一种(design 稿见计划 Scope)。
export const WRITING_INFOGRAPHIC_DEFAULT_PROMPT = [
  "Create a polished infographic poster from the source content below.",
  "Goal: produce a finished information graphic, not a photo of devices, not an app screenshot.",
  "Composition: portrait canvas, light background, clear headline at the top, 3-5 grouped sections, simple icons, compact charts or cards, generous spacing.",
  "Text: use the source language, keep labels short and readable, summarize instead of copying long paragraphs, avoid tiny unreadable text.",
  "Style: modern editorial vector design, restrained accent colors, crisp lines, high contrast, clean typography.",
  "Source content:",
].join("\n");

// 提示词构造(纯函数):去空白 → 截断到上限 → 默认前缀 + 空行 + 选中正文。导出供就近单测(截断边界)。
export function buildWritingInfographicPrompt(text: string): string {
  const clipped = text.trim().slice(0, WRITING_INFOGRAPHIC_MAX_TEXT_CHARS);
  return `${WRITING_INFOGRAPHIC_DEFAULT_PROMPT}\n\n${clipped}`;
}

// media-gen 图片模态是否已配置(对齐 Kun isWriteInfographicConfigured):enabled 且 baseUrl/apiKey/model
// 可被 resolveMediaGenSettings 解析(含 https 强校验)。任一不满足 → false,渲染端隐藏信息图入口。
// resolve 抛错(缺字段 / 非 https / 找不到 provider)一律吞成未配置,不把配置错误当可用。
export function isWritingInfographicConfigured(
  mediaGen: MediaGenSettings | undefined,
  providers: ProviderSettings | undefined,
): boolean {
  if (!mediaGen?.image?.enabled) return false;
  try {
    resolveMediaGenSettings("image", mediaGen, providers ?? { providers: [] });
    return true;
  } catch {
    return false;
  }
}

// 信息图文件名 infographic-<紧凑时间戳14位>-<短随机>.png。时间戳+随机足以避免撞名
// (与 Kun 一致,不做递增探测);ext 固定 png——media-gen 图片一律按 png 落盘(见 client.saveToWorkspace)。
export function buildInfographicImageName(now: Date = new Date(), rand?: string): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = rand ?? randomBytes(2).toString("hex");
  return `infographic-${stamp}-${suffix}.png`;
}

// 默认生成实现:按协议分派到 media-gen 的 openai-images / minimax-image 协议,返回图片 Buffer。
// 每次生成独立超时(AbortSignal.timeout);config.timeoutMs 已在 resolve 阶段夹到看门狗阈值内。
// 响应体大小复用 media-gen 的 MAX_RESPONSE_BYTES.image 上限(防超大响应吃满内存)。
export async function defaultGenerateInfographicImage(
  prompt: string,
  config: ResolvedMediaGenConfig,
): Promise<Buffer> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  let buffer: Buffer;
  if (config.protocol === "openai-images") {
    // openai-images 无 aspectRatio 概念:尊重用户 defaultSize(部分供应商只收固定尺寸),未填则用供应商默认。
    buffer = await openaiImagesGenerate(
      { prompt, model: config.model, size: (config.defaultSize as string) || undefined },
      config,
      signal,
    );
  } else if (config.protocol === "minimax-image") {
    // 信息图偏竖版(3:4),与 Kun KIND_ASPECT_RATIO.infographic 对齐。
    buffer = await minimaxGenerateImage({ prompt, model: config.model, aspectRatio: "3:4" }, config, signal);
  } else {
    throw new Error(`不支持的图片生成协议: ${config.protocol}`);
  }
  if (buffer.byteLength > MAX_RESPONSE_BYTES.image) {
    throw new Error(`信息图响应体超过大小限制(${buffer.byteLength} > ${MAX_RESPONSE_BYTES.image} bytes)`);
  }
  return buffer;
}

// runWritingInfographic 的注入依赖:store/fs 能力经此注入,便于单测替身(不拉 electron/store/fs)。
export interface RunInfographicDeps {
  // 读最新持久化设置(runtime = getPersistedState);只取 mediaGenSettings / providerSettings。
  loadState: () => Promise<{ mediaGenSettings?: MediaGenSettings; providerSettings?: ProviderSettings }>;
  // 空间根白名单校验(runtime = fs.ts assertAllowed):img 目录与最终目标越权即抛。
  assertAllowed: (path: string) => Promise<void>;
  // 图片生成(缺省 defaultGenerateInfographicImage);测试注入返回固定 Buffer / 抛错。
  generate?: (prompt: string, config: ResolvedMediaGenConfig) => Promise<Buffer>;
  // 文件名时间戳来源(缺省 new Date());测试固定以断言命名。
  now?: () => Date;
}

// 编排一次信息图生成:校验入参 → 读设置判可用 → 构造提示词 → 生成 Buffer → 落盘 img/ → 回绝对路径。
// 边界与取舍:
//   - 空 spaceRoot / 空选区 → 直接失败(不生成)。
//   - 未配置 → 失败并提示去设置(与渲染端隐藏入口互为兜底:入口漏显时点了也不会误发)。
//   - 「先生成再落盘」:生成失败(含超时/协议错)绝不写半成品文件(单测锁「失败不写文件」)。
//   - img 目录与最终目标都过 assertAllowed:越权(spaceRoot 非注册空间)即抛 → 转失败,不写文件。
export async function runWritingInfographic(
  req: WritingInfographicRequest,
  deps: RunInfographicDeps,
): Promise<WritingInfographicResult> {
  const spaceRoot = req.spaceRoot?.trim();
  if (!spaceRoot) return { ok: false, message: "缺少写作空间根" };
  const text = req.text?.trim();
  if (!text) return { ok: false, message: "请先选中要生成信息图的文字" };

  // 每次读最新设置:支持用户中途改配置立即生效(与 media-gen server 同款「每次读」策略)。
  const state = await deps.loadState();
  const mediaGen = state.mediaGenSettings;
  const providers = state.providerSettings;
  if (!isWritingInfographicConfigured(mediaGen, providers)) {
    return { ok: false, message: "图片生成未配置,请在「设置 → 媒体生成」中启用并填写图片模型" };
  }
  // isWritingInfographicConfigured 已保证可解析,这里 resolve 拿运行期配置(不会抛)。
  const config = resolveMediaGenSettings("image", mediaGen!, providers ?? { providers: [] });

  const prompt = buildWritingInfographicPrompt(text);
  const generate = deps.generate ?? defaultGenerateInfographicImage;

  // 先生成(可能抛/超时):失败即返回,后续落盘不执行 → 绝不留半成品文件。
  let buffer: Buffer;
  try {
    buffer = await generate(prompt, config);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const imgDir = join(spaceRoot, WRITING_IMAGE_DIR);
  try {
    await deps.assertAllowed(imgDir);
    await mkdir(imgDir, { recursive: true });
    const fileName = buildInfographicImageName(deps.now?.() ?? new Date());
    const target = join(imgDir, fileName);
    await deps.assertAllowed(target);
    await writeFile(target, buffer);
    return { ok: true, absolutePath: target, fileName: basename(target) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// 注册信息图 IPC:availability 探测(未配置返回 false,不抛)+ 生成(失败回可读 message 不抛)。
// store/fs 依赖在此动态 import(ESM import()),避免模块顶层拉入 electron/store/fs 依赖图。
export function registerWritingInfographicHandlers(): void {
  ipcMain.handle("writing:infographicAvailable", async (): Promise<boolean> => {
    try {
      const { getPersistedState } = await import("./store");
      const state = await getPersistedState();
      return isWritingInfographicConfigured(state.mediaGenSettings, state.providerSettings);
    } catch {
      return false; // 探测失败一律按未配置,隐藏入口而非报错
    }
  });

  ipcMain.handle(
    "writing:infographic",
    async (_event, req: WritingInfographicRequest): Promise<WritingInfographicResult> => {
      try {
        const [{ getPersistedState }, { assertAllowed }] = await Promise.all([
          import("./store"),
          import("./fs"),
        ]);
        return await runWritingInfographic(req, {
          loadState: getPersistedState,
          assertAllowed,
        });
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
