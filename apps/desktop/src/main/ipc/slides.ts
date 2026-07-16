// Slides IPC 域:renderer(SlidesWorkspace UI)↔ 主进程 deck 持久化的唯一通道。
//
// 跨进程契约:通道与请求/结果形状见 ./slides-ipc-types(与 core/desktop/slides-ipc-types
// 镜像)。所有 handler:
//   - 不信任 renderer 输入:workspaceRoot/deckId/slotId/revision 全部在 capabilities/slides/
//     workspace.ts 内重新校验(realpath、符号链接、边界、乐观锁);
//   - 不抛未捕获异常:一律返回结构化 { ok:false, error } 结果;
//   - 导出/截图/检查通道在对应能力落地任务(Task 7/9/10)前返回 unsupported_format /
//     io_error 占位错误,保证 preload 面从本任务起稳定。
import { BrowserWindow, dialog, ipcMain } from "electron";
import { slotsFromSlidesOutline, type SlidesDeckManifest, nextSlidesSlotId, type SlidesSlot } from "@cortex-work/core/design/slides/slides-types";
import { slidesSlideHtmlPath } from "@cortex-work/core/design/slides/slides-paths";
import type {
  SlidesApproveOutlineRequest,
  SlidesCheckRequest,
  SlidesCheckResult,
  SlidesCreateDeckRequest,
  SlidesDeckIpcResult,
  SlidesDeleteSlideRequest,
  SlidesDuplicateSlideRequest,
  SlidesExportRequest,
  SlidesExportResult,
  SlidesInsertSlideRequest,
  SlidesLoadDeckRequest,
  SlidesReadOutlineDraftRequest,
  SlidesReadOutlineDraftResult,
  SlidesReadSlideHtmlRequest,
  SlidesReadSlideHtmlResult,
  SlidesRenameDeckRequest,
  SlidesReorderRequest,
  SlidesSaveEditedHtmlRequest,
  SlidesScreenshotRequest,
  SlidesScreenshotResult,
  SlidesSetActiveSlideRequest,
} from "./slides-ipc-types";
import { SLIDES_EXPORT_FORMATS } from "./slides-ipc-types";
import {
  createDeckWorkspace,
  deleteSlide,
  duplicateSlide,
  loadDeckManifest,
  readSlideHtml,
  readSlidesOutlineDraft,
  updateDeckManifest,
  writeSlideHtml,
  type SlidesWorkspaceResult,
} from "../capabilities/slides/workspace";
import { checkSlides, screenshotSlideToSnapshot } from "../capabilities/slides/inspect";
import { buildDeckPptx, writeArtifactAtomic } from "../capabilities/slides/export/deck-export";

// workspace 层 Result → IPC envelope(成功统一携带最新 manifest)。
function toDeckResult(
  result: SlidesWorkspaceResult<SlidesDeckManifest>,
  extra?: { newSlotId?: string },
): SlidesDeckIpcResult {
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, manifest: result.value, ...extra };
}

// 统一兜底:handler 内任何意外异常都转成结构化 io_error,不让 invoke reject。
async function guarded<T>(fallbackMessage: string, job: () => Promise<T>): Promise<T | { ok: false; error: { code: "io_error"; message: string } }> {
  try {
    return await job();
  } catch (err) {
    return { ok: false, error: { code: "io_error", message: `${fallbackMessage}: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

export function registerSlidesHandlers(): void {
  ipcMain.handle("slides:createDeck", (_e, req: SlidesCreateDeckRequest): Promise<SlidesDeckIpcResult> =>
    guarded("创建 deck 失败", async () =>
      toDeckResult(
        await createDeckWorkspace({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          title: typeof req.title === "string" && req.title.trim() ? req.title.trim() : req.deckId,
        }),
      ),
    ),
  );

  ipcMain.handle("slides:loadDeck", (_e, req: SlidesLoadDeckRequest): Promise<SlidesDeckIpcResult> =>
    guarded("读取 deck 失败", async () => {
      const result = await loadDeckManifest({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, manifest: result.value.manifest, recovered: result.value.recovered };
    }),
  );

  ipcMain.handle("slides:renameDeck", (_e, req: SlidesRenameDeckRequest): Promise<SlidesDeckIpcResult> =>
    guarded("重命名失败", async () =>
      toDeckResult(
        await updateDeckManifest({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          expectedRevision: req.expectedRevision,
          mutate: (m) => {
            const title = typeof req.title === "string" ? req.title.trim() : "";
            if (!title) return null;
            m.title = title;
            return m;
          },
        }),
      ),
    ),
  );

  ipcMain.handle("slides:approveOutline", (_e, req: SlidesApproveOutlineRequest): Promise<SlidesDeckIpcResult> =>
    guarded("批准提纲失败", async () =>
      toDeckResult(
        await updateDeckManifest({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          expectedRevision: req.expectedRevision,
          mutate: (m) => {
            const now = new Date().toISOString();
            // 提纲盖章 + 为每个 item 生成空 slot(已有 slot 保留 —— 重新批准新版提纲时
            // 只为新增 item 追加 slot,不动已生成页面)。
            m.outline = { ...req.outline, approvedAt: now };
            if (m.slides.length === 0) {
              m.slides = slotsFromSlidesOutline({
                outline: m.outline,
                existingIds: [],
                now,
                htmlPathFor: (slotId) => slidesSlideHtmlPath(req.deckId, slotId),
              });
              m.activeSlideId = m.slides[0]?.id ?? null;
            }
            m.status = "outline-approved";
            return m;
          },
        }),
      ),
    ),
  );

  ipcMain.handle("slides:reorderSlides", (_e, req: SlidesReorderRequest): Promise<SlidesDeckIpcResult> =>
    guarded("排序失败", async () =>
      toDeckResult(
        await updateDeckManifest({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          expectedRevision: req.expectedRevision,
          mutate: (m) => {
            const ids = Array.isArray(req.orderedSlotIds) ? req.orderedSlotIds : [];
            const current = new Set(m.slides.map((s) => s.id));
            // 必须是现有 slot 集合的一个排列,否则视为非法请求(schema 复检也会拦重复)。
            if (ids.length !== m.slides.length || !ids.every((id) => current.has(id))) {
              throw new Error("orderedSlotIds 不是现有 slot 的排列");
            }
            const orderOf = new Map(ids.map((id, i) => [id, i]));
            m.slides = m.slides
              .map((s) => ({ ...s, order: orderOf.get(s.id)! }))
              .sort((a, b) => a.order - b.order);
            return m;
          },
        }),
      ),
    ),
  );

  ipcMain.handle("slides:insertSlide", (_e, req: SlidesInsertSlideRequest): Promise<SlidesDeckIpcResult> =>
    guarded("新增页面失败", async () => {
      let newSlotId = "";
      const result = await updateDeckManifest({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        expectedRevision: req.expectedRevision,
        mutate: (m) => {
          newSlotId = nextSlidesSlotId(m.slides.map((s) => s.id));
          const now = new Date().toISOString();
          const slot: SlidesSlot = {
            id: newSlotId,
            order: 0,
            title: typeof req.title === "string" && req.title.trim() ? req.title.trim() : "新页面",
            htmlPath: slidesSlideHtmlPath(req.deckId, newSlotId),
            revision: 0,
            status: "empty",
            updatedAt: now,
          };
          const ordered = [...m.slides].sort((a, b) => a.order - b.order);
          const anchor = req.afterSlotId ? ordered.findIndex((s) => s.id === req.afterSlotId) : ordered.length - 1;
          ordered.splice((anchor === -1 ? ordered.length - 1 : anchor) + 1, 0, slot);
          ordered.forEach((s, i) => {
            s.order = i;
          });
          m.slides = ordered;
          m.activeSlideId = newSlotId;
          return m;
        },
      });
      return toDeckResult(result, { newSlotId });
    }),
  );

  ipcMain.handle("slides:duplicateSlide", (_e, req: SlidesDuplicateSlideRequest): Promise<SlidesDeckIpcResult> =>
    guarded("复制页面失败", async () => {
      // 新 id 需要先读当前 manifest 计算;duplicateSlide 内部会再次校验唯一性与 revision。
      const loaded = await loadDeckManifest({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!loaded.ok) return { ok: false as const, error: loaded.error };
      const newSlotId = nextSlidesSlotId(loaded.value.manifest.slides.map((s) => s.id));
      const result = await duplicateSlide({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        slotId: req.slotId,
        expectedRevision: req.expectedRevision,
        newSlotId,
      });
      return toDeckResult(result, { newSlotId });
    }),
  );

  ipcMain.handle("slides:deleteSlide", (_e, req: SlidesDeleteSlideRequest): Promise<SlidesDeckIpcResult> =>
    guarded("删除页面失败", async () =>
      toDeckResult(
        await deleteSlide({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          slotId: req.slotId,
          expectedRevision: req.expectedRevision,
        }),
      ),
    ),
  );

  ipcMain.handle("slides:setActiveSlide", (_e, req: SlidesSetActiveSlideRequest): Promise<SlidesDeckIpcResult> =>
    guarded("切换页面失败", async () =>
      toDeckResult(
        await updateDeckManifest({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          expectedRevision: req.expectedRevision,
          mutate: (m) => {
            if (m.activeSlideId === req.slotId) return null;
            m.activeSlideId = req.slotId;
            return m;
          },
        }),
      ),
    ),
  );

  ipcMain.handle("slides:saveEditedHtml", (_e, req: SlidesSaveEditedHtmlRequest): Promise<SlidesDeckIpcResult> =>
    guarded("保存编辑失败", async () =>
      toDeckResult(
        await writeSlideHtml({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          slotId: req.slotId,
          html: req.html,
          expectedRevision: req.expectedRevision,
        }),
      ),
    ),
  );

  ipcMain.handle(
    "slides:readOutlineDraft",
    (_e, req: SlidesReadOutlineDraftRequest): Promise<SlidesReadOutlineDraftResult> =>
      guarded("读取提纲草案失败", async () => {
        const result = await readSlidesOutlineDraft({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, outline: result.value };
      }),
  );

  ipcMain.handle("slides:readSlideHtml", (_e, req: SlidesReadSlideHtmlRequest): Promise<SlidesReadSlideHtmlResult> =>
    guarded("读取页面失败", async () => {
      const result = await readSlideHtml({ workspaceRoot: req.workspaceRoot, deckId: req.deckId, slotId: req.slotId });
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, html: result.value };
    }),
  );

  ipcMain.handle("slides:check", (_e, req: SlidesCheckRequest): Promise<SlidesCheckResult> =>
    guarded("检查失败", async () => {
      const result = await checkSlides({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        slotIds: req.slotIds,
      });
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, findings: result.value };
    }),
  );
  ipcMain.handle("slides:screenshot", (_e, req: SlidesScreenshotRequest): Promise<SlidesScreenshotResult> =>
    guarded("截图失败", async () => {
      const result = await screenshotSlideToSnapshot({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        slotId: req.slotId,
      });
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, snapshotPath: result.value.snapshotPath };
    }),
  );
  // 导出:目标路径只由主进程保存对话框决定(请求里不带输出路径);产物完全就绪后
  // 才原子落盘,失败/取消不留半成品。PDF/PNG/HTML 在 Task 10 接入。
  ipcMain.handle("slides:export", async (event, req: SlidesExportRequest): Promise<SlidesExportResult> => {
    try {
      if (!SLIDES_EXPORT_FORMATS.includes(req.format)) {
        return { ok: false, error: { code: "unsupported_format", message: `不支持的导出格式: ${String(req.format)}` } };
      }
      if (req.format !== "pptx") {
        return { ok: false, error: { code: "unsupported_format", message: `${req.format.toUpperCase()} 导出尚未启用` } };
      }
      const loaded = await loadDeckManifest({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!loaded.ok) return { ok: false, error: loaded.error };

      // 先生成产物再弹框?不 —— 先弹框(用户取消则省下几十秒渲染),但落盘一定在产物就绪后。
      const parent = BrowserWindow.fromWebContents(event.sender);
      const defaultName = `${loaded.value.manifest.title || req.deckId}.pptx`;
      const options: Electron.SaveDialogOptions = {
        title: "导出演示文稿",
        defaultPath: defaultName,
        filters: [{ name: "PowerPoint 演示文稿", extensions: ["pptx"] }],
      };
      const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      const targetPath = picked.filePath.toLowerCase().endsWith(".pptx") ? picked.filePath : `${picked.filePath}.pptx`;

      const built = await buildDeckPptx({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!built.ok) return { ok: false, error: built.error };
      await writeArtifactAtomic(targetPath, built.value.buffer);
      return { ok: true, path: targetPath, format: "pptx" };
    } catch (err) {
      return {
        ok: false,
        error: { code: "io_error", message: `导出失败: ${err instanceof Error ? err.message : String(err)}` },
      };
    }
  });
}
