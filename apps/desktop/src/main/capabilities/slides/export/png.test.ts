// PNG 导出测试:假窗口逐页截图、补零命名、取消/失败时清理本次半成品、
// 窗口生命周期(每页必销毁)。
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeImage } from "electron";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("../../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { exportDeckPngs } from "./png";
import type { SlideRenderWindow } from "../render";
import { createDeckWorkspace, loadDeckManifest, updateDeckManifest, writeSlideHtml } from "../workspace";

const DECK = "deckpng001";
let root: string;
let outDir: string;

function fakeImage(): NativeImage {
  return {
    getSize: () => ({ width: 1280, height: 720 }),
    toBitmap: () => Buffer.alloc(16, 255),
    toPNG: () => Buffer.from("\x89PNG-fake"),
  } as unknown as NativeImage;
}

type Log = { created: number; destroyed: number };

function windowFactory(log: Log, overrides: Partial<SlideRenderWindow> = {}): () => SlideRenderWindow {
  return () => {
    log.created += 1;
    let destroyed = false;
    return {
      loadURL: async () => undefined,
      executeJavaScript: async () => undefined,
      capturePage: async () => fakeImage(),
      insertCSS: async () => undefined,
      destroy: () => {
        destroyed = true;
        log.destroyed += 1;
      },
      isDestroyed: () => destroyed,
      ...overrides,
    };
  };
}

const HTML = `<!doctype html><html><head><meta charset="utf-8" /></head><body><h1>页</h1></body></html>`;

async function seedSlides(titles: string[]): Promise<void> {
  for (const [i, title] of titles.entries()) {
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
          title,
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
  root = mkdtempSync(join(tmpdir(), "cortex-slides-png-"));
  outDir = mkdtempSync(join(tmpdir(), "cortex-slides-pngout-"));
  await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "PNG deck" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

describe("exportDeckPngs", () => {
  it("按顺序补零命名逐页导出;每页窗口都销毁", async () => {
    await seedSlides(["封面", "论证", "结尾"]);
    const log: Log = { created: 0, destroyed: 0 };
    const result = await exportDeckPngs({
      workspaceRoot: root,
      deckId: DECK,
      targetDir: outDir,
      windowFactory: windowFactory(log),
    });
    expect(result.ok).toBe(true);
    expect(readdirSync(outDir).sort()).toEqual(["slide-01-封面.png", "slide-02-论证.png", "slide-03-结尾.png"]);
    expect(log.created).toBe(3);
    expect(log.destroyed).toBe(3);
  });

  it("中途失败:清理本次已写文件,不留半成品(目录里的其它文件不动)", async () => {
    await seedSlides(["A", "B", "C"]);
    // 目录里预置一个无关文件,断言不被误删。
    const bystander = join(outDir, "bystander.txt");
    writeFileSync(bystander, "keep me");
    const log: Log = { created: 0, destroyed: 0 };
    let calls = 0;
    const result = await exportDeckPngs({
      workspaceRoot: root,
      deckId: DECK,
      targetDir: outDir,
      windowFactory: windowFactory(log, {
        capturePage: async () => {
          calls += 1;
          if (calls === 2) throw new Error("截图炸了");
          return fakeImage();
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("io_error");
    expect(readdirSync(outDir)).toEqual(["bystander.txt"]);
    expect(existsSync(bystander)).toBe(true);
  });

  it("取消:已写文件被回滚", async () => {
    await seedSlides(["A", "B", "C"]);
    const log: Log = { created: 0, destroyed: 0 };
    const cancel = { canceled: false };
    const result = await exportDeckPngs({
      workspaceRoot: root,
      deckId: DECK,
      targetDir: outDir,
      windowFactory: windowFactory(log),
      cancel,
      onProgress: () => {
        cancel.canceled = true;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("canceled");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("超时 → timeout 错误且窗口销毁", async () => {
    await seedSlides(["A"]);
    const log: Log = { created: 0, destroyed: 0 };
    const result = await exportDeckPngs({
      workspaceRoot: root,
      deckId: DECK,
      targetDir: outDir,
      timeoutMs: 500,
      windowFactory: windowFactory(log, { executeJavaScript: () => new Promise(() => {}) }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    expect(log.destroyed).toBe(1);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("空 deck → not_found", async () => {
    const log: Log = { created: 0, destroyed: 0 };
    const result = await exportDeckPngs({
      workspaceRoot: root,
      deckId: DECK,
      targetDir: outDir,
      windowFactory: windowFactory(log),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});
