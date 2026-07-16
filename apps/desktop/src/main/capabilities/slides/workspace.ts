// Slides deck 主进程持久化层:deck.json 与 slide HTML 的唯一写入口。
// 安全与一致性契约(所有 IPC handler 与 MCP 工具都必须走这里,不得自己碰 fs):
//   1. 路径:workspaceRoot 先 realpath;deck 内所有目标路径由 core 纯函数 builder 构造,
//      写前对「已存在的祖先目录」realpath 并验证仍在 deck 根内,目标本体 lstat 拒符号链接。
//   2. 原子性:manifest / HTML 一律临时文件 + rename;进程中途退出不会留下半个文件。
//   3. 乐观锁:每次 manifest 变更要求 expectedRevision,不匹配返回 revision_conflict;
//      同一 deck 的读-改-写经进程内队列串行,并发工具调用不会互相覆盖。
//   4. 恢复:deck.json 损坏时若存在合法的 deck.json.tmp 则晋升恢复;删除 slide 先移入
//      .trash/ 软删,manifest 落盘成功后才异步清理。
import { promises as fsp } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  parseSlidesManifest,
  serializeSlidesManifest,
} from "@cortex-work/core/design/slides/slides-schema";
import {
  createEmptySlidesDeckManifest,
  type SlidesDeckManifest,
  type SlidesError,
  type SlidesSlot,
} from "@cortex-work/core/design/slides/slides-types";
import {
  isValidDeckId,
  isValidSlotId,
  slidesDeckDirectories,
  slidesDeckRootPath,
  slidesManifestPath,
  slidesSlideHtmlPath,
  slidesTrashDirPath,
} from "@cortex-work/core/design/slides/slides-paths";
import { createLogger } from "../../log";

const log = createLogger("slides");

// 单页 HTML 字节上限(与 MCP place_slide_html / IPC 保存共用;超限一律 too_large)。
export const MAX_SLIDE_HTML_BYTES = 2 * 1024 * 1024;

export type SlidesWorkspaceResult<T> = { ok: true; value: T } | { ok: false; error: SlidesError };

function fail<T>(code: SlidesError["code"], message: string): SlidesWorkspaceResult<T> {
  return { ok: false, error: { code, message } };
}

// ---- 每 deck 串行队列:读-改-写不并发,避免两个工具调用交错覆盖 manifest。----
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

// ---- 路径解析与校验 ----

export interface DeckPaths {
  /** realpath 后的工作区根(绝对路径)。 */
  realWorkspaceRoot: string;
  /** deck 根绝对路径(realWorkspaceRoot + .cortex-design/<deckId>)。 */
  deckRootAbs: string;
  manifestAbs: string;
}

/** 严格分隔符边界的根包含检查(两侧都应是绝对路径)。 */
function isInsideRoot(rootAbs: string, targetAbs: string): boolean {
  return targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep);
}

/**
 * 解析并校验 deck 根。workspaceRoot 必须真实存在(realpath 失败即拒);deck 根若已存在,
 * 其 realpath 必须仍在工作区内(拒符号链接把 deck 根指到外部)。
 */
export async function resolveDeckPaths(
  workspaceRoot: string,
  deckId: string,
): Promise<SlidesWorkspaceResult<DeckPaths>> {
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
    // deck 根还不存在:创建流程允许;读取流程会在后续 not_found。
  }
  return {
    ok: true,
    value: {
      realWorkspaceRoot,
      deckRootAbs,
      manifestAbs: resolve(realWorkspaceRoot, slidesManifestPath(deckId)),
    },
  };
}

/**
 * 校验一个 deck 内目标文件的绝对路径可安全写入:最近的已存在祖先目录 realpath 后必须
 * 仍在 deck 根内(拒目录符号链接逃逸),目标本体若已存在则 lstat 拒符号链接。
 */
async function assertWritablePath(paths: DeckPaths, targetAbs: string): Promise<SlidesError | null> {
  if (!isInsideRoot(paths.deckRootAbs, targetAbs)) {
    return { code: "invalid_path", message: `目标路径越出 deck 根: ${targetAbs}` };
  }
  // 找最近已存在的祖先目录做 realpath 校验(中间目录可能尚未创建)。
  let ancestor = dirname(targetAbs);
  while (true) {
    try {
      const real = await fsp.realpath(ancestor);
      if (!isInsideRoot(paths.realWorkspaceRoot, real)) {
        return { code: "invalid_path", message: "路径祖先目录解析后越出工作区" };
      }
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  try {
    const st = await fsp.lstat(targetAbs);
    if (st.isSymbolicLink()) return { code: "invalid_path", message: "目标不允许是符号链接" };
  } catch {
    // 不存在 = 新建,允许。
  }
  return null;
}

/** 临时文件 + rename 的原子写(UTF-8 文本)。失败时清理 tmp,不破坏旧文件。 */
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

// ---- deck 生命周期 ----

/** 创建 deck 工作区:完整目录骨架 + 合法的空 deck.json。已存在则 already_exists。 */
export async function createDeckWorkspace(options: {
  workspaceRoot: string;
  deckId: string;
  title: string;
  now?: string;
}): Promise<SlidesWorkspaceResult<SlidesDeckManifest>> {
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    try {
      await fsp.access(paths.manifestAbs);
      return fail<SlidesDeckManifest>("already_exists", `deck 已存在: ${options.deckId}`);
    } catch {
      // 不存在,继续创建。
    }
    const manifest = createEmptySlidesDeckManifest({
      id: options.deckId,
      title: options.title,
      now: options.now ?? new Date().toISOString(),
    });
    try {
      for (const dir of slidesDeckDirectories(options.deckId)) {
        await fsp.mkdir(resolve(paths.realWorkspaceRoot, dir), { recursive: true });
      }
      await atomicWriteFile(paths.manifestAbs, serializeSlidesManifest(manifest));
    } catch (err) {
      log.error("createDeckWorkspace failed:", err);
      return fail<SlidesDeckManifest>("io_error", "创建 deck 目录或 manifest 失败");
    }
    return { ok: true as const, value: manifest };
  });
}

/**
 * 读取并校验 deck.json。恢复策略:主文件损坏/缺失而 deck.json.tmp 是合法 manifest 时,
 * 晋升 tmp 为正式文件并返回(recovered=true);两者皆坏 → invalid_manifest。
 */
export async function loadDeckManifest(options: {
  workspaceRoot: string;
  deckId: string;
}): Promise<SlidesWorkspaceResult<{ manifest: SlidesDeckManifest; recovered: boolean }>> {
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, () => loadDeckManifestUnlocked(paths, options.deckId));
}

async function loadDeckManifestUnlocked(
  paths: DeckPaths,
  deckId: string,
): Promise<SlidesWorkspaceResult<{ manifest: SlidesDeckManifest; recovered: boolean }>> {
  const tmpPath = `${paths.manifestAbs}.tmp`;
  let mainRaw: string | null = null;
  try {
    mainRaw = await fsp.readFile(paths.manifestAbs, "utf8");
  } catch {
    mainRaw = null;
  }
  if (mainRaw !== null) {
    const parsed = parseSlidesManifest(mainRaw);
    if (parsed.ok && parsed.manifest.id === deckId) {
      // 主文件健康:清掉可能残留的旧 tmp,避免下次误判恢复。
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      return { ok: true, value: { manifest: parsed.manifest, recovered: false } };
    }
  }
  // 主文件缺失或损坏 → 尝试 tmp 恢复。
  let tmpRaw: string | null = null;
  try {
    tmpRaw = await fsp.readFile(tmpPath, "utf8");
  } catch {
    tmpRaw = null;
  }
  if (tmpRaw !== null) {
    const parsedTmp = parseSlidesManifest(tmpRaw);
    if (parsedTmp.ok && parsedTmp.manifest.id === deckId) {
      try {
        await fsp.rename(tmpPath, paths.manifestAbs);
      } catch {
        // 晋升失败不阻断读取:内容已在内存,下一次写入会重建主文件。
      }
      log.warn(`deck.json 从 tmp 恢复: ${deckId}`);
      return { ok: true, value: { manifest: parsedTmp.manifest, recovered: true } };
    }
  }
  if (mainRaw === null && tmpRaw === null) {
    return fail("not_found", `deck 不存在: ${deckId}`);
  }
  return fail("invalid_manifest", `deck.json 损坏且无可恢复副本: ${deckId}`);
}

/**
 * 乐观锁 manifest 更新:load → 校验 revision → mutate(纯函数)→ revision+1 →
 * schema 复检 → 原子落盘。mutate 返回 null 表示放弃(无变更)。
 */
export async function updateDeckManifest(options: {
  workspaceRoot: string;
  deckId: string;
  expectedRevision: number;
  mutate: (manifest: SlidesDeckManifest) => SlidesDeckManifest | null;
  now?: string;
}): Promise<SlidesWorkspaceResult<SlidesDeckManifest>> {
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    const loaded = await loadDeckManifestUnlocked(paths, options.deckId);
    if (!loaded.ok) return loaded;
    const current = loaded.value.manifest;
    if (current.revision !== options.expectedRevision) {
      return fail<SlidesDeckManifest>(
        "revision_conflict",
        `revision 不匹配: 期望 ${options.expectedRevision},当前 ${current.revision}`,
      );
    }
    // mutate 在深拷贝上进行,失败时原 manifest 不受影响。
    const draft = structuredClone(current);
    const mutated = options.mutate(draft);
    if (mutated === null) return { ok: true as const, value: current };
    mutated.revision = current.revision + 1;
    mutated.updatedAt = options.now ?? new Date().toISOString();
    const validated = parseSlidesManifest(mutated);
    if (!validated.ok) {
      return { ok: false as const, error: validated.error };
    }
    try {
      await atomicWriteFile(paths.manifestAbs, serializeSlidesManifest(validated.manifest));
    } catch (err) {
      log.error("updateDeckManifest write failed:", err);
      return fail<SlidesDeckManifest>("io_error", "manifest 写入失败");
    }
    return { ok: true as const, value: validated.manifest };
  });
}

/**
 * 写单页 HTML 并同步 manifest(slot revision+1、状态、时间戳)。slot 必须已在 manifest 中;
 * expectedRevision 针对 deck 级 revision(与其他写工具一致)。
 */
export async function writeSlideHtml(options: {
  workspaceRoot: string;
  deckId: string;
  slotId: string;
  html: string;
  expectedRevision: number;
  status?: SlidesSlot["status"];
  now?: string;
}): Promise<SlidesWorkspaceResult<SlidesDeckManifest>> {
  if (!isValidSlotId(options.slotId)) return fail("invalid_path", `非法 slot id: ${options.slotId}`);
  if (typeof options.html !== "string" || options.html.length === 0) {
    return fail("invalid_payload", "HTML 内容为空");
  }
  if (Buffer.byteLength(options.html, "utf8") > MAX_SLIDE_HTML_BYTES) {
    return fail("too_large", `HTML 超过 ${MAX_SLIDE_HTML_BYTES} 字节上限`);
  }
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    const loaded = await loadDeckManifestUnlocked(paths, options.deckId);
    if (!loaded.ok) return loaded;
    const current = loaded.value.manifest;
    if (current.revision !== options.expectedRevision) {
      return fail<SlidesDeckManifest>(
        "revision_conflict",
        `revision 不匹配: 期望 ${options.expectedRevision},当前 ${current.revision}`,
      );
    }
    const slot = current.slides.find((s) => s.id === options.slotId);
    if (!slot) return fail<SlidesDeckManifest>("not_found", `slot 不存在: ${options.slotId}`);
    const htmlAbs = resolve(paths.realWorkspaceRoot, slidesSlideHtmlPath(options.deckId, options.slotId));
    const pathError = await assertWritablePath(paths, htmlAbs);
    if (pathError) return { ok: false as const, error: pathError };
    const now = options.now ?? new Date().toISOString();
    try {
      // 先落 HTML,再落 manifest:HTML 成功而 manifest 失败时旧 manifest 仍指向合法文件。
      await atomicWriteFile(htmlAbs, options.html);
      const next = structuredClone(current);
      const nextSlot = next.slides.find((s) => s.id === options.slotId)!;
      nextSlot.revision += 1;
      nextSlot.status = options.status ?? "ready";
      nextSlot.updatedAt = now;
      nextSlot.htmlPath = slidesSlideHtmlPath(options.deckId, options.slotId);
      next.revision = current.revision + 1;
      next.updatedAt = now;
      await atomicWriteFile(paths.manifestAbs, serializeSlidesManifest(next));
      return { ok: true as const, value: next };
    } catch (err) {
      log.error("writeSlideHtml failed:", err);
      return fail<SlidesDeckManifest>("io_error", "slide HTML 写入失败");
    }
  });
}

/** 读取单页 HTML(路径经 lstat 拒符号链接 + 根边界校验)。 */
export async function readSlideHtml(options: {
  workspaceRoot: string;
  deckId: string;
  slotId: string;
}): Promise<SlidesWorkspaceResult<string>> {
  if (!isValidSlotId(options.slotId)) return fail("invalid_path", `非法 slot id: ${options.slotId}`);
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  const htmlAbs = resolve(paths.realWorkspaceRoot, slidesSlideHtmlPath(options.deckId, options.slotId));
  try {
    const st = await fsp.lstat(htmlAbs);
    if (st.isSymbolicLink()) return fail("invalid_path", "slide 文件不允许是符号链接");
    const real = await fsp.realpath(htmlAbs);
    if (!isInsideRoot(paths.deckRootAbs, real)) return fail("invalid_path", "slide 文件越出 deck 根");
    return { ok: true, value: await fsp.readFile(real, "utf8") };
  } catch {
    return fail("not_found", `slide 文件不存在: ${options.slotId}`);
  }
}

/**
 * 软删 slot:HTML/notes/snapshot 先移入 .trash/<ts>-<slotId>.*,manifest 更新成功后
 * 才算删除完成;.trash 清理由后台异步 best-effort,失败不影响一致性。
 */
export async function deleteSlide(options: {
  workspaceRoot: string;
  deckId: string;
  slotId: string;
  expectedRevision: number;
  now?: string;
}): Promise<SlidesWorkspaceResult<SlidesDeckManifest>> {
  if (!isValidSlotId(options.slotId)) return fail("invalid_path", `非法 slot id: ${options.slotId}`);
  const resolved = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueDeck(paths.deckRootAbs, async () => {
    const loaded = await loadDeckManifestUnlocked(paths, options.deckId);
    if (!loaded.ok) return loaded;
    const current = loaded.value.manifest;
    if (current.revision !== options.expectedRevision) {
      return fail<SlidesDeckManifest>(
        "revision_conflict",
        `revision 不匹配: 期望 ${options.expectedRevision},当前 ${current.revision}`,
      );
    }
    const slot = current.slides.find((s) => s.id === options.slotId);
    if (!slot) return fail<SlidesDeckManifest>("not_found", `slot 不存在: ${options.slotId}`);
    const now = options.now ?? new Date().toISOString();
    const trashDirAbs = resolve(paths.realWorkspaceRoot, slidesTrashDirPath(options.deckId));
    const stamp = now.replace(/[:.]/g, "-");
    try {
      await fsp.mkdir(trashDirAbs, { recursive: true });
      // 逐个软删 slot 关联文件;文件不存在时跳过(生成中/空 slot)。
      for (const rel of [slot.htmlPath, slot.notesPath, slot.snapshotPath]) {
        if (!rel) continue;
        const abs = resolve(paths.realWorkspaceRoot, rel);
        if (!isInsideRoot(paths.deckRootAbs, abs)) continue;
        const base = `${stamp}-${abs.split(sep).pop()}`;
        await fsp.rename(abs, join(trashDirAbs, base)).catch(() => undefined);
      }
      const next = structuredClone(current);
      next.slides = next.slides.filter((s) => s.id !== options.slotId);
      if (next.activeSlideId === options.slotId) {
        next.activeSlideId = next.slides[0]?.id ?? null;
      }
      next.revision = current.revision + 1;
      next.updatedAt = now;
      await atomicWriteFile(paths.manifestAbs, serializeSlidesManifest(next));
      return { ok: true as const, value: next };
    } catch (err) {
      log.error("deleteSlide failed:", err);
      return fail<SlidesDeckManifest>("io_error", "删除 slide 失败");
    }
  });
}
