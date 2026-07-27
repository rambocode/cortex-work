// bento deck 持久层测试:真实文件系统(mkdtemp)验证创建/读写/乐观锁/串行化/路径安全。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBentoDocJson, injectBentoDoc } from "@cortex-work/core/design/slides/bento/bento-embed";
import { buildStarterBentoDoc } from "@cortex-work/core/design/slides/bento/bento-doc-schema";

vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  MAX_SLIDES_SOURCES,
  appendSlidesSource,
  createBentoDeck,
  ensureBentoDeckRuntime,
  readBentoDeck,
  readSlidesSources,
  reshellBentoPresentation,
  updateBentoDeckMeta,
  writeBentoDoc,
  writeBentoSlides,
  writeBentoDeckHtml,
  __resetSlidesDeckBackups,
} from "./bento-workspace";
import {
  __resetSlidesDeckEventSenders,
  addSlidesDeckEventSender,
  type SlidesDeckEventSender,
} from "./deck-events";
import type { SlidesDeckChangedEvent } from "../../ipc/slides-ipc-types";

const DECK = "deckabc1";
// 最小合成壳:与真实 runtime 的合同一致(空 #bento-doc 块)。
const SHELL =
  '<!DOCTYPE html>\n<html><head><title>演示文稿</title>\n' +
  '<script type="application/bento+json" id="bento-doc"></script>\n' +
  '</head><body><div id="app"></div></body></html>';
const CURRENT_RUNTIME =
  '<!DOCTYPE html>\n<html><head><title>演示文稿</title>\n' +
  '<meta name="cortex-slides-runtime" content="runtime-current">\n' +
  '<script type="application/bento+json" id="bento-doc"></script>\n' +
  '</head><body><div id="app">CURRENT_RUNTIME_MARKER</div></body></html>';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-bento-ws-"));
  // .bak 是「每进程每 deck 一次」的,跨用例必须复位,否则后一个用例看不到备份行为。
  __resetSlidesDeckBackups();
  __resetSlidesDeckEventSenders();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deckHtmlFile = (): string => join(root, ".cortex-design", DECK, "deck.bento.html");
const deckBakFile = (): string => `${deckHtmlFile()}.bak`;

/** 收集 deck 变更广播的替身接收方(形状见 deck-events 的 SlidesDeckEventSender)。 */
function collectDeckEvents(): SlidesDeckChangedEvent[] {
  const events: SlidesDeckChangedEvent[] = [];
  const sender: SlidesDeckEventSender = {
    isDestroyed: () => false,
    send: (_channel, payload) => {
      events.push(payload as SlidesDeckChangedEvent);
    },
    once: () => undefined,
  };
  addSlidesDeckEventSender(sender);
  return events;
}

async function createOk(): Promise<void> {
  const res = await createBentoDeck({ workspaceRoot: root, deckId: DECK, title: "测试", runtimeHtml: SHELL });
  expect(res.ok).toBe(true);
}

describe("createBentoDeck", () => {
  it("产出含 starter 文档的 deck.bento.html + revision 0 的 meta", async () => {
    await createOk();
    expect(existsSync(deckHtmlFile())).toBe(true);
    const json = extractBentoDocJson(readFileSync(deckHtmlFile(), "utf8"));
    expect(json).not.toBeNull();
    const doc = JSON.parse(json!);
    expect(doc.format).toBe("bento/slides");
    expect(doc.title).toBe("测试");
    const meta = JSON.parse(readFileSync(join(root, ".cortex-design", DECK, "deck.meta.json"), "utf8"));
    expect(meta.revision).toBe(0);
  });

  it("重复创建 → already_exists", async () => {
    await createOk();
    const res = await createBentoDeck({ workspaceRoot: root, deckId: DECK, title: "x", runtimeHtml: SHELL });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("already_exists");
  });

  it("非法 deckId → invalid_path", async () => {
    const res = await createBentoDeck({ workspaceRoot: root, deckId: "../escape", title: "x", runtimeHtml: SHELL });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_path");
  });

  it("壳缺 #bento-doc 块 → invalid_doc(不产出坏文件)", async () => {
    const res = await createBentoDeck({ workspaceRoot: root, deckId: DECK, title: "x", runtimeHtml: "<html></html>" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_doc");
    expect(existsSync(deckHtmlFile())).toBe(false);
  });
});

describe("readBentoDeck", () => {
  it("读取返回 doc + revision + 绝对路径", async () => {
    await createOk();
    const res = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.doc?.title).toBe("测试");
      expect(res.value.revision).toBe(0);
      expect(res.value.htmlAbs.endsWith("deck.bento.html")).toBe(true);
    }
  });

  it("deck 不存在 → not_found", async () => {
    const res = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("deck 根是符号链接 → invalid_path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cortex-bento-out-"));
    mkdirSync(join(root, ".cortex-design"), { recursive: true });
    symlinkSync(outside, join(root, ".cortex-design", DECK));
    const res = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_path");
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("writeBentoDoc(乐观锁)", () => {
  it("expectedRevision 匹配 → 写入并 bump;文档往返一致", async () => {
    await createOk();
    const doc = buildStarterBentoDoc("改版");
    const res = await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc, expectedRevision: 0 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.revision).toBe(1);
    const back = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    if (back.ok) expect(back.value.doc?.title).toBe("改版");
  });

  it("expectedRevision 不匹配 → revision_conflict 且文件不变", async () => {
    await createOk();
    const before = readFileSync(deckHtmlFile(), "utf8");
    const res = await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("x"), expectedRevision: 7 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("revision_conflict");
    expect(readFileSync(deckHtmlFile(), "utf8")).toBe(before);
  });

  it("schema 不通过 → invalid_doc", async () => {
    await createOk();
    const res = await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: { format: "wrong" }, expectedRevision: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_doc");
  });

  it("并发两笔同 expectedRevision 的写:恰好一成一败(串行队列)", async () => {
    await createOk();
    const [a, b] = await Promise.all([
      writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("A"), expectedRevision: 0 }),
      writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("B"), expectedRevision: 0 }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const conflict = [a, b].find((r) => !r.ok);
    if (conflict && !conflict.ok) expect(conflict.error.code).toBe("revision_conflict");
  });
});

describe("writeBentoSlides(局部写入)", () => {
  /** 造一份多页 deck,返回各页 id。 */
  async function seedDeck(count: number): Promise<string[]> {
    await createOk();
    const html = readFileSync(deckHtmlFile(), "utf8");
    const doc = JSON.parse(extractBentoDocJson(html) as string);
    const first = doc.slides[0];
    doc.slides = Array.from({ length: count }, (_, i) => ({
      ...JSON.parse(JSON.stringify(first)),
      id: `slide-${i + 1}`,
      notes: `note-${i + 1}`,
    }));
    writeFileSync(deckHtmlFile(), injectBentoDoc(html, doc) as string);
    return doc.slides.map((s: { id: string }) => s.id);
  }

  const slidesOnDisk = (): Array<{ id: string; notes: string }> =>
    JSON.parse(extractBentoDocJson(readFileSync(deckHtmlFile(), "utf8")) as string).slides;

  const slideAt = (id: string, notes: string): Record<string, unknown> => ({
    id,
    background: "#000",
    transition: "fade",
    elements: [],
    notes,
  });

  it("只发被改的一页 → 该页替换,其余页逐字不变", async () => {
    await seedDeck(5);
    const before = slidesOnDisk();
    const res = await writeBentoSlides({
      workspaceRoot: root,
      deckId: DECK,
      slides: [slideAt("slide-3", "改过了")],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.replacedIds).toEqual(["slide-3"]);
    const after = slidesOnDisk();
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after[2]?.notes).toBe("改过了");
    expect(after[0]).toEqual(before[0]);
    expect(after[4]).toEqual(before[4]);
  });

  it("revision 乐观锁同样生效", async () => {
    await seedDeck(3);
    const res = await writeBentoSlides({
      workspaceRoot: root,
      deckId: DECK,
      slides: [slideAt("slide-1", "x")],
      expectedRevision: 7,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("revision_conflict");
  });

  // 守门:局部写入不能被拿来偷偷加页 —— 那会绕过「提纲批准后才出全篇」的 gate。
  it("id 不存在 → 拒绝,且提示去 get_deck_state 取真实 id", async () => {
    await seedDeck(3);
    const res = await writeBentoSlides({
      workspaceRoot: root,
      deckId: DECK,
      slides: [slideAt("slide-99", "偷加的页")],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("slide-99");
      expect(res.error.message).toContain("get_deck_state");
    }
    expect(slidesOnDisk()).toHaveLength(3);
  });

  it("替换后的文档非法 → 拒绝并保持磁盘原样", async () => {
    await seedDeck(3);
    const before = readFileSync(deckHtmlFile(), "utf8");
    const res = await writeBentoSlides({
      workspaceRoot: root,
      deckId: DECK,
      slides: [{ id: "slide-2", elements: "not an array" }],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_doc");
    expect(readFileSync(deckHtmlFile(), "utf8")).toBe(before);
  });

  it("被替换页上的评论同样不会丢", async () => {
    await seedDeck(3);
    const html = readFileSync(deckHtmlFile(), "utf8");
    const doc = JSON.parse(extractBentoDocJson(html) as string);
    const comment = { id: "cmt_1", author: "我", text: "换成折线图", at: "2026-07-26T00:00:00.000Z" };
    doc.slides[1].comments = [comment];
    writeFileSync(deckHtmlFile(), injectBentoDoc(html, doc) as string);

    const res = await writeBentoSlides({
      workspaceRoot: root,
      deckId: DECK,
      slides: [slideAt("slide-2", "改过了")],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    const after = slidesOnDisk() as Array<{ notes: string; comments?: unknown }>;
    expect(after[1]?.notes).toBe("改过了");
    expect(after[1]?.comments).toEqual([comment]);
  });
});

describe("writeBentoDoc(评论保全)", () => {
  const COMMENT = {
    id: "cmt_1",
    author: "我",
    text: "这个图表换成折线图",
    at: "2026-07-26T00:00:00.000Z",
  };

  /** 在磁盘上的 deck 里种一条评论(模拟用户在 bento 编辑器里评论过)。 */
  async function seedComment(): Promise<string> {
    await createOk();
    const html = readFileSync(deckHtmlFile(), "utf8");
    const doc = JSON.parse(extractBentoDocJson(html) as string);
    doc.slides[0].comments = [COMMENT];
    writeFileSync(deckHtmlFile(), injectBentoDoc(html, doc) as string);
    return doc.slides[0].id as string;
  }

  const commentsOnDisk = (): unknown => {
    const doc = JSON.parse(extractBentoDocJson(readFileSync(deckHtmlFile(), "utf8")) as string);
    return doc.slides[0].comments;
  };

  // 核心回归:AI 整份覆盖时不会带上 comments(prompt 与工具描述都没提这个字段),
  // 若不在写盘时补回,用户的评论会被下一次改稿静默抹掉。
  it("AI 整份覆盖没带 comments → 按 slide id 补回,评论不丢", async () => {
    const slideId = await seedComment();
    const next = buildStarterBentoDoc("改版");
    next.slides[0]!.id = slideId;
    const res = await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: next, expectedRevision: 0 });
    expect(res.ok).toBe(true);
    expect(commentsOnDisk()).toEqual([COMMENT]);
    // AI 的实际改动照常生效
    const back = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    if (back.ok) expect(back.value.doc?.title).toBe("改版");
  });

  it("AI 显式给了 comments → 以新的为准(留出将来真的操作评论的余地)", async () => {
    const slideId = await seedComment();
    const next = buildStarterBentoDoc("改版") as unknown as {
      slides: Array<{ id: string; comments?: unknown }>;
    };
    next.slides[0]!.id = slideId;
    next.slides[0]!.comments = [];
    const res = await writeBentoDoc({
      workspaceRoot: root,
      deckId: DECK,
      doc: next,
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    expect(commentsOnDisk()).toEqual([]);
  });

  it("整页被删除时其评论一并消失,不会挂到别的页上", async () => {
    await seedComment();
    const next = buildStarterBentoDoc("改版");
    next.slides[0]!.id = "brand-new-slide";
    const res = await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: next, expectedRevision: 0 });
    expect(res.ok).toBe(true);
    expect(commentsOnDisk()).toBeUndefined();
  });
});

describe("writeBentoDeckHtml(编辑器 autosave 整份回写)", () => {
  it("覆盖文件并 bump revision", async () => {
    await createOk();
    const html = readFileSync(deckHtmlFile(), "utf8").replace("测试", "编辑后");
    const res = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.revision).toBe(1);
    expect(readFileSync(deckHtmlFile(), "utf8")).toContain("编辑后");
  });

  it("html 缺 #bento-doc 块 → invalid_doc(编辑器绝不会产出;拦坏调用方)", async () => {
    await createOk();
    const res = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: "<html>junk</html>" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_doc");
  });

  it("deck 未创建 → not_found", async () => {
    const html = injectBentoDoc(SHELL, buildStarterBentoDoc("孤本"))!;
    const res = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("reshellBentoPresentation(放映换壳)", () => {
  // 旧 deck 携带创建时的 runtime;放映须把文档注入当前 runtime,否则 runtime 修复不生效。
  it("文档注入新壳:新壳标记在、旧壳标记不在、文档 JSON 原样保留", () => {
    const doc = buildStarterBentoDoc("换壳");
    const deckHtml = injectBentoDoc("STALE_RUNTIME_MARKER " + SHELL, doc)!;
    const out = reshellBentoPresentation(extractBentoDocJson(deckHtml)!, "FRESH_RUNTIME_MARKER " + SHELL);
    expect(out).not.toBeNull();
    expect(out).toContain("FRESH_RUNTIME_MARKER");
    expect(out).not.toContain("STALE_RUNTIME_MARKER");
    expect(JSON.parse(extractBentoDocJson(out!)!).title).toBe("换壳");
  });

  it("坏 JSON 或新壳缺 #bento-doc 块 → null(调用方回退直接加载 deck)", () => {
    expect(reshellBentoPresentation("{oops", SHELL)).toBeNull();
    expect(reshellBentoPresentation("{}", "<html>no block</html>")).toBeNull();
  });
});

describe("ensureBentoDeckRuntime(编辑器存量换壳)", () => {
  it("旧 deck 原子换成当前 runtime,文档与 sidecar revision 保持不变", async () => {
    await createOk();
    const beforeJson = extractBentoDocJson(readFileSync(deckHtmlFile(), "utf8"));
    const beforeMeta = readFileSync(join(root, ".cortex-design", DECK, "deck.meta.json"), "utf8");

    const migrated = await ensureBentoDeckRuntime({
      workspaceRoot: root,
      deckId: DECK,
      runtimeHtml: CURRENT_RUNTIME,
    });

    expect(migrated).toEqual({ ok: true, value: { migrated: true } });
    const html = readFileSync(deckHtmlFile(), "utf8");
    expect(html).toContain('content="runtime-current"');
    expect(html).toContain("CURRENT_RUNTIME_MARKER");
    expect(extractBentoDocJson(html)).toBe(beforeJson);
    expect(readFileSync(join(root, ".cortex-design", DECK, "deck.meta.json"), "utf8")).toBe(beforeMeta);
  });

  it("runtime 标识相同则不重复换壳", async () => {
    await createOk();
    const first = await ensureBentoDeckRuntime({
      workspaceRoot: root,
      deckId: DECK,
      runtimeHtml: CURRENT_RUNTIME,
    });
    expect(first.ok && first.value.migrated).toBe(true);
    const html = readFileSync(deckHtmlFile(), "utf8");

    const second = await ensureBentoDeckRuntime({
      workspaceRoot: root,
      deckId: DECK,
      runtimeHtml: CURRENT_RUNTIME,
    });

    expect(second).toEqual({ ok: true, value: { migrated: false } });
    expect(readFileSync(deckHtmlFile(), "utf8")).toBe(html);
  });

  it("当前 runtime 缺少内容标识时拒绝换壳且不覆盖旧文件", async () => {
    await createOk();
    const before = readFileSync(deckHtmlFile(), "utf8");

    const result = await ensureBentoDeckRuntime({
      workspaceRoot: root,
      deckId: DECK,
      runtimeHtml: SHELL,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_doc");
    expect(readFileSync(deckHtmlFile(), "utf8")).toBe(before);
  });

  it("加密 envelope 换壳时密文字段和 JSON 排版原样保留,sidecar 不变", async () => {
    await createOk();
    const envelopeJson = JSON.stringify({
      format: "bento/enc",
      v: 1,
      it: 300_000,
      salt: "salt-value",
      iv: "iv-value",
      data: "cipher-value",
    }, null, 2);
    const current = readFileSync(deckHtmlFile(), "utf8");
    const encrypted = current.replace(
      /(<script\b[^>]*\bid="bento-doc"[^>]*>)[\s\S]*?(<\/script>)/,
      `$1\n${envelopeJson}\n$2`,
    );
    const saved = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: encrypted });
    expect(saved.ok).toBe(true);
    const metaBefore = readFileSync(join(root, ".cortex-design", DECK, "deck.meta.json"), "utf8");

    const migrated = await ensureBentoDeckRuntime({
      workspaceRoot: root,
      deckId: DECK,
      runtimeHtml: CURRENT_RUNTIME,
    });

    expect(migrated).toEqual({ ok: true, value: { migrated: true } });
    expect(extractBentoDocJson(readFileSync(deckHtmlFile(), "utf8"))).toBe(envelopeJson);
    expect(readFileSync(join(root, ".cortex-design", DECK, "deck.meta.json"), "utf8")).toBe(metaBefore);
  });
});

describe("研究来源清单（演示文稿检索）", () => {
  const entry = (url: string, over: Record<string, unknown> = {}) => ({
    url,
    title: `标题 ${url}`,
    addedAt: "2026-07-26T00:00:00Z",
    ...over,
  });

  async function makeDeck(): Promise<void> {
    await createBentoDeck({ workspaceRoot: root, deckId: DECK, title: "测试", runtimeHtml: SHELL });
  }

  it("deck 不存在时报 not_found（不凭空建一个来源文件）", async () => {
    const res = await appendSlidesSource({ workspaceRoot: root, deckId: DECK, entry: entry("https://a.com") });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("追加后能读回，且落在 drafts/research/manifest.json", async () => {
    await makeDeck();
    const res = await appendSlidesSource({ workspaceRoot: root, deckId: DECK, entry: entry("https://a.com") });
    expect(res.ok).toBe(true);

    const manifestPath = join(root, ".cortex-design", DECK, "drafts", "research", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const read = await readSlidesSources({ workspaceRoot: root, deckId: DECK });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.sources.map((s) => s.url)).toEqual(["https://a.com"]);
  });

  /// 来源清单是**制作期溯源材料**，不该跟着 deck 导出给观众——
  /// 所以它必须在 deck.bento.html 之外，这条守着那个边界。
  it("来源不写进 deck 交付物本身", async () => {
    await makeDeck();
    await appendSlidesSource({
      workspaceRoot: root,
      deckId: DECK,
      entry: entry("https://secret-source.example"),
    });
    expect(readFileSync(deckHtmlFile(), "utf8")).not.toContain("secret-source.example");
  });

  it("同一 URL 去重：重复追加只更新不新增", async () => {
    await makeDeck();
    await appendSlidesSource({ workspaceRoot: root, deckId: DECK, entry: entry("https://a.com") });
    const res = await appendSlidesSource({
      workspaceRoot: root,
      deckId: DECK,
      entry: entry("https://a.com", { usedFor: "第 3 页市场规模" }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.total).toBe(1);

    const read = await readSlidesSources({ workspaceRoot: root, deckId: DECK });
    if (read.ok) expect(read.value.sources[0]?.usedFor).toBe("第 3 页市场规模");
  });

  it("超过上限时丢最早的（新来源更贴近当前正在做的页面）", async () => {
    await makeDeck();
    for (let i = 0; i < MAX_SLIDES_SOURCES + 5; i += 1) {
      await appendSlidesSource({ workspaceRoot: root, deckId: DECK, entry: entry(`https://a.com/${i}`) });
    }
    const read = await readSlidesSources({ workspaceRoot: root, deckId: DECK });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.sources).toHaveLength(MAX_SLIDES_SOURCES);
      expect(read.value.sources[0]?.url).toBe("https://a.com/5");
    }
  });

  it("清单文件损坏时回空清单而不是让写入失败（纯追加的溯源材料，读坏不该阻断 deck 流程）", async () => {
    await makeDeck();
    const dir = join(root, ".cortex-design", DECK, "drafts", "research");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{ 这不是 JSON", "utf8");

    const read = await readSlidesSources({ workspaceRoot: root, deckId: DECK });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.sources).toEqual([]);

    const res = await appendSlidesSource({ workspaceRoot: root, deckId: DECK, entry: entry("https://a.com") });
    expect(res.ok).toBe(true);
  });

  /// 回归：空清单曾是一个模块级常量 + 浅拷贝，`sources` 数组被所有 deck 共享，
  /// 一个 deck 的首次写入会污染另一个 deck 的「空」清单（跨 deck 串数据）。
  it("不同 deck 的空清单互不污染", async () => {
    await makeDeck();
    await appendSlidesSource({ workspaceRoot: root, deckId: DECK, entry: entry("https://first.example") });

    const otherRoot = mkdtempSync(join(tmpdir(), "cortex-bento-ws-other-"));
    try {
      await createBentoDeck({ workspaceRoot: otherRoot, deckId: DECK, title: "另一个", runtimeHtml: SHELL });
      const read = await readSlidesSources({ workspaceRoot: otherRoot, deckId: DECK });
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.sources).toEqual([]);

      const res = await appendSlidesSource({
        workspaceRoot: otherRoot,
        deckId: DECK,
        entry: entry("https://second.example"),
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.total).toBe(1);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("非法 deck id 被拒（路径穿越）", async () => {
    const res = await appendSlidesSource({
      workspaceRoot: root,
      deckId: "../escape",
      entry: entry("https://a.com"),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_path");
  });
});

describe("写入前一次性 .bak 安全网", () => {
  it("首次破坏性写入前生成 .bak,内容等于写入前的旧文件", async () => {
    await createOk();
    const before = readFileSync(deckHtmlFile(), "utf8");
    const res = await writeBentoDoc({
      workspaceRoot: root,
      deckId: DECK,
      doc: buildStarterBentoDoc("改版"),
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    expect(existsSync(deckBakFile())).toBe(true);
    expect(readFileSync(deckBakFile(), "utf8")).toBe(before);
  });

  // 本进程内只备份一次:目的是「留住 AI 大改之前那一版」,而不是跟着每次 autosave 滚动覆盖。
  it("同一进程内第二次写入不覆盖 .bak(仍是最初那份)", async () => {
    await createOk();
    const original = readFileSync(deckHtmlFile(), "utf8");
    await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("一"), expectedRevision: 0 });
    await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("二"), expectedRevision: 1 });
    expect(readFileSync(deckBakFile(), "utf8")).toBe(original);
  });

  it("编辑器回写同样先备份", async () => {
    await createOk();
    const before = readFileSync(deckHtmlFile(), "utf8");
    const res = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: before.replace("测试", "编辑后") });
    expect(res.ok).toBe(true);
    expect(readFileSync(deckBakFile(), "utf8")).toBe(before);
  });

  it("写入被拒(revision 冲突)时不留 .bak", async () => {
    await createOk();
    await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("x"), expectedRevision: 9 });
    expect(existsSync(deckBakFile())).toBe(false);
  });
});

describe("deck 变更广播(slides:deckChanged)", () => {
  /** 造一份多页 deck 并返回页 id(与 writeBentoSlides 用例同款)。 */
  async function seedDeck(count: number): Promise<string[]> {
    await createOk();
    const html = readFileSync(deckHtmlFile(), "utf8");
    const doc = JSON.parse(extractBentoDocJson(html) as string);
    const first = doc.slides[0];
    doc.slides = Array.from({ length: count }, (_, i) => ({
      ...JSON.parse(JSON.stringify(first)),
      id: `slide-${i + 1}`,
    }));
    writeFileSync(deckHtmlFile(), injectBentoDoc(html, doc) as string);
    return doc.slides.map((s: { id: string }) => s.id);
  }

  it("writeBentoSlides 成功 → source=agent + slideIds/pages/slideCount", async () => {
    await seedDeck(5);
    const events = collectDeckEvents();
    const res = await writeBentoSlides({
      workspaceRoot: root,
      deckId: DECK,
      slides: [
        { id: "slide-4", background: "#000", transition: "fade", elements: [], notes: "" },
        { id: "slide-2", background: "#000", transition: "fade", elements: [], notes: "" },
      ],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      deckId: DECK,
      revision: 1,
      source: "agent",
      slideIds: ["slide-4", "slide-2"],
      pages: [4, 2],
      slideCount: 5,
    });
    expect(events[0]?.workspaceRoot).toBe(root);
    expect(typeof events[0]?.at).toBe("string");
  });

  it("writeBentoDoc 成功 → source=agent,pages 为空、slideCount 为写入后的页数", async () => {
    await createOk();
    const events = collectDeckEvents();
    const res = await writeBentoDoc({
      workspaceRoot: root,
      deckId: DECK,
      doc: buildStarterBentoDoc("整份"),
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "agent", slideIds: [], pages: [], revision: 1, slideCount: 1 });
  });

  it("writeBentoDeckHtml 成功 → source=editor", async () => {
    await createOk();
    const events = collectDeckEvents();
    const html = readFileSync(deckHtmlFile(), "utf8").replace("测试", "编辑后");
    const res = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html });
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "editor", revision: 1 });
  });

  it("updateBentoDeckMeta 成功 → 广播同 revision 的 runtime 事件,让 renderer 刷新提纲阶段", async () => {
    await createOk();
    const events = collectDeckEvents();

    const res = await updateBentoDeckMeta({
      workspaceRoot: root,
      deckId: DECK,
      patch: {
        stage: "outline-proposed",
        outline: {
          version: 1,
          summary: "三页产品介绍",
          items: [{ id: "o1", title: "开场", purpose: "介绍", keyPoints: ["定位"] }],
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceRoot: root,
      deckId: DECK,
      revision: 0,
      source: "runtime",
      slideIds: [],
      pages: [],
      slideCount: 0,
    });
  });

  // 失败路径广播会让渲染端凭空刷新到一个并不存在的新 revision。
  it("写入失败(revision 冲突 / 非法文档 / deck 不存在)一律不广播", async () => {
    await createOk();
    const events = collectDeckEvents();
    await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("x"), expectedRevision: 9 });
    await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: { format: "wrong" }, expectedRevision: 0 });
    await writeBentoDeckHtml({ workspaceRoot: root, deckId: "nodeck12", html: readFileSync(deckHtmlFile(), "utf8") });
    expect(events).toHaveLength(0);
  });

  it("createBentoDeck 不广播(此时还没有窗口在看这份 deck)", async () => {
    const events = collectDeckEvents();
    await createOk();
    expect(events).toHaveLength(0);
  });
});

// 取证结论:deck 文件里带着 bento 自动铸造的在线协作凭据(collab.on=true + 公共中继 room +
// collab.sync 的 CRDT 状态)。每次打开都会全量重放房间历史并做元素级并集合并 →
// 「新旧内容重贴在一起」,且 deck 内容会外泄给第三方中继。宿主每条写路径都要剥掉它。
describe("collab 剥离", () => {
  const COLLAB = {
    room: "wss://sync.bento.page/d/wXXXX",
    key: "k",
    on: true,
    role: "writer",
    sync: { v: 2, lamport: 98, vv: { actor1: 63 } },
  };

  /** 在磁盘上的 deck 里种一份协作凭据(模拟存量受害 deck)。 */
  async function seedCollab(): Promise<void> {
    await createOk();
    const html = readFileSync(deckHtmlFile(), "utf8");
    const doc = JSON.parse(extractBentoDocJson(html) as string);
    doc.collab = COLLAB;
    writeFileSync(deckHtmlFile(), injectBentoDoc(html, doc) as string);
  }

  const docOnDisk = (): Record<string, unknown> =>
    JSON.parse(extractBentoDocJson(readFileSync(deckHtmlFile(), "utf8")) as string);
  const metaOnDisk = (): { revision: number } =>
    JSON.parse(readFileSync(join(root, ".cortex-design", DECK, "deck.meta.json"), "utf8"));

  it("AI 整份写入落盘后文件里没有 collab", async () => {
    await seedCollab();
    const next = buildStarterBentoDoc("改版") as unknown as Record<string, unknown>;
    next.collab = COLLAB; // 模型原样抄回 get_deck_state 给的 collab 是常态
    const res = await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: next, expectedRevision: 0 });
    expect(res.ok).toBe(true);
    expect("collab" in docOnDisk()).toBe(false);
    expect(readFileSync(deckHtmlFile(), "utf8")).not.toContain("sync.bento.page");
  });

  it("局部写入(set_slides)同样剥离 —— 上一版文档带的 collab 会被 readPrevDoc 带回来", async () => {
    await seedCollab();
    const doc = docOnDisk();
    const slideId = (doc.slides as Array<{ id: string }>)[0]!.id;
    const res = await writeBentoSlides({
      workspaceRoot: root,
      deckId: DECK,
      slides: [{ id: slideId, background: "#000", transition: "fade", elements: [], notes: "x" }],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    expect("collab" in docOnDisk()).toBe(false);
  });

  // ensureBentoDeckRuntime 跑在每次 bentoGetDeck 上 —— 存量 deck 一打开就被清洗。
  it("打开存量 deck(换壳路径)即清洗 collab,并 bump revision + 广播 runtime 事件", async () => {
    await seedCollab();
    const events = collectDeckEvents();
    const before = metaOnDisk().revision;

    const migrated = await ensureBentoDeckRuntime({
      workspaceRoot: root,
      deckId: DECK,
      runtimeHtml: CURRENT_RUNTIME,
    });

    expect(migrated.ok).toBe(true);
    expect("collab" in docOnDisk()).toBe(false);
    // 内容变了就必须 bump:否则 webview 内存文档与磁盘静默分叉,阶段 5 的 baseRevision
    // 弱锁会放行一次「带 collab 的旧稿」回写,形成来回覆盖的死循环。
    expect(metaOnDisk().revision).toBe(before + 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "runtime", revision: before + 1 });
  });

  it("清洗是幂等的:第二次打开不写盘、不 bump、不广播", async () => {
    await seedCollab();
    await ensureBentoDeckRuntime({ workspaceRoot: root, deckId: DECK, runtimeHtml: CURRENT_RUNTIME });
    const html = readFileSync(deckHtmlFile(), "utf8");
    const revision = metaOnDisk().revision;
    const events = collectDeckEvents();

    const second = await ensureBentoDeckRuntime({
      workspaceRoot: root,
      deckId: DECK,
      runtimeHtml: CURRENT_RUNTIME,
    });

    expect(second).toEqual({ ok: true, value: { migrated: false } });
    expect(readFileSync(deckHtmlFile(), "utf8")).toBe(html);
    expect(metaOnDisk().revision).toBe(revision);
    expect(events).toHaveLength(0);
  });

  it("无 collab 的纯换壳仍不动 revision(旧契约保住)", async () => {
    await createOk();
    const before = metaOnDisk().revision;
    const res = await ensureBentoDeckRuntime({ workspaceRoot: root, deckId: DECK, runtimeHtml: CURRENT_RUNTIME });
    expect(res).toEqual({ ok: true, value: { migrated: true } });
    expect(metaOnDisk().revision).toBe(before);
  });
});

// 收敛规则:磁盘是唯一真源,revision 是它的身份。编辑器回写声明 baseRevision(弱锁),
// 落后即拒 —— 这条通路此前会让 webview 里的旧稿静默覆盖 AI 刚写进去的十几页。
describe("writeBentoDeckHtml 的 baseRevision 弱锁", () => {
  const editedHtml = (mark: string): string => readFileSync(deckHtmlFile(), "utf8").replace("测试", mark);

  it("baseRevision 与磁盘一致 → 接受并 bump", async () => {
    await createOk();
    const res = await writeBentoDeckHtml({
      workspaceRoot: root,
      deckId: DECK,
      html: editedHtml("编辑后"),
      baseRevision: 0,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.revision).toBe(1);
  });

  it("baseRevision 落后 → revision_conflict,且文件字节完全未变", async () => {
    await createOk();
    const stale = editedHtml("旧稿");
    await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("AI 稿"), expectedRevision: 0 });
    const afterAi = readFileSync(deckHtmlFile(), "utf8");

    const res = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: stale, baseRevision: 0 });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("revision_conflict");
    expect(readFileSync(deckHtmlFile(), "utf8")).toBe(afterAi);
  });

  it("不传 baseRevision → 保持 last-writer 旧行为(兼容旧壳)", async () => {
    await createOk();
    await writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("AI 稿"), expectedRevision: 0 });
    const res = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: editedHtml("覆盖") });
    expect(res.ok).toBe(true);
  });

  // 竞态顺序 A:编辑器先落盘 → AI 的 expectedRevision 过期 → agent 重取重放。
  it("竞态顺序 A:编辑器先写,AI 拿到 revision_conflict", async () => {
    await createOk();
    const [editor, ai] = await Promise.all([
      writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: editedHtml("编辑"), baseRevision: 0 }),
      writeBentoDoc({ workspaceRoot: root, deckId: DECK, doc: buildStarterBentoDoc("AI"), expectedRevision: 0 }),
    ]);
    // 同一条 deck 队列串行:恰好一成一败。
    expect([editor.ok, ai.ok].filter(Boolean)).toHaveLength(1);
  });

  // 落盘规范化(治体积膨胀):编辑器的 capturePristine 会把 loader 注入的应用 CSS
  // 逐世代烙进产物(实测 10 份重复、文件 1.5MB)。传入 runtimeHtml 时只取 #bento-doc 重注当前壳。
  it("传 runtimeHtml → 产物换成当前壳,传入 HTML 里的垃圾 style 不落盘", async () => {
    await createOk();
    const bloated = readFileSync(deckHtmlFile(), "utf8").replace(
      "</head>",
      "<style>BLOAT_A</style><style>BLOAT_B</style></head>",
    );
    const res = await writeBentoDeckHtml({
      workspaceRoot: root,
      deckId: DECK,
      html: bloated,
      runtimeHtml: CURRENT_RUNTIME,
    });
    expect(res.ok).toBe(true);
    const saved = readFileSync(deckHtmlFile(), "utf8");
    expect(saved).not.toContain("BLOAT_A");
    expect(saved).toContain('content="runtime-current"');
  });

  it("规范化后连写三次,字节数不再随往返次数增长", async () => {
    await createOk();
    const sizes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const current = readFileSync(deckHtmlFile(), "utf8").replace("</head>", "<style>BLOAT</style></head>");
      await writeBentoDeckHtml({
        workspaceRoot: root,
        deckId: DECK,
        html: current,
        runtimeHtml: CURRENT_RUNTIME,
      });
      sizes.push(readFileSync(deckHtmlFile(), "utf8").length);
    }
    expect(new Set(sizes).size).toBe(1);
  });

  it("不传 runtimeHtml → 原样直写(旧行为,兼容其它调用方)", async () => {
    await createOk();
    const bloated = readFileSync(deckHtmlFile(), "utf8").replace("</head>", "<style>BLOAT</style></head>");
    await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: bloated });
    expect(readFileSync(deckHtmlFile(), "utf8")).toContain("BLOAT");
  });

  it("加密 deck(bento/enc 信封)走原样保存,不被换壳改动", async () => {
    await createOk();
    const envelopeJson = JSON.stringify({ format: "bento/enc", v: 1, data: "cipher" });
    const encrypted = readFileSync(deckHtmlFile(), "utf8").replace(
      /(<script\b[^>]*\bid="bento-doc"[^>]*>)[\s\S]*?(<\/script>)/,
      `$1${envelopeJson}$2`,
    );
    const res = await writeBentoDeckHtml({
      workspaceRoot: root,
      deckId: DECK,
      html: encrypted,
      runtimeHtml: CURRENT_RUNTIME,
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(deckHtmlFile(), "utf8")).toBe(encrypted);
  });

  // 竞态顺序 B(今天丢 13 页的那条通路):AI 先写 → 编辑器的旧 HTML 必须被拒。
  it("竞态顺序 B:AI 先写,编辑器旧稿被拒且 AI 的内容留在盘上", async () => {
    await createOk();
    const stale = editedHtml("旧稿");
    const ai = await writeBentoDoc({
      workspaceRoot: root,
      deckId: DECK,
      doc: buildStarterBentoDoc("AI 的新稿"),
      expectedRevision: 0,
    });
    expect(ai.ok).toBe(true);

    const editor = await writeBentoDeckHtml({ workspaceRoot: root, deckId: DECK, html: stale, baseRevision: 0 });

    expect(editor.ok).toBe(false);
    const back = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    expect(back.ok && back.value.doc?.title).toBe("AI 的新稿");
  });
});
