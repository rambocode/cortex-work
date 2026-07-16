// Slides 巡检编排:把 render(隐藏窗口截图+页内巡检)、check(规则映射)与 workspace
// (路径校验/原子写/manifest)串成 IPC 与 MCP 共用的两个入口:
//   - screenshotSlideToSnapshot:单页截图 → snapshots/<slotId>.png → manifest 记录路径
//   - checkSlides:静态 + 渲染检查(可顺带刷新快照),返回按严重度排序的 findings
// manifest 的快照路径更新属于「系统级写」:不携带用户 expectedRevision,内部读当前
// revision 提交,冲突时小范围重试(与用户/Agent 写操作在 deck 队列中天然串行)。
import { promises as fsp } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SlidesDeckManifest, SlidesFinding } from "@cortex-work/core/design/slides/slides-types";
import { slidesSnapshotPath } from "@cortex-work/core/design/slides/slides-paths";
import { createLogger } from "../../log";
import { combineSlideFindings, sortFindings } from "./check";
import { renderSlideFile, SlideRenderTimeoutError, type SlideWindowFactory } from "./render";
import {
  loadDeckManifest,
  readSlideHtml,
  resolveDeckPaths,
  updateDeckManifest,
  type SlidesWorkspaceResult,
} from "./workspace";

const log = createLogger("slides");

// 系统级 manifest 更新:内部取当前 revision,revision_conflict 时重试(最多 3 次)。
async function updateManifestSystem(
  workspaceRoot: string,
  deckId: string,
  mutate: (m: SlidesDeckManifest) => SlidesDeckManifest | null,
): Promise<SlidesWorkspaceResult<SlidesDeckManifest>> {
  let lastError: SlidesWorkspaceResult<SlidesDeckManifest> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const loaded = await loadDeckManifest({ workspaceRoot, deckId });
    if (!loaded.ok) return loaded;
    const result = await updateDeckManifest({
      workspaceRoot,
      deckId,
      expectedRevision: loaded.value.manifest.revision,
      mutate,
    });
    if (result.ok || result.error.code !== "revision_conflict") return result;
    lastError = result;
  }
  return lastError!;
}

// 原子写 PNG(tmp+rename;与 manifest 原子写同一口径)。
async function atomicWritePng(targetAbs: string, png: Buffer): Promise<void> {
  const tmp = `${targetAbs}.tmp`;
  await fsp.mkdir(dirname(targetAbs), { recursive: true });
  await fsp.writeFile(tmp, png);
  try {
    await fsp.rename(tmp, targetAbs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface SlideInspectionOutcome {
  slotId: string;
  findings: SlidesFinding[];
  snapshotWritten: boolean;
}

// 单页渲染 + 检查 + 快照落盘(不更新 manifest;由调用方汇总一次系统更新)。
async function inspectOneSlide(options: {
  workspaceRoot: string;
  deckId: string;
  slotId: string;
  writeSnapshot: boolean;
  windowFactory?: SlideWindowFactory;
  timeoutMs?: number;
}): Promise<SlidesWorkspaceResult<SlideInspectionOutcome>> {
  const html = await readSlideHtml({
    workspaceRoot: options.workspaceRoot,
    deckId: options.deckId,
    slotId: options.slotId,
  });
  if (!html.ok) return html;
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const loaded = await loadDeckManifest({ workspaceRoot: options.workspaceRoot, deckId: options.deckId });
  if (!loaded.ok) return loaded;
  const slot = loaded.value.manifest.slides.find((s) => s.id === options.slotId);
  if (!slot) return { ok: false, error: { code: "not_found", message: `slot 不存在: ${options.slotId}` } };

  const htmlAbs = resolve(resolved.value.realWorkspaceRoot, slot.htmlPath);
  let snapshotWritten = false;
  let findings: SlidesFinding[];
  const startedAt = Date.now();
  try {
    const rendered = await renderSlideFile({
      htmlAbsPath: htmlAbs,
      timeoutMs: options.timeoutMs,
      windowFactory: options.windowFactory,
    });
    findings = combineSlideFindings({
      slot,
      html: html.value,
      inspection: rendered.inspection,
      screenshotBlankRatio: rendered.blankRatio,
    });
    if (options.writeSnapshot) {
      const snapAbs = resolve(resolved.value.realWorkspaceRoot, slidesSnapshotPath(options.deckId, options.slotId));
      await atomicWritePng(snapAbs, rendered.png);
      snapshotWritten = true;
    }
    log.info(
      `[slides] inspect slot=${options.slotId} findings=${findings.length} blank=${rendered.blankRatio.toFixed(3)} ms=${Date.now() - startedAt}`,
    );
  } catch (err) {
    // 渲染失败(卡死超时/加载失败):静态检查照常返回 + render-failed blocking finding。
    const message = err instanceof SlideRenderTimeoutError ? err.message : err instanceof Error ? err.message : String(err);
    findings = combineSlideFindings({ slot, html: html.value, renderError: message });
    log.warn(`[slides] inspect render failed slot=${options.slotId}: ${message}`);
  }
  return { ok: true, value: { slotId: options.slotId, findings, snapshotWritten } };
}

/** 单页截图刷新(MCP screenshot_slide / IPC slides:screenshot)。 */
export async function screenshotSlideToSnapshot(options: {
  workspaceRoot: string;
  deckId: string;
  slotId: string;
  windowFactory?: SlideWindowFactory;
  timeoutMs?: number;
}): Promise<SlidesWorkspaceResult<{ snapshotPath: string }>> {
  const outcome = await inspectOneSlide({ ...options, writeSnapshot: true });
  if (!outcome.ok) return outcome;
  if (!outcome.value.snapshotWritten) {
    return { ok: false, error: { code: "timeout", message: "页面渲染失败,未生成截图" } };
  }
  const snapshotPath = slidesSnapshotPath(options.deckId, options.slotId);
  const updated = await updateManifestSystem(options.workspaceRoot, options.deckId, (m) => {
    const slot = m.slides.find((s) => s.id === options.slotId);
    if (!slot) return null;
    slot.snapshotPath = snapshotPath;
    slot.updatedAt = new Date().toISOString();
    return m;
  });
  if (!updated.ok) return updated;
  return { ok: true, value: { snapshotPath } };
}

/**
 * deck 级检查(IPC slides:check / MCP check_slide):对指定(缺省全部非 empty)slot
 * 逐页静态+渲染检查;refreshSnapshots 时顺带刷新缩略图并统一更新 manifest。
 */
export async function checkSlides(options: {
  workspaceRoot: string;
  deckId: string;
  slotIds?: string[];
  refreshSnapshots?: boolean;
  windowFactory?: SlideWindowFactory;
  timeoutMs?: number;
}): Promise<SlidesWorkspaceResult<SlidesFinding[]>> {
  const loaded = await loadDeckManifest({ workspaceRoot: options.workspaceRoot, deckId: options.deckId });
  if (!loaded.ok) return loaded;
  const manifest = loaded.value.manifest;
  const wanted = options.slotIds?.length ? new Set(options.slotIds) : null;
  const slots = manifest.slides
    .filter((s) => (wanted ? wanted.has(s.id) : s.status !== "empty"))
    .sort((a, b) => a.order - b.order);

  const findings: SlidesFinding[] = [];
  const snapshotUpdated: string[] = [];
  for (const slot of slots) {
    const outcome = await inspectOneSlide({
      workspaceRoot: options.workspaceRoot,
      deckId: options.deckId,
      slotId: slot.id,
      writeSnapshot: options.refreshSnapshots !== false,
      windowFactory: options.windowFactory,
      timeoutMs: options.timeoutMs,
    });
    if (!outcome.ok) {
      findings.push({
        id: `${slot.id}:check-failed:0`,
        severity: "blocking",
        slideId: slot.id,
        code: "check-failed",
        message: outcome.error.message,
      });
      continue;
    }
    findings.push(...outcome.value.findings);
    if (outcome.value.snapshotWritten) snapshotUpdated.push(slot.id);
  }

  // 快照路径统一入册(一次系统更新,避免逐页 bump revision 制造冲突风暴)。
  if (snapshotUpdated.length > 0) {
    const now = new Date().toISOString();
    await updateManifestSystem(options.workspaceRoot, options.deckId, (m) => {
      let touched = false;
      for (const slotId of snapshotUpdated) {
        const slot = m.slides.find((s) => s.id === slotId);
        if (!slot) continue;
        slot.snapshotPath = slidesSnapshotPath(options.deckId, slotId);
        slot.updatedAt = now;
        touched = true;
      }
      return touched ? m : null;
    });
  }

  const slotOrder = new Map(manifest.slides.map((s) => [s.id, s.order]));
  return { ok: true, value: sortFindings(findings, slotOrder) };
}
