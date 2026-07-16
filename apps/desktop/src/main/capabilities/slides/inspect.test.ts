// 巡检编排测试:真实 tmp deck + 假渲染窗口,验证快照落盘与 manifest 入册、
// 渲染失败时静态检查仍返回 + render-failed finding、按 severity 排序。
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeImage } from "electron";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { checkSlides, screenshotSlideToSnapshot } from "./inspect";
import type { SlideRenderWindow } from "./render";
import { createDeckWorkspace, loadDeckManifest, updateDeckManifest, writeSlideHtml } from "./workspace";

const DECK = "deckinsp01";
let root: string;

function fakePng(): NativeImage {
  const bmp = Buffer.alloc(4 * 4 * 4, 255);
  // 制造非空截图:末尾几个像素涂黑(左上角保持背景 —— blankRatio 以它为基准)。
  for (let i = 8; i < 16; i++) bmp[i * 4] = 0;
  return {
    getSize: () => ({ width: 4, height: 4 }),
    toBitmap: () => bmp,
    toPNG: () => Buffer.from("\x89PNG-fake"),
  } as unknown as NativeImage;
}

const CLEAN_INSPECTION = {
  overflowX: false,
  overflowY: false,
  clipped: [],
  smallText: [],
  brokenImages: [],
  visibleTextLength: 30,
  hasVisibleContent: true,
};

function windowFactory(overrides: Partial<SlideRenderWindow> = {}): () => SlideRenderWindow {
  return () => ({
    loadURL: async () => undefined,
    executeJavaScript: async (code: string) => (code.includes("Promise.all") ? undefined : CLEAN_INSPECTION),
    capturePage: async () => fakePng(),
    insertCSS: async () => undefined,
    destroy: () => undefined,
    isDestroyed: () => false,
    ...overrides,
  });
}

const CLEAN_HTML = `<!doctype html><html><head><meta charset="utf-8" /></head><body><h1 data-cortex-id="t">页面</h1></body></html>`;

async function seedSlide(slotId: string, html = CLEAN_HTML): Promise<void> {
  const loaded = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
  if (!loaded.ok) throw new Error("load failed");
  await updateDeckManifest({
    workspaceRoot: root,
    deckId: DECK,
    expectedRevision: loaded.value.manifest.revision,
    mutate: (m) => {
      m.status = "outline-approved";
      m.slides.push({
        id: slotId,
        order: m.slides.length,
        title: slotId,
        htmlPath: `.cortex-design/${DECK}/slides/${slotId}.html`,
        revision: 0,
        status: "empty",
        updatedAt: "2026-07-16T00:00:00.000Z",
      });
      return m;
    },
  });
  const after = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
  if (!after.ok) throw new Error("load failed");
  await writeSlideHtml({
    workspaceRoot: root,
    deckId: DECK,
    slotId,
    html,
    expectedRevision: after.value.manifest.revision,
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-inspect-"));
  await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "巡检" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("screenshotSlideToSnapshot", () => {
  it("截图落到 snapshots/<slotId>.png 并入册 manifest", async () => {
    await seedSlide("slot-001");
    const result = await screenshotSlideToSnapshot({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      windowFactory: windowFactory(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.snapshotPath).toBe(`.cortex-design/${DECK}/snapshots/slot-001.png`);
    expect(existsSync(join(root, ".cortex-design", DECK, "snapshots", "slot-001.png"))).toBe(true);
    // 无 tmp 残留。
    expect(readdirSync(join(root, ".cortex-design", DECK, "snapshots")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const loaded = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.manifest.slides[0]!.snapshotPath).toBe(`.cortex-design/${DECK}/snapshots/slot-001.png`);
    }
  });

  it("渲染超时 → 结构化错误,不写快照", async () => {
    await seedSlide("slot-001");
    const result = await screenshotSlideToSnapshot({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
      timeoutMs: 500,
      windowFactory: windowFactory({ executeJavaScript: () => new Promise(() => {}) }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    expect(existsSync(join(root, ".cortex-design", DECK, "snapshots", "slot-001.png"))).toBe(false);
  });

  it("slot 不存在 → not_found", async () => {
    const result = await screenshotSlideToSnapshot({
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-999",
      windowFactory: windowFactory(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("checkSlides", () => {
  it("干净 deck 无 finding,并刷新全部快照", async () => {
    await seedSlide("slot-001");
    await seedSlide("slot-002");
    const result = await checkSlides({ workspaceRoot: root, deckId: DECK, windowFactory: windowFactory() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    expect(existsSync(join(root, ".cortex-design", DECK, "snapshots", "slot-001.png"))).toBe(true);
    expect(existsSync(join(root, ".cortex-design", DECK, "snapshots", "slot-002.png"))).toBe(true);
  });

  it("静态 + 渲染 findings 合并,blocking 排在前", async () => {
    await seedSlide(
      "slot-001",
      `<!doctype html><html><head><meta charset="utf-8" /></head><body><img src="https://x.example/a.png" /></body></html>`,
    );
    const result = await checkSlides({
      workspaceRoot: root,
      deckId: DECK,
      windowFactory: windowFactory({
        executeJavaScript: async (code: string) =>
          code.includes("Promise.all")
            ? undefined
            : { ...CLEAN_INSPECTION, overflowY: true, brokenImages: [{ id: "img", src: "https://x" }] },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.value.map((f) => f.code);
      expect(codes).toContain("remote-resource");
      expect(codes).toContain("overflow");
      expect(codes).toContain("image-load-failure");
      expect(result.value[0]!.severity).toBe("blocking");
    }
  });

  it("单页渲染失败 → render-failed blocking,其他页不受影响", async () => {
    await seedSlide("slot-001");
    let calls = 0;
    const result = await checkSlides({
      workspaceRoot: root,
      deckId: DECK,
      timeoutMs: 500,
      windowFactory: windowFactory({
        loadURL: async () => {
          calls += 1;
          throw new Error("ERR_FAILED");
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.some((f) => f.code === "render-failed" && f.severity === "blocking")).toBe(true);
    }
    expect(calls).toBe(1);
  });

  it("slotIds 限定范围", async () => {
    await seedSlide("slot-001");
    await seedSlide("slot-002");
    const result = await checkSlides({
      workspaceRoot: root,
      deckId: DECK,
      slotIds: ["slot-002"],
      windowFactory: windowFactory(),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, ".cortex-design", DECK, "snapshots", "slot-001.png"))).toBe(false);
    expect(existsSync(join(root, ".cortex-design", DECK, "snapshots", "slot-002.png"))).toBe(true);
  });
});
