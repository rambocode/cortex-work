// bento deck 主进程持久化层:deck.bento.html(自包含单文件)+ deck.meta.json(revision)。
// 取代旧 slot-HTML 体系的 workspace.ts,契约收敛为三条:
//   1. 路径安全:workspaceRoot realpath;deck 根拒符号链接;所有写入路径限定 deck 根内。
//   2. 原子性 + 串行:临时文件 + rename;同一 deck 的读改写走进程内队列,
//      AI 的 writeBentoDoc 与编辑器 autosave 的 writeBentoDeckHtml 并发时不互相撕裂。
//   3. 乐观锁:AI 整份写文档须带 expectedRevision(不匹配 → revision_conflict);
//      编辑器 autosave 是就地权威,不带锁,直接 last-writer(队列内串行)。
// revision 存 sidecar deck.meta.json:HTML 本体是 bento 的领地,宿主元数据不污染其格式;
// meta 缺失(用户手动拷入文件)按 revision 0 处理,下次写入时重建。
import { promises as fsp } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  parseBentoDoc,
  type BentoDoc,
} from "@cortex-work/core/design/slides/bento/bento-doc-schema";
import { buildStarterBentoDoc } from "@cortex-work/core/design/slides/bento/bento-doc-schema";
import {
  extractBentoDocJson,
  extractBentoRuntimeId,
  injectBentoDoc,
  injectBentoDocJson,
} from "@cortex-work/core/design/slides/bento/bento-embed";
import {
  bentoDeckHtmlPath,
  bentoDeckMetaPath,
  isValidDeckId,
  slidesDeckRootPath,
  slidesSourcesManifestPath,
} from "@cortex-work/core/design/slides/slides-paths";
import { createLogger } from "../../log";

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
 * 编辑器换壳:存量 deck 若不是当前 runtime,只替换应用壳并原样保留文档 JSON。
 * sidecar 元数据不参与写入,因此 revision/stage/outline 均保持不变。
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
    if (extractBentoRuntimeId(html) === currentRuntimeId) {
      return { ok: true, value: { migrated: false } };
    }
    const next = injectBentoDocJson(options.runtimeHtml, json, (doc as { title?: unknown }).title);
    if (next === null) {
      return fail<{ migrated: boolean }>("invalid_doc", "当前 runtime 壳缺少 #bento-doc 块");
    }
    try {
      await atomicWriteFile(paths.htmlAbs, next);
      return { ok: true, value: { migrated: true } };
    } catch (err) {
      log.error(`[bento] ensureBentoDeckRuntime 换壳失败: ${String(err)}`);
      return fail<{ migrated: boolean }>("io_error", `更新演示文稿 runtime 失败: ${String(err)}`);
    }
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
export async function writeBentoDoc(options: {
  workspaceRoot: string;
  deckId: string;
  doc: unknown;
  expectedRevision: number;
  /** 随写入一并推进的 gate 阶段(如全篇生成成功后置 ready);缺省保持原样。 */
  stage?: BentoDeckStage;
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
    const next = injectBentoDoc(html, parsed.doc);
    if (next === null) return fail<{ revision: number }>("invalid_doc", "deck 文件缺少 #bento-doc 块(文件损坏)");
    try {
      await atomicWriteFile(paths.htmlAbs, next);
      await writeMeta(paths.metaAbs, { ...meta, revision: meta.revision + 1, stage: options.stage ?? meta.stage });
    } catch (err) {
      log.error(`[bento] writeBentoDoc 落盘失败: ${String(err)}`);
      return fail<{ revision: number }>("io_error", `写入失败: ${String(err)}`);
    }
    return { ok: true, value: { revision: meta.revision + 1 } };
  });
}

/** 编辑器 autosave:整份 HTML 直写(就地权威,无锁),仅做完整性与体量守门。 */
export async function writeBentoDeckHtml(options: {
  workspaceRoot: string;
  deckId: string;
  html: string;
}): Promise<BentoWorkspaceResult<{ revision: number }>> {
  const resolved = await resolveBentoDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  if (typeof options.html !== "string" || Buffer.byteLength(options.html, "utf8") > MAX_DECK_HTML_BYTES) {
    return fail("too_large", `deck HTML 超出 ${MAX_DECK_HTML_BYTES} 字节上限`);
  }
  // 编辑器序列化产物必含非空 #bento-doc 块;缺块说明调用方传了坏内容,拒写保护旧文件。
  if (!extractBentoDocJson(options.html)) {
    return fail("invalid_doc", "HTML 缺少非空 #bento-doc 块,拒绝覆盖 deck 文件");
  }
  return enqueueDeck(paths.deckRootAbs, async () => {
    try {
      await fsp.access(paths.htmlAbs);
    } catch {
      return fail<{ revision: number }>("not_found", `deck 不存在: ${options.deckId}`);
    }
    const meta = await readMeta(paths.metaAbs);
    try {
      await atomicWriteFile(paths.htmlAbs, options.html);
      await writeMeta(paths.metaAbs, { ...meta, revision: meta.revision + 1 });
    } catch (err) {
      log.error(`[bento] writeBentoDeckHtml 落盘失败: ${String(err)}`);
      return fail<{ revision: number }>("io_error", `写入失败: ${String(err)}`);
    }
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
