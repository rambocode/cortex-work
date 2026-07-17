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
import { resolve, sep } from "node:path";

import { readImageOpenable } from "./image";
import { slotsFromSlidesOutline, type SlidesDeckManifest, nextSlidesSlotId, type SlidesSlot } from "@cortex-work/core/design/slides/slides-types";
import { isValidSlotId, slidesSlideHtmlPath, slidesSnapshotPath } from "@cortex-work/core/design/slides/slides-paths";
import type {
  SlidesAnalyzeExportQualityRequest,
  SlidesAnalyzeExportQualityResult,
  SlidesCancelPipelineRunRequest,
  SlidesApplyTemplateRequest,
  SlidesApproveOutlineRequest,
  SlidesListTemplatesResult,
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
  SlidesReadNotesRequest,
  SlidesReadNotesResult,
  SlidesReadSlideHtmlRequest,
  SlidesReadSlideHtmlResult,
  SlidesReadSnapshotRequest,
  SlidesReadSnapshotResult,
  SlidesReadTemplateReferenceRequest,
  SlidesReadTemplateReferenceResult,
  SlidesRenameDeckRequest,
  SlidesReorderRequest,
  SlidesSaveEditedHtmlRequest,
  SlidesSaveNotesRequest,
  SlidesScreenshotRequest,
  SlidesScreenshotResult,
  SlidesSetActiveSlideRequest,
  SlidesExportQualityAnalysis,
  SlidesGetPipelineRunRequest,
  SlidesPipelineRoleDecisionRequest,
  SlidesPipelineRunResult,
  SlidesDeckScopedRequest,
} from "./slides-ipc-types";
import { SLIDES_EXPORT_FORMATS } from "./slides-ipc-types";
import {
  createDeckWorkspace,
  deleteSlide,
  duplicateSlide,
  loadDeckManifest,
  readSlideHtml,
  readSlideNotes,
  readSlidesOutlineDraft,
  resolveDeckPaths,
  updateDeckManifest,
  writeSlideHtml,
  writeSlideNotes,
  type SlidesWorkspaceResult,
} from "../capabilities/slides/workspace";
import { checkSlides, screenshotSlideToSnapshot } from "../capabilities/slides/inspect";
import { analyzeDeckForExport, buildDeckPptx, writeArtifactAtomic } from "../capabilities/slides/export/deck-export";
import { buildDeckPdf } from "../capabilities/slides/export/pdf";
import { exportDeckPngs } from "../capabilities/slides/export/png";
import { buildPresenterHtml, presenterSlots, type PresenterSlide } from "../capabilities/slides/export/html";
import { getSlidesTemplate, listSlidesTemplates, readTemplateReferenceHtml } from "../capabilities/slides/templates";
import {
  cancelSlidesPipelineRun,
  listLatestRecoverableSlidesPipelineRun,
  loadSlidesPipelineRun,
} from "../capabilities/slides/pipeline/workspace";
import {
  acceptSlidesPipelineRoleResult,
  rejectSlidesPipelineRoleResult,
} from "../capabilities/slides/pipeline/tools";

const EXPORT_ANALYSIS_CACHE_MAX = 8;
const exportAnalysisCache = new Map<string, SlidesExportQualityAnalysis>();

function cacheExportAnalysis(key: string, analysis: SlidesExportQualityAnalysis): void {
  exportAnalysisCache.delete(key);
  exportAnalysisCache.set(key, analysis);
  while (exportAnalysisCache.size > EXPORT_ANALYSIS_CACHE_MAX) {
    const oldest = exportAnalysisCache.keys().next().value as string | undefined;
    if (!oldest) break;
    exportAnalysisCache.delete(oldest);
  }
}

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

  ipcMain.handle("slides:readNotes", (_e, req: SlidesReadNotesRequest): Promise<SlidesReadNotesResult> =>
    guarded("读取演讲者备注失败", async () => {
      const loaded = await loadDeckManifest({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!loaded.ok) return { ok: false as const, error: loaded.error };
      const slot = loaded.value.manifest.slides.find((candidate) => candidate.id === req.slotId);
      if (!slot) {
        return { ok: false as const, error: { code: "not_found" as const, message: `页面不存在: ${req.slotId}` } };
      }
      const result = await readSlideNotes({ workspaceRoot: req.workspaceRoot, deckId: req.deckId, slotId: req.slotId });
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, markdown: result.value, slotRevision: slot.revision };
    }),
  );

  ipcMain.handle("slides:saveNotes", (_e, req: SlidesSaveNotesRequest): Promise<SlidesDeckIpcResult> =>
    guarded("保存演讲者备注失败", async () =>
      toDeckResult(
        await writeSlideNotes({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          slotId: req.slotId,
          markdown: req.markdown,
          expectedRevision: req.expectedRevision,
        }),
      ),
    ),
  );

  // 模板:UI 侧入口(与 MCP list_templates / apply_template 同一注册表与写入路径)。
  ipcMain.handle("slides:listTemplates", (): Promise<SlidesListTemplatesResult> =>
    guarded("读取模板失败", async () => ({ ok: true as const, templates: await listSlidesTemplates() })),
  );

  ipcMain.handle("slides:applyTemplate", (_e, req: SlidesApplyTemplateRequest): Promise<SlidesDeckIpcResult> =>
    guarded("应用模板失败", async () => {
      const template = await getSlidesTemplate(req.templateId);
      if (!template) {
        return { ok: false as const, error: { code: "not_found" as const, message: `模板不存在: ${req.templateId}` } };
      }
      return toDeckResult(
        await updateDeckManifest({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          expectedRevision: req.expectedRevision,
          mutate: (m) => {
            m.theme = template.theme;
            return m;
          },
        }),
      );
    }),
  );

  // 模板参考页 HTML:下拉 hover 预览用。路径校验在 readTemplateReferenceHtml 内
  // (id 白名单 + file 必须是 template.json 声明的 referenceSlides 之一 + 不出模板目录),
  // 任何不合法/缺失统一回 not_found,renderer 退化为色板占位。
  ipcMain.handle(
    "slides:readTemplateReference",
    (_e, req: SlidesReadTemplateReferenceRequest): Promise<SlidesReadTemplateReferenceResult> =>
      guarded("读取模板参考页失败", async () => {
        const html = await readTemplateReferenceHtml(req.templateId, req.file);
        if (html === null) {
          return { ok: false as const, error: { code: "not_found" as const, message: `模板参考页不存在: ${req.templateId}/${req.file}` } };
        }
        return { ok: true as const, html };
      }),
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

  // 缩略图:主进程读盘转 data URL —— renderer 页非 file:// 源,直接 <img src="file://…">
  // 会被 Chromium 拦掉(实测碎图)。沿用图片读闸门(拒符号链接/realpath/仅位图/体积上限),
  // 并额外要求真实路径落在本 deck 根内。
  ipcMain.handle("slides:readSnapshot", (_e, req: SlidesReadSnapshotRequest): Promise<SlidesReadSnapshotResult> =>
    guarded("读取缩略图失败", async () => {
      const resolved = await resolveDeckPaths(req.workspaceRoot, req.deckId);
      if (!resolved.ok) return { ok: false as const, error: resolved.error };
      if (!isValidSlotId(req.slotId)) {
        return { ok: false as const, error: { code: "invalid_path" as const, message: `非法 slot id: ${req.slotId}` } };
      }
      const abs = resolve(resolved.value.realWorkspaceRoot, slidesSnapshotPath(req.deckId, req.slotId));
      try {
        const { dataUrl } = await readImageOpenable(abs, (realTarget) =>
          realTarget === resolved.value.deckRootAbs || realTarget.startsWith(resolved.value.deckRootAbs + sep),
        );
        return { ok: true as const, dataUrl };
      } catch (err) {
        // 快照缺失是常态(尚未截图),按 not_found 回,UI 退化为状态占位。
        const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? ("not_found" as const) : ("invalid_path" as const);
        return { ok: false as const, error: { code, message: err instanceof Error ? err.message : String(err) } };
      }
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
  ipcMain.handle(
    "slides:analyzeExportQuality",
    (_e, req: SlidesAnalyzeExportQualityRequest): Promise<SlidesAnalyzeExportQualityResult> =>
      guarded("分析 PPTX 可编辑性失败", async () => {
        const loaded = await loadDeckManifest({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
        if (!loaded.ok) return { ok: false as const, error: loaded.error };
        const revision = loaded.value.manifest.revision;
        const cacheKey = `${req.workspaceRoot}\u0000${req.deckId}\u0000${revision}`;
        const cached = exportAnalysisCache.get(cacheKey);
        if (cached) return { ok: true as const, analysis: cached, cached: true };
        const result = await analyzeDeckForExport({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
        if (!result.ok) return { ok: false as const, error: result.error };
        const analysis: SlidesExportQualityAnalysis = { revision, ...result.value };
        cacheExportAnalysis(cacheKey, analysis);
        return { ok: true as const, analysis };
      }),
  );
  ipcMain.handle(
    "slides:getLatestPipelineRun",
    (_e, req: SlidesDeckScopedRequest): Promise<SlidesPipelineRunResult> =>
      guarded("读取 AI 工作流失败", async () => {
        const result = await listLatestRecoverableSlidesPipelineRun({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
        });
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, run: result.value };
      }),
  );
  ipcMain.handle(
    "slides:getPipelineRun",
    (_e, req: SlidesGetPipelineRunRequest): Promise<SlidesPipelineRunResult> =>
      guarded("读取 AI 工作流失败", async () => {
        const result = await loadSlidesPipelineRun({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          runId: req.runId,
        });
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, run: result.value };
      }),
  );
  ipcMain.handle(
    "slides:cancelPipelineRun",
    (_e, req: SlidesCancelPipelineRunRequest): Promise<SlidesPipelineRunResult> =>
      guarded("取消 AI 工作流失败", async () => {
        const result = await cancelSlidesPipelineRun({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          runId: req.runId,
          expectedUpdatedAt: req.expectedUpdatedAt,
        });
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, run: result.value };
      }),
  );

  const decidePipelineRole = async (
    req: SlidesPipelineRoleDecisionRequest,
    decision: "accept" | "reject",
  ): Promise<SlidesPipelineRunResult> => {
    const result = decision === "accept"
      ? await acceptSlidesPipelineRoleResult({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          runId: req.runId,
          role: req.role,
          expectedUpdatedAt: req.expectedUpdatedAt,
        })
      : await rejectSlidesPipelineRoleResult({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          runId: req.runId,
          role: req.role,
          expectedUpdatedAt: req.expectedUpdatedAt,
        });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      run: result.value.run,
      action: result.value.review ?? result.value.appliedNotes,
    };
  };

  ipcMain.handle(
    "slides:acceptPipelineRole",
    (_e, req: SlidesPipelineRoleDecisionRequest): Promise<SlidesPipelineRunResult> =>
      guarded("接受角色结果失败", () => decidePipelineRole(req, "accept")),
  );
  ipcMain.handle(
    "slides:rejectPipelineRole",
    (_e, req: SlidesPipelineRoleDecisionRequest): Promise<SlidesPipelineRunResult> =>
      guarded("拒绝角色结果失败", () => decidePipelineRole(req, "reject")),
  );
  // 导出:目标路径只由主进程对话框决定(请求里不带输出路径);产物完全就绪后才
  // 原子落盘,失败/取消不留半成品。PNG 走目录选择 + 本次半成品回滚(见 png.ts)。
  ipcMain.handle("slides:export", async (event, req: SlidesExportRequest): Promise<SlidesExportResult> => {
    try {
      if (!SLIDES_EXPORT_FORMATS.includes(req.format)) {
        return { ok: false, error: { code: "unsupported_format", message: `不支持的导出格式: ${String(req.format)}` } };
      }
      const loaded = await loadDeckManifest({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const manifest = loaded.value.manifest;
      const deckTitle = manifest.title || req.deckId;
      const parent = BrowserWindow.fromWebContents(event.sender);

      // 先弹框、后产出:用户取消可省下几十秒渲染;但落盘一定在产物就绪之后。
      if (req.format === "png") {
        const picked = await showOpenDirectory(parent);
        if (!picked) return { ok: false, canceled: true };
        const result = await exportDeckPngs({
          workspaceRoot: req.workspaceRoot,
          deckId: req.deckId,
          targetDir: picked,
        });
        if (!result.ok) {
          return result.error.code === "canceled"
            ? { ok: false, canceled: true }
            : { ok: false, error: result.error };
        }
        return { ok: true, path: picked, format: "png" };
      }

      const spec = EXPORT_FILE_SPEC[req.format];
      const picked = await showSaveDialog(parent, `${deckTitle}${spec.ext}`, spec.filter);
      if (!picked) return { ok: false, canceled: true };
      const targetPath = picked.toLowerCase().endsWith(spec.ext) ? picked : `${picked}${spec.ext}`;

      if (req.format === "pptx") {
        const built = await buildDeckPptx({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
        if (!built.ok) return { ok: false, error: built.error };
        await writeArtifactAtomic(targetPath, built.value.buffer);
        return { ok: true, path: targetPath, format: "pptx", qualityReport: built.value.deckReport };
      }

      // pdf / html 都需要各页 HTML 原文。
      const slides = await collectPresenterSlides(req.workspaceRoot, req.deckId, manifest.slides);
      if (!slides.ok) return { ok: false, error: slides.error };
      if (req.format === "html") {
        const html = buildPresenterHtml({ title: deckTitle, slides: slides.value });
        await writeArtifactAtomic(targetPath, html);
        return { ok: true, path: targetPath, format: "html" };
      }
      const pdf = await buildDeckPdf({ title: deckTitle, slides: slides.value });
      await writeArtifactAtomic(targetPath, pdf);
      return { ok: true, path: targetPath, format: "pdf" };
    } catch (err) {
      return {
        ok: false,
        error: { code: "io_error", message: `导出失败: ${err instanceof Error ? err.message : String(err)}` },
      };
    }
  });
}

// 各格式的扩展名与保存对话框过滤器。
const EXPORT_FILE_SPEC: Record<"pptx" | "pdf" | "html", { ext: string; filter: Electron.FileFilter }> = {
  pptx: { ext: ".pptx", filter: { name: "PowerPoint 演示文稿", extensions: ["pptx"] } },
  pdf: { ext: ".pdf", filter: { name: "PDF", extensions: ["pdf"] } },
  html: { ext: ".html", filter: { name: "HTML 演示文稿", extensions: ["html"] } },
};

async function showSaveDialog(
  parent: BrowserWindow | null,
  defaultName: string,
  filter: Electron.FileFilter,
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: "导出演示文稿",
    defaultPath: defaultName,
    filters: [filter],
  };
  const res = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return res.canceled || !res.filePath ? null : res.filePath;
}

async function showOpenDirectory(parent: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "选择 PNG 导出目录",
    properties: ["openDirectory", "createDirectory"],
  };
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
}

// 读取各页 HTML 原文(presenter/PDF 用)。任何一页读失败即整体失败,不导半套。
async function collectPresenterSlides(
  workspaceRoot: string,
  deckId: string,
  slides: SlidesDeckManifest["slides"],
): Promise<SlidesWorkspaceResult<PresenterSlide[]>> {
  const slots = presenterSlots(slides);
  if (slots.length === 0) {
    return { ok: false, error: { code: "not_found", message: "没有可导出的页面" } };
  }
  const out: PresenterSlide[] = [];
  for (const slot of slots) {
    const html = await readSlideHtml({ workspaceRoot, deckId, slotId: slot.id });
    if (!html.ok) return html;
    // 备注仅 presenter 用(PDF 的打印文档不含备注面板);读失败不阻断导出。
    const notes = slot.notesPath ? await readSlideNotes({ workspaceRoot, deckId, slotId: slot.id }) : null;
    out.push({ title: slot.title, html: html.value, notes: notes?.ok ? notes.value : undefined });
  }
  return { ok: true, value: out };
}
