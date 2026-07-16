// 导出编排测试:真实 tmp deck + 假渲染窗口(不拉 Chromium),验证逐页顺序渲染、
// base raster 仅在复杂页截取、取消/超时/空 deck 的结构化错误、原子落盘。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeImage } from "electron";
import JSZip from "jszip";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { buildDeckPptx, renderDeckForExport, writeArtifactAtomic } from "./deck-export";
import type { SlideRenderWindow } from "../render";
import type { SlideScene } from "./types";
import { createDeckWorkspace, loadDeckManifest, updateDeckManifest, writeSlideHtml } from "../workspace";

const DECK = "deckexp001";
let root: string;

function fakeImage(): NativeImage {
  return {
    getSize: () => ({ width: 4, height: 4 }),
    toBitmap: () => Buffer.alloc(64, 255),
    toPNG: () => Buffer.from("\x89PNG-base-raster"),
  } as unknown as NativeImage;
}

// 简单场景:一段原生文本,无复杂层。
function plainScene(text: string): SlideScene {
  return {
    width: 1280,
    height: 720,
    backgroundColor: "ffffff",
    hasComplexLayers: false,
    warnings: [],
    nodes: [
      {
        kind: "text",
        id: "text-1",
        x: 80,
        y: 80,
        w: 600,
        h: 60,
        z: 0,
        align: "left",
        lineHeightPx: 60,
        paddingPx: { top: 0, right: 0, bottom: 0, left: 0 },
        runs: [
          {
            text,
            fontFamily: "Helvetica",
            fontSizePx: 48,
            color: "0f172a",
            bold: true,
            italic: false,
            underline: false,
          },
        ],
      },
    ],
  };
}

// 复杂场景:一段文本 + 一个 canvas 栅格层。
function complexScene(): SlideScene {
  const scene = plainScene("复杂页标题");
  scene.hasComplexLayers = true;
  scene.backgroundColor = undefined;
  scene.nodes.push({
    kind: "raster",
    id: "raster-1",
    x: 0,
    y: 200,
    w: 500,
    h: 300,
    z: 1,
    reason: "canvas",
  });
  return scene;
}

type WindowLog = { created: number; destroyed: number; insertCssCalls: number };

function windowFactory(
  scenes: SlideScene[],
  log: WindowLog,
  overrides: Partial<SlideRenderWindow> = {},
): () => SlideRenderWindow {
  return () => {
    const index = log.created;
    log.created += 1;
    let destroyed = false;
    return {
      loadURL: async () => undefined,
      executeJavaScript: async (code: string) => {
        if (code.includes("Promise.all")) return undefined;
        if (code.includes("requestAnimationFrame")) return undefined;
        return scenes[index] ?? scenes[0];
      },
      capturePage: async () => fakeImage(),
      insertCSS: async () => {
        log.insertCssCalls += 1;
        return undefined;
      },
      destroy: () => {
        destroyed = true;
        log.destroyed += 1;
      },
      isDestroyed: () => destroyed,
      ...overrides,
    };
  };
}

const HTML = `<!doctype html><html><head><meta charset="utf-8" /></head><body><h1 data-cortex-id="t">页</h1></body></html>`;

async function seedSlides(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const slotId = `slot-${String(i + 1).padStart(3, "0")}`;
    const before = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
    if (!before.ok) throw new Error("load failed");
    await updateDeckManifest({
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: before.value.manifest.revision,
      mutate: (m) => {
        m.status = "outline-approved";
        m.slides.push({
          id: slotId,
          order: i,
          title: `第 ${i + 1} 页`,
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
      html: HTML,
      expectedRevision: after.value.manifest.revision,
    });
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-deckexp-"));
  await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "导出 deck" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("renderDeckForExport", () => {
  it("按顺序逐页渲染,每页窗口都被销毁", async () => {
    await seedSlides(3);
    const log: WindowLog = { created: 0, destroyed: 0, insertCssCalls: 0 };
    const progress: string[] = [];
    const result = await renderDeckForExport({
      workspaceRoot: root,
      deckId: DECK,
      windowFactory: windowFactory([plainScene("A"), plainScene("B"), plainScene("C")], log),
      onProgress: (_done, _total, slotId) => progress.push(slotId),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((r) => r.slot.id)).toEqual(["slot-001", "slot-002", "slot-003"]);
    expect(log.created).toBe(3);
    expect(log.destroyed).toBe(3);
    expect(progress).toEqual(["slot-001", "slot-002", "slot-003"]);
  });

  it("纯原生页不截 base raster;复杂页才截", async () => {
    await seedSlides(2);
    const log: WindowLog = { created: 0, destroyed: 0, insertCssCalls: 0 };
    const result = await renderDeckForExport({
      workspaceRoot: root,
      deckId: DECK,
      windowFactory: windowFactory([plainScene("纯原生"), complexScene()], log),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]!.baseRasterDataUri).toBeUndefined();
      expect(result.value[1]!.baseRasterDataUri).toContain("data:image/png;base64,");
      expect(result.value[1]!.report.rasterReasons).toContain("canvas");
    }
    // 只有复杂页注入了隐藏 CSS。
    expect(log.insertCssCalls).toBe(1);
  });

  it("空 deck(无 ready 页面)→ not_found", async () => {
    const log: WindowLog = { created: 0, destroyed: 0, insertCssCalls: 0 };
    const result = await renderDeckForExport({
      workspaceRoot: root,
      deckId: DECK,
      windowFactory: windowFactory([plainScene("x")], log),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    expect(log.created).toBe(0);
  });

  it("取消:已开工页面跑完,后续页面不再开工", async () => {
    await seedSlides(3);
    const log: WindowLog = { created: 0, destroyed: 0, insertCssCalls: 0 };
    const cancel = { canceled: false };
    const factory = windowFactory([plainScene("A"), plainScene("B"), plainScene("C")], log);
    const result = await renderDeckForExport({
      workspaceRoot: root,
      deckId: DECK,
      windowFactory: factory,
      cancel,
      onProgress: () => {
        // 第一页完成后取消。
        cancel.canceled = true;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("canceled");
    expect(log.created).toBe(1);
    expect(log.destroyed).toBe(1);
  });

  it("单页渲染超时 → timeout 错误,窗口仍被销毁", async () => {
    await seedSlides(1);
    const log: WindowLog = { created: 0, destroyed: 0, insertCssCalls: 0 };
    const result = await renderDeckForExport({
      workspaceRoot: root,
      deckId: DECK,
      timeoutMs: 600,
      windowFactory: windowFactory([plainScene("A")], log, { executeJavaScript: () => new Promise(() => {}) }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    expect(log.destroyed).toBe(1);
  });

  it("非法 deck → 结构化拒绝", async () => {
    const log: WindowLog = { created: 0, destroyed: 0, insertCssCalls: 0 };
    const result = await renderDeckForExport({
      workspaceRoot: root,
      deckId: "../evil",
      windowFactory: windowFactory([plainScene("A")], log),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_path");
  });
});

describe("buildDeckPptx", () => {
  it("产出可解包 PPTX:原生文本入 slide XML,复杂页叠 base raster 图", async () => {
    await seedSlides(2);
    const log: WindowLog = { created: 0, destroyed: 0, insertCssCalls: 0 };
    const built = await buildDeckPptx({
      workspaceRoot: root,
      deckId: DECK,
      windowFactory: windowFactory([plainScene("原生标题"), complexScene()], log),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.reports).toHaveLength(2);
    expect(built.value.reports[0]!.rasterCount).toBe(0);
    expect(built.value.reports[1]!.rasterCount).toBe(1);

    const zip = await JSZip.loadAsync(built.value.buffer);
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const slide2 = await zip.file("ppt/slides/slide2.xml")!.async("string");
    expect(slide1).toContain("<a:t>原生标题</a:t>");
    // 纯原生页:无图片对象。
    expect(slide1).not.toContain("<p:pic>");
    // 复杂页:base raster 一张图 + 原生文本。
    expect((slide2.match(/<p:pic>/g) ?? []).length).toBe(1);
    expect(slide2).toContain("<a:t>复杂页标题</a:t>");
  });
});

describe("writeArtifactAtomic", () => {
  it("成功写入且不留 .tmp", async () => {
    const target = join(root, "out.pptx");
    await writeArtifactAtomic(target, Buffer.from("PPTX"));
    expect(readFileSync(target, "utf8")).toBe("PPTX");
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("rename 失败时清理 .tmp 并抛错(不留半成品)", async () => {
    // 目标是一个已存在的目录 → rename 必失败。
    const target = join(root, ".cortex-design");
    await expect(writeArtifactAtomic(target, Buffer.from("X"))).rejects.toThrow();
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});
