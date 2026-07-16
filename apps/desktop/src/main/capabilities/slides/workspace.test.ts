// deck workspace 持久化测试:真实文件系统(mkdtemp)验证目录骨架、原子写、乐观锁、
// 符号链接拒绝、tmp 恢复、软删与并发串行化。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSlidesManifest } from "@cortex-work/core/design/slides/slides-schema";
import { slidesSlideHtmlPath, slidesSnapshotPath } from "@cortex-work/core/design/slides/slides-paths";
import type { SlidesDeckManifest, SlidesSlot } from "@cortex-work/core/design/slides/slides-types";

vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  createDeckWorkspace,
  deleteSlide,
  loadDeckManifest,
  MAX_NOTES_BYTES,
  MAX_SLIDE_HTML_BYTES,
  readSlideHtml,
  readSlideNotes,
  resolveDeckPaths,
  updateDeckManifest,
  writeSlideHtml,
  writeSlideNotes,
} from "./workspace";

const DECK = "deckabc1";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-ws-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function deckFile(...parts: string[]): string {
  return join(root, ".cortex-design", DECK, ...parts);
}

function makeSlot(id: string, order: number): SlidesSlot {
  return {
    id,
    order,
    title: `第 ${order + 1} 页`,
    htmlPath: slidesSlideHtmlPath(DECK, id),
    snapshotPath: slidesSnapshotPath(DECK, id),
    revision: 0,
    status: "empty",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

async function createDeckWithSlot(): Promise<SlidesDeckManifest> {
  const created = await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "T" });
  expect(created.ok).toBe(true);
  const updated = await updateDeckManifest({
    workspaceRoot: root,
    deckId: DECK,
    expectedRevision: 0,
    mutate: (m) => {
      m.slides = [makeSlot("slot-001", 0)];
      m.activeSlideId = "slot-001";
      return m;
    },
  });
  expect(updated.ok).toBe(true);
  return (updated as { ok: true; value: SlidesDeckManifest }).value;
}

describe("createDeckWorkspace", () => {
  it("创建完整目录骨架与可解析的 deck.json", async () => {
    const result = await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "我的演示" });
    expect(result.ok).toBe(true);
    for (const dir of ["slides", "assets/source", "assets/generated", "snapshots", "notes", "drafts", "exports"]) {
      expect(existsSync(deckFile(dir)), dir).toBe(true);
    }
    const parsed = parseSlidesManifest(readFileSync(deckFile("deck.json"), "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.title).toBe("我的演示");
      expect(parsed.manifest.status).toBe("draft");
      expect(parsed.manifest.revision).toBe(0);
    }
  })

  it("重复创建返回 already_exists,不覆盖旧 manifest", async () => {
    await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "第一次" });
    const again = await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "第二次" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("already_exists");
    const parsed = parseSlidesManifest(readFileSync(deckFile("deck.json"), "utf8"));
    if (parsed.ok) expect(parsed.manifest.title).toBe("第一次");
  });

  it("非法 deck id 与不存在的工作区被拒绝", async () => {
    const badId = await createDeckWorkspace({ workspaceRoot: root, deckId: "../evil", title: "x" });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toBe("invalid_path");
    const badRoot = await createDeckWorkspace({ workspaceRoot: join(root, "nope"), deckId: DECK, title: "x" });
    expect(badRoot.ok).toBe(false);
    if (!badRoot.ok) expect(badRoot.error.code).toBe("invalid_path");
  });
});

describe("loadDeckManifest / 恢复", () => {
  it("非 deck 目录(无 deck.json)返回 not_found", async () => {
    mkdirSync(deckFile(), { recursive: true });
    const result = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("deck.json 损坏且存在合法 tmp 时晋升恢复", async () => {
    const created = await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "恢复我" });
    expect(created.ok).toBe(true);
    const good = readFileSync(deckFile("deck.json"), "utf8");
    writeFileSync(deckFile("deck.json.tmp"), good);
    writeFileSync(deckFile("deck.json"), "{ corrupted");
    const result = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recovered).toBe(true);
      expect(result.value.manifest.title).toBe("恢复我");
    }
    // tmp 已晋升为主文件。
    expect(existsSync(deckFile("deck.json.tmp"))).toBe(false);
    expect(parseSlidesManifest(readFileSync(deckFile("deck.json"), "utf8")).ok).toBe(true);
  });

  it("主文件健康时清理残留 tmp", async () => {
    await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "T" });
    writeFileSync(deckFile("deck.json.tmp"), "stale");
    const result = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
    expect(result.ok).toBe(true);
    expect(existsSync(deckFile("deck.json.tmp"))).toBe(false);
  });

  it("主文件与 tmp 都损坏 → invalid_manifest", async () => {
    mkdirSync(deckFile(), { recursive: true });
    writeFileSync(deckFile("deck.json"), "{ bad");
    writeFileSync(deckFile("deck.json.tmp"), "also bad");
    const result = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_manifest");
  });
});

describe("updateDeckManifest", () => {
  it("revision 匹配时更新并 +1;不匹配返回 revision_conflict", async () => {
    await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "T" });
    const ok = await updateDeckManifest({
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: 0,
      mutate: (m) => {
        m.title = "新标题";
        return m;
      },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.revision).toBe(1);
    const conflict = await updateDeckManifest({
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: 0,
      mutate: (m) => m,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("revision_conflict");
  });

  it("mutate 产物不合 schema 时拒绝且旧文件保持原样", async () => {
    await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "原始" });
    const bad = await updateDeckManifest({
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: 0,
      mutate: (m) => {
        m.slides = [makeSlot("slot-001", 0), makeSlot("slot-001", 1)];
        return m;
      },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_manifest");
    const onDisk = parseSlidesManifest(readFileSync(deckFile("deck.json"), "utf8"));
    expect(onDisk.ok).toBe(true);
    if (onDisk.ok) {
      expect(onDisk.manifest.title).toBe("原始");
      expect(onDisk.manifest.revision).toBe(0);
    }
  });

  it("并发同 revision 更新只有一个成功(deck 级串行队列)", async () => {
    await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "T" });
    const mutate = (m: SlidesDeckManifest) => {
      m.title = `${m.title}+`;
      return m;
    };
    const [a, b] = await Promise.all([
      updateDeckManifest({ workspaceRoot: root, deckId: DECK, expectedRevision: 0, mutate }),
      updateDeckManifest({ workspaceRoot: root, deckId: DECK, expectedRevision: 0, mutate }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    const conflict = [a, b].find((r) => !r.ok);
    if (conflict && !conflict.ok) expect(conflict.error.code).toBe("revision_conflict");
  });
});

describe("writeSlideHtml / readSlideHtml", () => {
  it("写入 HTML 并同步 slot 与 deck revision", async () => {
    const manifest = await createDeckWithSlot();
    const result = await writeSlideHtml({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      html: "<!doctype html><html><body>hi</body></html>",
      expectedRevision: manifest.revision,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.revision).toBe(manifest.revision + 1);
      const slot = result.value.slides.find((s) => s.id === "slot-001")!;
      expect(slot.revision).toBe(1);
      expect(slot.status).toBe("ready");
    }
    const read = await readSlideHtml({ workspaceRoot: root, deckId: DECK, slotId: "slot-001" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toContain("hi");
    // 无 tmp 残留。
    expect(readdirSync(deckFile("slides")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("slot 不在 manifest 中 → not_found;超大 HTML → too_large;空 HTML → invalid_payload", async () => {
    const manifest = await createDeckWithSlot();
    const missing = await writeSlideHtml({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-999",
      html: "<html></html>",
      expectedRevision: manifest.revision,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");

    const big = await writeSlideHtml({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      html: "x".repeat(MAX_SLIDE_HTML_BYTES + 1),
      expectedRevision: manifest.revision,
    });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe("too_large");

    const empty = await writeSlideHtml({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      html: "",
      expectedRevision: manifest.revision,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("invalid_payload");
  });

  it("revision 不匹配 → revision_conflict 且不写文件", async () => {
    const manifest = await createDeckWithSlot();
    const result = await writeSlideHtml({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      html: "<html></html>",
      expectedRevision: manifest.revision + 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("revision_conflict");
    expect(existsSync(deckFile("slides", "slot-001.html"))).toBe(false);
  });
});

describe("演讲者备注", () => {
  it("写入 notes/<slot>.md 并入册 notesPath;读回一致", async () => {
    const manifest = await createDeckWithSlot();
    const result = await writeSlideNotes({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      markdown: "# 开场\n\n- 先讲痛点\n- 再给数据",
      expectedRevision: manifest.revision,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slides[0]!.notesPath).toBe(`.cortex-design/${DECK}/notes/slot-001.md`);
      expect(result.value.revision).toBe(manifest.revision + 1);
    }
    expect(readFileSync(deckFile("notes", "slot-001.md"), "utf8")).toContain("先讲痛点");
    const read = await readSlideNotes({ workspaceRoot: root, deckId: DECK, slotId: "slot-001" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toContain("再给数据");
  });

  it("无备注时读回空串(备注天然可选,不是错误)", async () => {
    await createDeckWithSlot();
    const read = await readSlideNotes({ workspaceRoot: root, deckId: DECK, slotId: "slot-001" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toBe("");
  });

  it("slot 不存在 → not_found;超大备注 → too_large;revision 过期 → conflict", async () => {
    const manifest = await createDeckWithSlot();
    const missing = await writeSlideNotes({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-999",
      markdown: "x",
      expectedRevision: manifest.revision,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");

    const big = await writeSlideNotes({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      markdown: "x".repeat(MAX_NOTES_BYTES + 1),
      expectedRevision: manifest.revision,
    });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe("too_large");

    const stale = await writeSlideNotes({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      markdown: "x",
      expectedRevision: manifest.revision + 9,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
  });
});

describe("符号链接与越界拒绝", () => {
  it("deck 根是符号链接 → invalid_path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cortex-slides-outside-"));
    try {
      mkdirSync(join(root, ".cortex-design"), { recursive: true });
      symlinkSync(outside, deckFile());
      const result = await resolveDeckPaths(root, DECK);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_path");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("slide 文件是符号链接 → 读写均拒绝", async () => {
    const manifest = await createDeckWithSlot();
    const outside = mkdtempSync(join(tmpdir(), "cortex-slides-outside-"));
    try {
      writeFileSync(join(outside, "evil.html"), "<html>evil</html>");
      symlinkSync(join(outside, "evil.html"), deckFile("slides", "slot-001.html"));
      const read = await readSlideHtml({ workspaceRoot: root, deckId: DECK, slotId: "slot-001" });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.code).toBe("invalid_path");
      const write = await writeSlideHtml({
        workspaceRoot: root,
        deckId: DECK,
        slotId: "slot-001",
        html: "<html>ok</html>",
        expectedRevision: manifest.revision,
      });
      expect(write.ok).toBe(false);
      if (!write.ok) expect(write.error.code).toBe("invalid_path");
      // 链接目标未被覆盖。
      expect(readFileSync(join(outside, "evil.html"), "utf8")).toContain("evil");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("deleteSlide 软删", () => {
  it("文件移入 .trash,manifest 移除 slot 并修正 activeSlideId", async () => {
    const manifest = await createDeckWithSlot();
    const wrote = await writeSlideHtml({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      html: "<html>bye</html>",
      expectedRevision: manifest.revision,
    });
    expect(wrote.ok).toBe(true);
    const rev = (wrote as { ok: true; value: SlidesDeckManifest }).value.revision;
    const deleted = await deleteSlide({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      expectedRevision: rev,
    });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.value.slides).toHaveLength(0);
      expect(deleted.value.activeSlideId).toBeNull();
    }
    expect(existsSync(deckFile("slides", "slot-001.html"))).toBe(false);
    const trash = readdirSync(deckFile(".trash"));
    expect(trash.some((f) => f.includes("slot-001.html"))).toBe(true);
  });
});
