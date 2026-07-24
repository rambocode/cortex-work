// bento deck 持久层测试:真实文件系统(mkdtemp)验证创建/读写/乐观锁/串行化/路径安全。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBentoDocJson, injectBentoDoc } from "@cortex-work/core/design/slides/bento/bento-embed";
import { buildStarterBentoDoc } from "@cortex-work/core/design/slides/bento/bento-doc-schema";

vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  createBentoDeck,
  readBentoDeck,
  reshellBentoPresentation,
  writeBentoDoc,
  writeBentoDeckHtml,
} from "./bento-workspace";

const DECK = "deckabc1";
// 最小合成壳:与真实 runtime 的合同一致(空 #bento-doc 块)。
const SHELL =
  '<!DOCTYPE html>\n<html><head><title>Bento Slides</title>\n' +
  '<script type="application/bento+json" id="bento-doc"></script>\n' +
  '</head><body><div id="app"></div></body></html>';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-bento-ws-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deckHtmlFile = (): string => join(root, ".cortex-design", DECK, "deck.bento.html");

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
