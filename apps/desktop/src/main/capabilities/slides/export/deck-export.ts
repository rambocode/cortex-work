// Slides deck 导出编排:统一的「校验 → 逐页渲染 → 场景提取 → 生成 → 一次性落盘」管线。
//
// 契约:
//  - 目标路径只由主进程的系统保存对话框决定(renderer 不传输出路径);
//  - 产物在内存/临时目录完全就绪后才写用户选择的位置 —— 失败不留半成品;
//  - 每页一个隐藏窗口生命周期,finally 必销毁(经 render.ts 的窗口抽象);
//  - 取消:cancel signal 只阻止「后续页面」开工,不强杀正在执行的 Chromium 调用;
//  - 导出报告记录每页 native/raster 数与降级原因,写入 slides scope 日志。
import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sortedSlidesSlots, type SlidesError, type SlidesSlot } from "@cortex-work/core/design/slides/slides-types";
import { createLogger } from "../../../log";
import {
  defaultSlideWindowFactory,
  READY_WAIT_SCRIPT,
  SlideRenderTimeoutError,
  type SlideRenderWindow,
  type SlideWindowFactory,
} from "../render";
import { loadDeckManifest, readSlideNotes, resolveDeckPaths, type SlidesWorkspaceResult } from "../workspace";
import { captureBaseRasterDataUri, extractSlideScene } from "./dom-extractor";
import { scenesToPptxBuffer, type SceneSlideInput } from "./pptx";
import { summarizeScene, type SceneExportReport, type SlideScene } from "./types";

const log = createLogger("slides");

/** 单页导出渲染超时(比截图检查宽:导出页可能更重)。 */
export const EXPORT_RENDER_TIMEOUT_MS = 20_000;

/** 导出取消信号(renderer 取消 / 窗口关闭时置位)。 */
export interface ExportCancelSignal {
  readonly canceled: boolean;
}

/** 一页的导出中间产物。 */
export interface RenderedSlideForExport {
  slot: SlidesSlot;
  scene: SlideScene;
  /** 仅当该页有复杂层时才截 base raster(省一次截图)。 */
  baseRasterDataUri?: string;
  report: SceneExportReport;
}

export interface DeckExportProgress {
  (done: number, total: number, slotId: string): void;
}

// 逐页:加载 → 就绪等待 → 提取场景 → (有复杂层则)截 base raster。窗口 finally 必销毁。
async function renderSlideForExport(options: {
  htmlAbsPath: string;
  slot: SlidesSlot;
  windowFactory: SlideWindowFactory;
  timeoutMs: number;
}): Promise<RenderedSlideForExport> {
  const win: SlideRenderWindow = options.windowFactory();
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const guard = async <T>(promise: Promise<T>, what: string): Promise<T> => {
    const remaining = Math.max(500, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SlideRenderTimeoutError(what, remaining)), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    await guard(win.loadURL(pathToFileURL(options.htmlAbsPath).href), "loadURL");
    await guard(win.executeJavaScript(READY_WAIT_SCRIPT), "fonts/images ready");
    const scene = await guard(extractSlideScene(win), "extract scene");
    // base raster 只在存在复杂层时才截:纯原生页面叠底图既浪费体积也会糊化文字。
    const baseRasterDataUri = scene.hasComplexLayers
      ? await guard(captureBaseRasterDataUri(win), "base raster")
      : undefined;
    const report = summarizeScene(scene);
    log.info(
      `[slides] export render slot=${options.slot.id} native=${report.nativeCount} raster=${report.rasterCount}` +
        `${report.rasterReasons.length ? ` reasons=${[...new Set(report.rasterReasons)].join(",")}` : ""}` +
        ` ms=${Date.now() - startedAt}`,
    );
    return { slot: options.slot, scene, baseRasterDataUri, report };
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* 窗口可能已随 app 关闭销毁 */
    }
  }
}

/**
 * 逐页渲染整个 deck(供 pptx/pdf/png/html 各导出器复用)。
 * 顺序执行:并发多个隐藏窗口会争抢 GPU/字体资源,反而拖慢并放大超时风险。
 */
export async function renderDeckForExport(options: {
  workspaceRoot: string;
  deckId: string;
  windowFactory?: SlideWindowFactory;
  timeoutMs?: number;
  cancel?: ExportCancelSignal;
  onProgress?: DeckExportProgress;
}): Promise<SlidesWorkspaceResult<RenderedSlideForExport[]>> {
  const loaded = await loadDeckManifest({ workspaceRoot: options.workspaceRoot, deckId: options.deckId });
  if (!loaded.ok) return loaded;
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;

  // 只导出已生成的页面;空/失败页跳过(导出报告在日志中体现)。
  const slots = sortedSlidesSlots(loaded.value.manifest.slides).filter((s) => s.status === "ready");
  if (slots.length === 0) {
    return { ok: false, error: { code: "not_found", message: "没有可导出的页面" } };
  }

  const factory = options.windowFactory ?? defaultSlideWindowFactory;
  const rendered: RenderedSlideForExport[] = [];
  for (const slot of slots) {
    // 取消只阻止后续页面开工,不打断正在执行的 Chromium 调用。
    if (options.cancel?.canceled) {
      return { ok: false, error: { code: "canceled", message: "导出已取消" } };
    }
    try {
      rendered.push(
        await renderSlideForExport({
          htmlAbsPath: resolve(resolved.value.realWorkspaceRoot, slot.htmlPath),
          slot,
          windowFactory: factory,
          timeoutMs: options.timeoutMs ?? EXPORT_RENDER_TIMEOUT_MS,
        }),
      );
    } catch (err) {
      const error: SlidesError =
        err instanceof SlideRenderTimeoutError
          ? { code: "timeout", message: `第 ${slot.order + 1} 页渲染超时:${err.message}` }
          : { code: "io_error", message: `第 ${slot.order + 1} 页渲染失败:${err instanceof Error ? err.message : String(err)}` };
      return { ok: false, error };
    }
    options.onProgress?.(rendered.length, slots.length, slot.id);
  }
  return { ok: true, value: rendered };
}

/** deck → PPTX buffer(纯内存产出;调用方负责落盘)。 */
export async function buildDeckPptx(options: {
  workspaceRoot: string;
  deckId: string;
  windowFactory?: SlideWindowFactory;
  timeoutMs?: number;
  cancel?: ExportCancelSignal;
  onProgress?: DeckExportProgress;
}): Promise<SlidesWorkspaceResult<{ buffer: Buffer; reports: SceneExportReport[] }>> {
  const rendered = await renderDeckForExport(options);
  if (!rendered.ok) return rendered;
  // 演讲者备注随 PPTX 导出(有则带,无则跳过 —— 读失败不阻断导出)。
  const inputs: SceneSlideInput[] = [];
  for (const r of rendered.value) {
    const notes = r.slot.notesPath
      ? await readSlideNotes({ workspaceRoot: options.workspaceRoot, deckId: options.deckId, slotId: r.slot.id })
      : null;
    inputs.push({
      scene: r.scene,
      baseRasterDataUri: r.baseRasterDataUri,
      notes: notes?.ok ? notes.value : undefined,
    });
  }
  try {
    const { buffer, reports } = await scenesToPptxBuffer(inputs);
    const totals = reports.reduce(
      (acc, r) => ({ native: acc.native + r.nativeCount, raster: acc.raster + r.rasterCount }),
      { native: 0, raster: 0 },
    );
    log.info(
      `[slides] pptx built deck=${options.deckId} slides=${reports.length} native=${totals.native} raster=${totals.raster} bytes=${buffer.byteLength}`,
    );
    return { ok: true, value: { buffer, reports } };
  } catch (err) {
    log.error("buildDeckPptx failed:", err);
    return { ok: false, error: { code: "io_error", message: `PPTX 生成失败:${err instanceof Error ? err.message : String(err)}` } };
  }
}

/** 原子落盘:先写 .tmp 再 rename —— 导出中途失败不给用户留半个文件。 */
export async function writeArtifactAtomic(targetPath: string, data: Buffer | string): Promise<void> {
  const tmp = `${targetPath}.tmp`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
