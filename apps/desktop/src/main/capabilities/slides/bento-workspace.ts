// bento deck 主进程持久化层:deck.bento.html(自包含单文件)+ deck.meta.json(revision)。
// 取代旧 slot-HTML 体系的 workspace.ts,契约收敛为三条:
//   1. 路径安全:workspaceRoot realpath;deck 根拒符号链接;所有写入路径限定 deck 根内。
//   2. 原子性 + 串行:临时文件 + rename;同一 deck 的读改写走进程内队列,
//      AI 的 writeBentoDoc 与编辑器 autosave 的 writeBentoDeckHtml 并发时不互相撕裂。
//   3. 乐观锁:AI 整份写文档须带 expectedRevision(不匹配 → revision_conflict);
//      编辑器 autosave 是就地权威,不带锁,直接 last-writer(队列内串行)。
// revision 存 sidecar deck.meta.json:HTML 本体是 bento 的领地,宿主元数据不污染其格式;
// meta 缺失(用户手动拷入文件)按 revision 0 处理,下次写入时重建。
import { constants as fsConstants, promises as fsp } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  parseBentoDoc,
  type BentoDoc,
  type BentoSlide,
} from "@cortex-work/core/design/slides/bento/bento-doc-schema";
import { buildStarterBentoDoc } from "@cortex-work/core/design/slides/bento/bento-doc-schema";
import {
  extractBentoDocJson,
  extractBentoRuntimeId,
  injectBentoDoc,
  injectBentoDocJson,
} from "@cortex-work/core/design/slides/bento/bento-embed";
import { mergeSlideComments } from "@cortex-work/core/design/slides/bento/merge-comments";
import { normalizeDeckHtml } from "@cortex-work/core/design/slides/bento/normalize-deck-html";
import { sanitizeDeckDoc } from "@cortex-work/core/design/slides/bento/sanitize-deck-doc";
import { applySlideReplacements } from "@cortex-work/core/design/slides/bento/slide-patch";
import { slidesOutlineSchema } from "@cortex-work/core/design/slides/slides-schema";
import type { SlidesOutline } from "@cortex-work/core/design/slides/slides-types";
import {
  bentoDeckHtmlPath,
  bentoDeckMetaPath,
  isValidDeckId,
  slidesDeckRootPath,
  slidesSourcesManifestPath,
} from "@cortex-work/core/design/slides/slides-paths";
import type { SlidesDeckChangeSource } from "../../ipc/slides-ipc-types";
import { createLogger } from "../../log";
import { emitSlidesDeckChanged } from "./deck-events";

const log = createLogger("slides");

// 整份 deck HTML 的字节上限:壳 ~600KB + 文档/内嵌资产;64MB 足够容纳重图片 deck,
// 同时拦住失控调用方(编辑器正常产物远小于此)。
export const MAX_DECK_HTML_BYTES = 64 * 1024 * 1024;

export type BentoErrorCode =
  | "invalid_path"
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "invalid_doc"
  | "too_large"
  | "io_error";

export interface BentoDeckError {
  code: BentoErrorCode;
  message: string;
}

export type BentoWorkspaceResult<T> = { ok: true; value: T } | { ok: false; error: BentoDeckError };

function fail<T>(code: BentoErrorCode, message: string): BentoWorkspaceResult<T> {
  return { ok: false, error: { code, message } };
}

// ---- 每 deck 串行队列(与旧 workspace 同模式):读改写不并发。----
const deckQueues = new Map<string, Promise<unknown>>();

function enqueueDeck<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = deckQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  deckQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

interface BentoDeckPaths {
  realWorkspaceRoot: string;
  deckRootAbs: string;
  htmlAbs: string;
  metaAbs: string;
  /// 研究来源清单（制作期溯源材料，不进 deck 交付物，见 core 的 slidesSourcesManifestPath）。
  sourcesAbs: string;
}

function isInsideRoot(rootAbs: string, targetAbs: string): boolean {
  return targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep);
}

/** 解析并校验 deck 路径(存在的 deck 根拒符号链接/越界)。 */
async function resolveBentoDeckPaths(
  workspaceRoot: string,
  deckId: string,
): Promise<BentoWorkspaceResult<BentoDeckPaths>> {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    return fail("invalid_path", "缺少工作区根目录");
  }
  if (!isValidDeckId(deckId)) return fail("invalid_path", `非法 deck id: ${deckId}`);
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = await fsp.realpath(workspaceRoot);
  } catch {
    return fail("invalid_path", `工作区不存在: ${workspaceRoot}`);
  }
  const deckRootAbs = resolve(realWorkspaceRoot, slidesDeckRootPath(deckId));
  if (!isInsideRoot(realWorkspaceRoot, deckRootAbs)) {
    return fail("invalid_path", `deck 根越界: ${deckId}`);
  }
  try {
    const st = await fsp.lstat(deckRootAbs);
    if (st.isSymbolicLink()) return fail("invalid_path", "deck 根不允许是符号链接");
    const real = await fsp.realpath(deckRootAbs);
    if (!isInsideRoot(realWorkspaceRoot, real)) {
      return fail("invalid_path", "deck 根解析后越出工作区");
    }
  } catch {
    // deck 根尚不存在:创建流程允许;读取流程后续 not_found。
  }
  return {
    ok: true,
    value: {
      realWorkspaceRoot,
      deckRootAbs,
      htmlAbs: resolve(realWorkspaceRoot, bentoDeckHtmlPath(deckId)),
      metaAbs: resolve(realWorkspaceRoot, bentoDeckMetaPath(deckId)),
      sourcesAbs: resolve(realWorkspaceRoot, slidesSourcesManifestPath(deckId)),
    },
  };
}

// ---- 破坏性写入前的一次性备份 ----
//
// 动机(用户实测):AI 一次改稿会覆盖十几页;若产物不理想(或曾被协作合并污染),
// 用户手上没有任何"改之前那一版"。这里在**本进程内每个 deck 只备份一次**——
// 目的是留住"AI 大改之前"那一版,而不是跟着每秒一次的编辑器 autosave 滚动覆盖。
const backedUpDecks = new Set<string>();

async function backupOnce(htmlAbs: string): Promise<void> {
  if (backedUpDecks.has(htmlAbs)) return;
  backedUpDecks.add(htmlAbs);
  try {
    // copyFile 的 EXCL:已存在的 .bak(上次会话留下的)一律不覆盖。
    await fsp.copyFile(htmlAbs, `${htmlAbs}.bak`, fsConstants.COPYFILE_EXCL);
  } catch {
    // 备份是尽力而为:文件不存在(新建流程)、.bak 已存在、磁盘满都不该阻断真正的写入。
  }
}

/** 仅供单测复位「每进程每 deck 一次」的备份记录。 */
export function __resetSlidesDeckBackups(): void {
  backedUpDecks.clear();
}

// ---- 变更广播 ----

/** 从文档(对象或原始 JSON 文本)里数页数;解析不了按 0 处理(只用于展示文案)。 */
function countSlides(doc: unknown): number {
  const slides = (doc as { slides?: unknown } | null)?.slides;
  return Array.isArray(slides) ? slides.length : 0;
}

/**
 * 写盘成功后广播一次内容变更。
 * **只在成功路径调用**:失败路径广播会让渲染端刷新到一个并不存在的新 revision。
 */
function announceDeckChange(options: {
  workspaceRoot: string;
  deckId: string;
  revision: number;
  source: SlidesDeckChangeSource;
  slideIds?: string[];
  pages?: number[];
  slideCount: number;
  assetKey?: string;
}): void {
  emitSlidesDeckChanged(
    {
      workspaceRoot: options.workspaceRoot,
      deckId: options.deckId,
      revision: options.revision,
      source: options.source,
      slideIds: options.slideIds ?? [],
      pages: options.pages ?? [],
      slideCount: options.slideCount,
      ...(options.assetKey ? { assetKey: options.assetKey } : {}),
      at: new Date().toISOString(),
    },
    log,
  );
}

/** 临时文件 + rename 原子写。失败清理 tmp,不破坏旧文件。 */
async function atomicWriteFile(targetAbs: string, content: string): Promise<void> {
  const tmp = `${targetAbs}.tmp`;
  await fsp.mkdir(dirname(targetAbs), { recursive: true });
  await fsp.writeFile(tmp, content, "utf8");
  try {
    await fsp.rename(tmp, targetAbs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 提纲批准 gate 的生命周期(存 sidecar;bento 文档本体不携带宿主工作流状态)。 */
export type BentoDeckStage = "draft" | "outline-proposed" | "outline-approved" | "ready";

const BENTO_STAGES: readonly BentoDeckStage[] = ["draft", "outline-proposed", "outline-approved", "ready"];

export interface BentoDeckMeta {
  revision: number;
  stage: BentoDeckStage;
  /** propose_outline 暂存的提纲草案(结构由 MCP 层用 slidesOutlineSchema 校验)。 */
  outline: unknown;
}

/** 宿主专用的初始生成标记。Bento schema 为 passthrough,运行时会安全忽略。 */
export const BENTO_PENDING_GENERATION_FIELD = "cortexGeneration";

type PendingGenerationMarker = {
  status: "pending";
  outlineItemId: string;
};

function pendingGenerationMarker(slide: unknown): PendingGenerationMarker | null {
  if (!slide || typeof slide !== "object") return null;
  const marker = (slide as Record<string, unknown>)[BENTO_PENDING_GENERATION_FIELD];
  if (!marker || typeof marker !== "object") return null;
  const candidate = marker as Partial<PendingGenerationMarker>;
  return candidate.status === "pending" && typeof candidate.outlineItemId === "string"
    ? { status: "pending", outlineItemId: candidate.outlineItemId }
    : null;
}

/** 1 基页码,同时供工具 gate 与写入完成态判断。 */
export function pendingBentoGenerationPages(doc: unknown): number[] {
  const slides = (doc as { slides?: unknown } | null)?.slides;
  if (!Array.isArray(slides)) return [];
  return slides.flatMap((slide, index) => (pendingGenerationMarker(slide) ? [index + 1] : []));
}

function escapeInlineHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildGenerationPlaceholder(
  item: SlidesOutline["items"][number],
  index: number,
  total: number,
  doc: BentoDoc,
): BentoSlide {
  const title = escapeInlineHtml(item.title);
  const points = item.keyPoints
    .slice(0, 4)
    .map((point) => `• ${escapeInlineHtml(point)}`)
    .join("<br>");
  return {
    id: `slide-${index + 1}`,
    name: item.title,
    background: doc.theme.background,
    transition: "fade",
    elements: [
      {
        id: `generation-kicker-${index + 1}`,
        type: "text",
        x: 96,
        y: 84,
        w: 1088,
        h: 34,
        rotation: 0,
        opacity: 1,
        html: `GENERATING · ${index + 1} / ${total}`,
        fontSize: 18,
        fontFamily: doc.theme.fontFamily,
        fontWeight: 600,
        color: doc.theme.accent,
        align: "left",
        valign: "middle",
        lineHeight: 1.2,
      },
      {
        id: `generation-title-${index + 1}`,
        type: "text",
        x: 96,
        y: 176,
        w: 1088,
        h: 116,
        rotation: 0,
        opacity: 1,
        html: title,
        fontSize: 52,
        fontFamily: doc.theme.fontFamily,
        fontWeight: 700,
        color: doc.theme.color,
        align: "left",
        valign: "middle",
        lineHeight: 1.12,
      },
      {
        id: `generation-points-${index + 1}`,
        type: "text",
        x: 96,
        y: 342,
        w: 900,
        h: 220,
        rotation: 0,
        opacity: 0.72,
        html: points || escapeInlineHtml(item.purpose),
        fontSize: 24,
        fontFamily: doc.theme.fontFamily,
        fontWeight: 400,
        color: doc.theme.color,
        align: "left",
        valign: "top",
        lineHeight: 1.5,
      },
    ],
    notes: "",
    [BENTO_PENDING_GENERATION_FIELD]: {
      status: "pending",
      outlineItemId: item.id,
    },
  };
}

/** 读 sidecar meta;缺失/损坏一律回落安全默认(手动拷入的 deck 也能继续工作)。 */
async function readMeta(metaAbs: string): Promise<BentoDeckMeta> {
  try {
    const parsed = JSON.parse(await fsp.readFile(metaAbs, "utf8")) as Partial<BentoDeckMeta>;
    const revision =
      typeof parsed.revision === "number" && Number.isInteger(parsed.revision) && parsed.revision >= 0
        ? parsed.revision
        : 0;
    const stage = BENTO_STAGES.includes(parsed.stage as BentoDeckStage) ? (parsed.stage as BentoDeckStage) : "ready";
    return { revision, stage, outline: parsed.outline ?? null };
  } catch {
    // meta 缺失:按 ready 处理(不把手动拷入的成品 deck 卡在提纲 gate 前)。
    return { revision: 0, stage: "ready", outline: null };
  }
}

async function writeMeta(metaAbs: string, meta: BentoDeckMeta): Promise<void> {
  await atomicWriteFile(metaAbs, JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2));
}

// ---- 对外 API ----

/** 创建 bento deck:runtime 空壳注入 starter 文档后原子落盘,meta revision 0。 */
export async function createBentoDeck(options: {
  workspaceRoot: string;
  deckId: string;
  title: string;
  /** bento runtime 空壳 HTML(由调用方从 bentoRuntimePath() 读入;测试传合成壳)。 */
  runtimeHtml: string;
}): Promise<BentoWorkspaceResult<{ revision: number }>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    try {
      await fsp.access(paths.htmlAbs);
      return fail<{ revision: number }>("already_exists", `deck 已存在: ${options.deckId}`);
    } catch {
      // 不存在 → 继续创建。
    }
    const starter = buildStarterBentoDoc(options.title);
    const html = injectBentoDoc(options.runtimeHtml, starter);
    if (html === null) {
      return fail<{ revision: number }>("invalid_doc", "runtime 壳缺少 #bento-doc 块(构建产物损坏?)");
    }
    try {
      await atomicWriteFile(paths.htmlAbs, html);
      await writeMeta(paths.metaAbs, { revision: 0, stage: "draft", outline: null });
    } catch (err) {
      log.error(`[bento] createBentoDeck 落盘失败: ${String(err)}`);
      return fail<{ revision: number }>("io_error", `创建 deck 失败: ${String(err)}`);
    }
    return { ok: true, value: { revision: 0 } };
  });
}

export interface BentoDeckState {
  /** 内嵌文档(块为空时 null:bento 会 boot starter,但正常创建流程不会出现)。 */
  doc: BentoDoc | null;
  /** 原始 JSON 文本(供工具直读,免二次 stringify 造成键序抖动)。 */
  json: string | null;
  revision: number;
  stage: BentoDeckStage;
  outline: unknown;
  htmlAbs: string;
}

/** 读取 deck 状态(doc + revision + HTML 绝对路径)。 */
export async function readBentoDeck(options: {
  workspaceRoot: string;
  deckId: string;
}): Promise<BentoWorkspaceResult<BentoDeckState>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    let html: string;
    try {
      html = await fsp.readFile(paths.htmlAbs, "utf8");
    } catch {
      return fail<BentoDeckState>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const json = extractBentoDocJson(html);
    let doc: BentoDoc | null = null;
    if (json) {
      const parsed = parseBentoDoc(safeJsonParse(json));
      // 文件里已有的文档解析失败不阻断读取(可能是上游新格式):doc 给 null,json 原样透出。
      doc = parsed.ok ? parsed.doc : null;
    }
    const meta = await readMeta(paths.metaAbs);
    return {
      ok: true,
      value: { doc, json, revision: meta.revision, stage: meta.stage, outline: meta.outline, htmlAbs: paths.htmlAbs },
    };
  });
}

/**
 * 用户批准最终提纲后建立整套可见占位页。
 *
 * 这是初始生成能够真正流式落盘的关键:模型不再负责第一次「建页」,而只需按既有 slide id
 * 用 set_slides 填充内容。每批写入都会复用既有 deckChanged → webview 热应用链路。
 */
export async function approveBentoOutline(options: {
  workspaceRoot: string;
  deckId: string;
  outline: Omit<SlidesOutline, "approvedAt">;
}): Promise<BentoWorkspaceResult<{ revision: number }>> {
  const approvedAt = new Date().toISOString();
  const parsedOutline = slidesOutlineSchema.safeParse({ ...options.outline, approvedAt });
  if (!parsedOutline.success || parsedOutline.data.items.length === 0) {
    const detail = parsedOutline.success
      ? "提纲至少需要一页"
      : parsedOutline.error.issues[0]?.message ?? "提纲格式无效";
    return fail("invalid_doc", `无法批准提纲: ${detail}`);
  }
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    let html: string;
    try {
      html = await fsp.readFile(paths.htmlAbs, "utf8");
    } catch {
      return fail<{ revision: number }>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const current = parseBentoDoc(readPrevDoc(html));
    if (!current.ok) {
      return fail<{ revision: number }>("invalid_doc", `当前 deck 无法建立生成骨架: ${current.error}`);
    }
    const meta = await readMeta(paths.metaAbs);
    const slides = parsedOutline.data.items.map((item, index) =>
      buildGenerationPlaceholder(item, index, parsedOutline.data.items.length, current.doc),
    );
    const skeleton = parseBentoDoc({
      ...current.doc,
      slides,
      modified: approvedAt,
    });
    if (!skeleton.ok) {
      return fail<{ revision: number }>("invalid_doc", `生成占位骨架未通过校验: ${skeleton.error}`);
    }
    const next = injectBentoDoc(html, skeleton.doc);
    if (next === null) return fail<{ revision: number }>("invalid_doc", "deck 文件缺少 #bento-doc 块(文件损坏)");
    const revision = meta.revision + 1;
    try {
      await backupOnce(paths.htmlAbs);
      await atomicWriteFile(paths.htmlAbs, next);
      await writeMeta(paths.metaAbs, {
        ...meta,
        revision,
        stage: "outline-approved",
        outline: parsedOutline.data,
      });
    } catch (err) {
      log.error(`[bento] approveBentoOutline 落盘失败: ${String(err)}`);
      return fail<{ revision: number }>("io_error", `建立生成占位页失败: ${String(err)}`);
    }
    // 宿主工作流变更使用 runtime 来源:画布立即热应用,但不把占位页误报成 Agent 已生成内容。
    announceDeckChange({
      workspaceRoot: options.workspaceRoot,
      deckId: options.deckId,
      revision,
      source: "runtime",
      slideIds: slides.map((slide) => slide.id),
      pages: slides.map((_, index) => index + 1),
      slideCount: slides.length,
    });
    return { ok: true, value: { revision } };
  });
}

/**
 * 打开 deck 前的两件维护动作(每次 bentoGetDeck 都会跑,幂等):
 *   1. 换壳:存量 deck 若不是当前 runtime,只替换应用壳、原样保留文档 JSON;
 *   2. 清洗:剥离 collab(在线协作凭据 + CRDT 状态,见 sanitize-deck-doc 的动机)。
 *
 * revision 契约(**已从「换壳一律不动 revision」修订**):
 *   · 纯换壳 → revision 不变(壳不是文档内容,老契约保留);
 *   · 剥离了 collab → **revision + 1** 并广播。因为那是文档内容的改变,若悄悄改而不动
 *     revision,webview 内存文档与磁盘就静默分叉 —— 编辑器回写的 baseRevision 弱锁会
 *     放行一次「带 collab 的旧稿」,与清洗形成来回覆盖的死循环。
 */
export async function ensureBentoDeckRuntime(options: {
  workspaceRoot: string;
  deckId: string;
  runtimeHtml: string;
}): Promise<BentoWorkspaceResult<{ migrated: boolean }>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    const currentRuntimeId = extractBentoRuntimeId(options.runtimeHtml);
    if (!currentRuntimeId) {
      return fail<{ migrated: boolean }>("invalid_doc", "当前 runtime 缺少 cortex-slides-runtime 内容标识");
    }
    let html: string;
    try {
      html = await fsp.readFile(paths.htmlAbs, "utf8");
    } catch {
      return fail<{ migrated: boolean }>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const json = extractBentoDocJson(html);
    if (!json) {
      return fail<{ migrated: boolean }>("invalid_doc", "deck 文件缺少有效的 #bento-doc 文档");
    }
    const doc = safeJsonParse(json);
    if (!doc || typeof doc !== "object") {
      return fail<{ migrated: boolean }>("invalid_doc", "deck 文件缺少有效的 #bento-doc 文档");
    }
    // 加密 deck(bento/enc 信封)不做清洗:结构不是 BentoDoc,宿主不该猜它的字段。
    const sanitized = (doc as { format?: unknown }).format === "bento/enc" ? { doc, stripped: [] } : sanitizeDeckDoc(doc);
    const runtimeStale = extractBentoRuntimeId(html) !== currentRuntimeId;
    const needsClean = sanitized.stripped.length > 0;
    // 两件事都不需要做 → 什么都不写(幂等,每次 bentoGetDeck 都会走到这里)。
    if (!runtimeStale && !needsClean) {
      return { ok: true, value: { migrated: false } };
    }
    // 未清洗时用**原始 JSON 文本**重注:避免 JSON.stringify 造成键序抖动与无意义 diff
    // (既有测试断言纯换壳后 extractBentoDocJson 逐字节不变)。
    const nextJson = needsClean ? JSON.stringify(sanitized.doc) : json;
    // 壳:陈旧才换;只清洗时沿用 deck 自己的壳(避免把「清洗」偷偷变成一次换壳)。
    const shell = runtimeStale ? options.runtimeHtml : html;
    const next = injectBentoDocJson(shell, nextJson, (sanitized.doc as { title?: unknown }).title);
    if (next === null) {
      return fail<{ migrated: boolean }>("invalid_doc", "当前 runtime 壳缺少 #bento-doc 块");
    }
    const meta = needsClean ? await readMeta(paths.metaAbs) : null;
    try {
      if (needsClean) await backupOnce(paths.htmlAbs);
      await atomicWriteFile(paths.htmlAbs, next);
      if (meta) await writeMeta(paths.metaAbs, { ...meta, revision: meta.revision + 1 });
    } catch (err) {
      log.error(`[bento] ensureBentoDeckRuntime 换壳/清洗失败: ${String(err)}`);
      return fail<{ migrated: boolean }>("io_error", `更新演示文稿 runtime 失败: ${String(err)}`);
    }
    if (meta) {
      log.info(`[bento] deck=${options.deckId} 已剥离 ${sanitized.stripped.join(",")} rev=${meta.revision + 1}`);
      announceDeckChange({
        workspaceRoot: options.workspaceRoot,
        deckId: options.deckId,
        revision: meta.revision + 1,
        source: "runtime",
        slideCount: countSlides(sanitized.doc),
      });
    }
    return { ok: true, value: { migrated: true } };
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * 放映换壳:把 deck 内嵌文档 JSON 注入当前 runtime 空壳,返回放映用 HTML。
 * deck.bento.html 携带的是创建时的 runtime,直接放映会让 runtime 侧的修复
 * (如演讲者视图布局)对存量 deck 永远不生效,因此放映一律换当前壳。
 * 返回 null(坏 JSON / 壳缺 #bento-doc 块)时调用方应回退直接加载 deck 原文件。
 */
export function reshellBentoPresentation(deckDocJson: string, runtimeHtml: string): string | null {
  const doc = safeJsonParse(deckDocJson);
  if (!doc || typeof doc !== "object") return null;
  return injectBentoDocJson(runtimeHtml, deckDocJson, (doc as { title?: unknown }).title);
}

/** AI 整份写文档:schema 校验 + expectedRevision 乐观锁 + 原子替换 #bento-doc 块。 */
/** 从磁盘上的 deck HTML 取回上一版文档(仅供合并评论用)。
 *  解析失败一律返回 null —— 合并是「尽力保全」而非守门,绝不能因此挡住 AI 的写盘。 */
function readPrevDoc(html: string): unknown {
  const json = extractBentoDocJson(html);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function writeBentoDoc(options: {
  workspaceRoot: string;
  deckId: string;
  doc: unknown;
  expectedRevision: number;
  /** 随写入一并推进的 gate 阶段(如全篇生成成功后置 ready);缺省保持原样。 */
  stage?: BentoDeckStage;
  /** 本次整份文档写入对应的用户可见活动;缺省表示真正的整篇重写。 */
  activity?: { kind: "asset"; assetKey: string };
}): Promise<BentoWorkspaceResult<{ revision: number }>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  const parsed = parseBentoDoc(options.doc);
  if (!parsed.ok) return fail("invalid_doc", `文档未通过校验: ${parsed.error}`);
  return enqueueDeck(paths.deckRootAbs, async () => {
    let html: string;
    try {
      html = await fsp.readFile(paths.htmlAbs, "utf8");
    } catch {
      return fail<{ revision: number }>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const meta = await readMeta(paths.metaAbs);
    if (meta.revision !== options.expectedRevision) {
      return fail<{ revision: number }>(
        "revision_conflict",
        `revision 冲突: 当前 ${meta.revision},期望 ${options.expectedRevision}(先 get_deck_state 取最新再改)`,
      );
    }
    // 评论保全:set_deck_doc 是整份覆盖,而工具描述与 prompt 都没提 comments —— 它属于
    // 编辑器语义(用户的评审数据),不属于 AI 的创作范围。只要模型没原样抄回来,用户的评论
    // 就会在下一次改稿时静默消失。这里按 slide id 确定性补回,不赌模型自觉。
    // AI 若显式给了 comments(含空数组 = 主动清空)则以新的为准。
    // collab 剥离:模型原样抄回 get_deck_state 给的 collab 是常态,而那份凭据会让编辑器
    // 每次打开都连公共中继、把历史世代的元素并集合并回来(见 sanitize-deck-doc 的文件头)。
    const merged = sanitizeDeckDoc(mergeSlideComments(readPrevDoc(html), parsed.doc)).doc;
    const next = injectBentoDoc(html, merged);
    if (next === null) return fail<{ revision: number }>("invalid_doc", "deck 文件缺少 #bento-doc 块(文件损坏)");
    try {
      await backupOnce(paths.htmlAbs);
      await atomicWriteFile(paths.htmlAbs, next);
      await writeMeta(paths.metaAbs, { ...meta, revision: meta.revision + 1, stage: options.stage ?? meta.stage });
    } catch (err) {
      log.error(`[bento] writeBentoDoc 落盘失败: ${String(err)}`);
      return fail<{ revision: number }>("io_error", `写入失败: ${String(err)}`);
    }
    announceDeckChange({
      workspaceRoot: options.workspaceRoot,
      deckId: options.deckId,
      revision: meta.revision + 1,
      source: "agent",
      slideCount: countSlides(merged),
      ...(options.activity?.kind === "asset" ? { assetKey: options.activity.assetKey } : {}),
    });
    return { ok: true, value: { revision: meta.revision + 1 } };
  });
}

/**
 * 局部写入:按 slide id 整页替换,其余页原样保留。
 *
 * 与 writeBentoDoc 走完全相同的队列 / 乐观锁 / 原子写 / schema 守门 —— 唯一区别是
 * Agent 只需给出被改的那几页,而不是整份 ~12 万字符的文档(见 slide-patch.ts 的动机)。
 * 合并后仍跑一次 parseBentoDoc:局部改动照样可能写出非法结构,守门不能因为「只改一页」放松。
 */
export async function writeBentoSlides(options: {
  workspaceRoot: string;
  deckId: string;
  slides: unknown;
  expectedRevision: number;
}): Promise<
  BentoWorkspaceResult<{
    revision: number;
    replacedIds: string[];
    replacedPages: number[];
    stage: BentoDeckStage;
    remainingPages: number[];
  }>
> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  type Out = {
    revision: number;
    replacedIds: string[];
    replacedPages: number[];
    stage: BentoDeckStage;
    remainingPages: number[];
  };
  return enqueueDeck(paths.deckRootAbs, async () => {
    let html: string;
    try {
      html = await fsp.readFile(paths.htmlAbs, "utf8");
    } catch {
      return fail<Out>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const meta = await readMeta(paths.metaAbs);
    if (meta.revision !== options.expectedRevision) {
      return fail<Out>(
        "revision_conflict",
        `revision 冲突: 当前 ${meta.revision},期望 ${options.expectedRevision}(先 get_deck_state 取最新再改)`,
      );
    }
    // slide-patch 的 invalid_slides / unknown_slide_id 不在 IPC 错误码契约里(这条路径
    // 只在主进程内部走,不过 IPC),统一映射为 invalid_doc,可自纠的细节留在 message。
    const previousDoc = readPrevDoc(html);
    const pendingBefore = pendingBentoGenerationPages(previousDoc);
    const patched = applySlideReplacements(previousDoc, options.slides);
    if (!patched.ok) return fail<Out>("invalid_doc", patched.message);
    // 被替换的占位页无论模型是否原样带回宿主标记,都视为已经生成并剥掉标记。
    const replaced = new Set(patched.replacedIds);
    const patchedRecord = patched.doc as { slides?: unknown[] } & Record<string, unknown>;
    const withoutCompletedMarkers = {
      ...patchedRecord,
      slides: Array.isArray(patchedRecord.slides)
        ? patchedRecord.slides.map((slide) => {
            if (!slide || typeof slide !== "object" || !replaced.has(String((slide as { id?: unknown }).id))) {
              return slide;
            }
            const {
              [BENTO_PENDING_GENERATION_FIELD]: _completed,
              ...completeSlide
            } = slide as Record<string, unknown>;
            return completeSlide;
          })
        : patchedRecord.slides,
    };
    const parsed = parseBentoDoc(withoutCompletedMarkers);
    if (!parsed.ok) return fail<Out>("invalid_doc", `替换后的文档未通过校验: ${parsed.error}`);
    // 与整份写入同一条评论保全逻辑(未被替换的页天然保留;被替换的页若没带 comments 则补回)。
    // collab 剥离:模型原样抄回 get_deck_state 给的 collab 是常态,而那份凭据会让编辑器
    // 每次打开都连公共中继、把历史世代的元素并集合并回来(见 sanitize-deck-doc 的文件头)。
    const merged = sanitizeDeckDoc(mergeSlideComments(readPrevDoc(html), parsed.doc)).doc;
    const remainingPages = pendingBentoGenerationPages(merged);
    const nextStage =
      meta.stage === "outline-approved" && pendingBefore.length > 0 && remainingPages.length === 0
        ? "ready"
        : meta.stage;
    const next = injectBentoDoc(html, merged);
    if (next === null) return fail<Out>("invalid_doc", "deck 文件缺少 #bento-doc 块(文件损坏)");
    try {
      await backupOnce(paths.htmlAbs);
      await atomicWriteFile(paths.htmlAbs, next);
      await writeMeta(paths.metaAbs, { ...meta, revision: meta.revision + 1, stage: nextStage });
    } catch (err) {
      log.error(`[bento] writeBentoSlides 落盘失败: ${String(err)}`);
      return fail<Out>("io_error", `写入失败: ${String(err)}`);
    }
    announceDeckChange({
      workspaceRoot: options.workspaceRoot,
      deckId: options.deckId,
      revision: meta.revision + 1,
      source: "agent",
      slideIds: patched.replacedIds,
      pages: patched.replacedPages,
      slideCount: countSlides(merged),
    });
    return {
      ok: true,
      value: {
        revision: meta.revision + 1,
        replacedIds: patched.replacedIds,
        replacedPages: patched.replacedPages,
        stage: nextStage,
        remainingPages,
      },
    };
  });
}

/**
 * 编辑器 autosave:整份 HTML 直写。仅做完整性/体量守门 + **弱**乐观锁。
 *
 * 为什么需要弱锁(用户实测的丢稿通路):webview 里的文档若已过期(AI 刚写过盘而页面还没
 * 刷新),这条无锁路径会把旧稿整份盖回去 —— AI 改的十几页静默消失。
 *   · baseRevision 省略 → last-writer 旧行为(兼容旧壳/旧渲染端);
 *   · 与磁盘一致 → 接受,revision + 1;
 *   · 落后 → revision_conflict(复用既有错误码:这个函数此前不可能返回它,语义无歧义)。
 * 渲染端收到冲突不应报错,而是丢弃这份旧 HTML 并刷新到最新稿(见 SlidesStage)。
 */
export async function writeBentoDeckHtml(options: {
  workspaceRoot: string;
  deckId: string;
  html: string;
  /** webview 内存文档对应的磁盘 revision;省略即不校验。 */
  baseRevision?: number;
  /**
   * 当前 bento runtime 壳。提供时把回写产物规范化为「当前壳 + 传入的 #bento-doc」——
   * 上游 capturePristine 会把 loader 注入的 92KB 应用 CSS 逐世代烙进产物(实测 10 份重复、
   * 文件 1.5MB,逼近 fs:readFile 的 2MB 截断线)。省略则原样直写(旧行为)。
   * 由调用方注入而非本模块自取:bento-runtime 依赖 electron.app,持久层不能 import electron。
   */
  runtimeHtml?: string;
}): Promise<BentoWorkspaceResult<{ revision: number }>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  // 体量守门用**传入**字节数:规范化产物必然更小,先拦住失控调用方。
  if (typeof options.html !== "string" || Buffer.byteLength(options.html, "utf8") > MAX_DECK_HTML_BYTES) {
    return fail("too_large", `deck HTML 超出 ${MAX_DECK_HTML_BYTES} 字节上限`);
  }
  // 编辑器序列化产物必含非空 #bento-doc 块;缺块说明调用方传了坏内容,拒写保护旧文件。
  if (!extractBentoDocJson(options.html)) {
    return fail("invalid_doc", "HTML 缺少非空 #bento-doc 块,拒绝覆盖 deck 文件");
  }
  // 规范化(可选):no_doc_block 已被上面拦住;bad_shell(壳损坏)回落原样写入 ——
  // 壳的问题不该拦住用户保存自己的编辑。
  let htmlToWrite = options.html;
  if (options.runtimeHtml) {
    const normalized = normalizeDeckHtml(options.html, options.runtimeHtml);
    if (normalized.ok) htmlToWrite = normalized.html;
    else log.error(`[bento] deck HTML 规范化失败(回落原样写入): ${normalized.code} ${normalized.message}`);
  }
  return enqueueDeck(paths.deckRootAbs, async () => {
    try {
      await fsp.access(paths.htmlAbs);
    } catch {
      return fail<{ revision: number }>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const meta = await readMeta(paths.metaAbs);
    if (options.baseRevision !== undefined && meta.revision !== options.baseRevision) {
      return fail<{ revision: number }>(
        "revision_conflict",
        `编辑器持有 rev ${options.baseRevision},磁盘已到 rev ${meta.revision}:放弃本次回写并刷新到最新稿`,
      );
    }
    try {
      await backupOnce(paths.htmlAbs);
      await atomicWriteFile(paths.htmlAbs, htmlToWrite);
      await writeMeta(paths.metaAbs, { ...meta, revision: meta.revision + 1 });
    } catch (err) {
      log.error(`[bento] writeBentoDeckHtml 落盘失败: ${String(err)}`);
      return fail<{ revision: number }>("io_error", `写入失败: ${String(err)}`);
    }
    announceDeckChange({
      workspaceRoot: options.workspaceRoot,
      deckId: options.deckId,
      revision: meta.revision + 1,
      source: "editor",
      slideCount: countSlides(readPrevDoc(htmlToWrite)),
    });
    return { ok: true, value: { revision: meta.revision + 1 } };
  });
}

/** 更新 gate 阶段/提纲草案(不动 HTML 本体,revision 不变;队列内串行)。 */
export async function updateBentoDeckMeta(options: {
  workspaceRoot: string;
  deckId: string;
  patch: { stage?: BentoDeckStage; outline?: unknown };
}): Promise<BentoWorkspaceResult<{ stage: BentoDeckStage }>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    try {
      await fsp.access(paths.htmlAbs);
    } catch {
      return fail<{ stage: BentoDeckStage }>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const meta = await readMeta(paths.metaAbs);
    const next: BentoDeckMeta = {
      ...meta,
      stage: options.patch.stage ?? meta.stage,
      outline: "outline" in options.patch ? options.patch.outline : meta.outline,
    };
    try {
      await writeMeta(paths.metaAbs, next);
    } catch (err) {
      log.error(`[bento] updateBentoDeckMeta 落盘失败: ${String(err)}`);
      return fail<{ stage: BentoDeckStage }>("io_error", `写入失败: ${String(err)}`);
    }
    return { ok: true, value: { stage: next.stage } };
  });
}

// ── 研究来源清单（演示文稿检索，spec §15.3）───────────────────────────────────
//
// 单独一个 JSON 文件而不是塞进 deck.meta.json：meta 是 revision 乐观锁的载体，
// 每次写页面都会读改写它；来源清单是低频追加的溯源材料，混在一起会让两种写入互相等锁，
// 也会让一次来源追加意外碰到页面写入的版本冲突。

/// 一条被引用的来源。chunkId 留空是允许的——窄面检索不落库，引用锚在 URL 上
/// （见 core/research/quick-types 的文件头）。
export interface SlidesSourceEntry {
  url: string;
  title: string;
  /// 这条来源支撑的是哪一页 / 哪个论点（agent 自己填，用于演讲者核对）。
  usedFor?: string;
  /// 深度研究产物才有的证据片段 id；窄面检索留空。
  chunkId?: string;
  addedAt: string;
}

export interface SlidesSourcesManifest {
  version: 1;
  sources: SlidesSourceEntry[];
}

/// 空清单**必须每次新造**，不能共享一个常量再浅拷贝。
///
/// 真实踩过：写成 `const EMPTY = { version: 1, sources: [] }` + `{ ...EMPTY }`，
/// 展开是浅拷贝，`sources` 仍指向同一个数组——调用方一 push，模块级那个数组就被污染，
/// 于是「另一个 deck 的空清单」凭空带上了别处的来源。测试里表现为跨 deck 串数据。
function emptySources(): SlidesSourcesManifest {
  return { version: 1, sources: [] };
}

/// 读来源清单。文件不存在 / 解析失败一律回空清单——
/// 这是纯追加的溯源材料，读坏了不该让整个 deck 写入流程失败。
async function readSources(sourcesAbs: string): Promise<SlidesSourcesManifest> {
  try {
    const raw = JSON.parse(await fsp.readFile(sourcesAbs, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptySources();
    const sources = (raw as { sources?: unknown }).sources;
    return { version: 1, sources: Array.isArray(sources) ? (sources as SlidesSourceEntry[]) : [] };
  } catch {
    return emptySources();
  }
}

/// 单个 deck 最多保留的来源条数。上限存在的理由：agent 可能在长回合里反复 add_source，
/// 没有上限的话这个文件会无限增长；超出时丢最早的（新来源通常更贴近当前正在做的页面）。
export const MAX_SLIDES_SOURCES = 200;

/// 追加一条来源。**按 URL 去重**：同一篇资料支撑多页是常态，
/// 重复条目只会让演讲者核对时反复看到同一个链接。已存在时更新 usedFor 而不是新增。
export async function appendSlidesSource(options: {
  workspaceRoot: string;
  deckId: string;
  entry: SlidesSourceEntry;
}): Promise<BentoWorkspaceResult<{ total: number }>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    try {
      await fsp.access(paths.htmlAbs);
    } catch {
      return fail<{ total: number }>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const manifest = await readSources(paths.sourcesAbs);
    const existing = manifest.sources.findIndex((s) => s.url === options.entry.url);
    if (existing >= 0) {
      manifest.sources[existing] = { ...manifest.sources[existing], ...options.entry };
    } else {
      manifest.sources.push(options.entry);
      if (manifest.sources.length > MAX_SLIDES_SOURCES) {
        manifest.sources = manifest.sources.slice(-MAX_SLIDES_SOURCES);
      }
    }
    try {
      await atomicWriteFile(paths.sourcesAbs, JSON.stringify(manifest, null, 2));
    } catch (err) {
      log.error(`[bento] appendSlidesSource 落盘失败: ${String(err)}`);
      return fail<{ total: number }>("io_error", `写入失败: ${String(err)}`);
    }
    return { ok: true, value: { total: manifest.sources.length } };
  });
}

/// 读全部来源（导出「附来源页」与 UI 展示用）。
export async function readSlidesSources(options: {
  workspaceRoot: string;
  deckId: string;
}): Promise<BentoWorkspaceResult<SlidesSourcesManifest>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  return { ok: true, value: await readSources(resolved.value.sourcesAbs) };
}
