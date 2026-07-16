// Slides PNG 导出:逐页 capturePage 到用户选择的目录,文件名按 deck 顺序补零。
// 失败/取消时清理本次已写入的半成品(用户目录里不留残页)。
import { promises as fsp } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SlidesError, SlidesSlot } from "@cortex-work/core/design/slides/slides-types";
import { createLogger } from "../../../log";
import {
  defaultSlideWindowFactory,
  READY_WAIT_SCRIPT,
  SlideRenderTimeoutError,
  type SlideWindowFactory,
} from "../render";
import { loadDeckManifest, resolveDeckPaths, type SlidesWorkspaceResult } from "../workspace";
import type { ExportCancelSignal, DeckExportProgress } from "./deck-export";
import { pngFileNameFor, presenterSlots } from "./html";

const log = createLogger("slides");

export const PNG_RENDER_TIMEOUT_MS = 20_000;

// 单页截图:窗口 finally 必销毁。
async function capturePng(options: {
  htmlAbsPath: string;
  windowFactory: SlideWindowFactory;
  timeoutMs: number;
}): Promise<Buffer> {
  const win = options.windowFactory();
  const deadline = Date.now() + options.timeoutMs;
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
    const image = await guard(win.capturePage(), "capturePage");
    return image.toPNG();
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* 窗口可能已随 app 关闭销毁 */
    }
  }
}

/**
 * 导出整套 deck 为 PNG 序列到 targetDir。
 * 半成品清理:任何一页失败/取消,删除本次已写出的文件后返回结构化错误。
 */
export async function exportDeckPngs(options: {
  workspaceRoot: string;
  deckId: string;
  targetDir: string;
  windowFactory?: SlideWindowFactory;
  timeoutMs?: number;
  cancel?: ExportCancelSignal;
  onProgress?: DeckExportProgress;
}): Promise<SlidesWorkspaceResult<{ files: string[] }>> {
  const loaded = await loadDeckManifest({ workspaceRoot: options.workspaceRoot, deckId: options.deckId });
  if (!loaded.ok) return loaded;
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const slots: SlidesSlot[] = presenterSlots(loaded.value.manifest.slides);
  if (slots.length === 0) {
    return { ok: false, error: { code: "not_found", message: "没有可导出的页面" } };
  }

  const factory = options.windowFactory ?? defaultSlideWindowFactory;
  const written: string[] = [];
  // 半成品清理:失败/取消时删掉本次写出的文件(只删自己写的,不动目录里的其它内容)。
  const cleanup = async (): Promise<void> => {
    await Promise.all(written.map((f) => fsp.rm(f, { force: true }).catch(() => undefined)));
  };

  for (const [index, slot] of slots.entries()) {
    if (options.cancel?.canceled) {
      await cleanup();
      return { ok: false, error: { code: "canceled", message: "导出已取消" } };
    }
    try {
      const png = await capturePng({
        htmlAbsPath: resolve(resolved.value.realWorkspaceRoot, slot.htmlPath),
        windowFactory: factory,
        timeoutMs: options.timeoutMs ?? PNG_RENDER_TIMEOUT_MS,
      });
      const target = join(options.targetDir, pngFileNameFor(slot, index, slots.length));
      await fsp.writeFile(target, png);
      written.push(target);
      options.onProgress?.(written.length, slots.length, slot.id);
    } catch (err) {
      await cleanup();
      const error: SlidesError =
        err instanceof SlideRenderTimeoutError
          ? { code: "timeout", message: `第 ${index + 1} 页渲染超时:${err.message}` }
          : {
              code: "io_error",
              message: `第 ${index + 1} 页导出失败:${err instanceof Error ? err.message : String(err)}`,
            };
      return { ok: false, error };
    }
  }
  log.info(`[slides] png exported deck=${options.deckId} files=${written.length}`);
  return { ok: true, value: { files: written } };
}
