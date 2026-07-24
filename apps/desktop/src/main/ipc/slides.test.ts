// Slides IPC 域测试(bento 化):存根 ipcMain 捕获 handler,真实 fs(mkdtemp)走完整持久化;
// 同时验证「注册面 == 镜像契约通道清单」与 core/desktop 运行时常量一致(防漂移)。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SLIDES_IPC_CHANNELS as CORE_CHANNELS } from "@cortex-work/core/desktop/slides-ipc-types";
import { dialog } from "electron";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
}));

// app.getAppPath() → apps/desktop 根:bentoCreateDeck 读真实 resources/slides/bento/runtime.html。
const APP_PATH = fileURLToPath(new URL("../../..", import.meta.url));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  },
  app: { getAppPath: () => APP_PATH },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })) },
}));

vi.mock("../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// 演示窗口是真实 BrowserWindow 的薄壳,IPC 层只验证「rail 组装 + 起始页索引」;
// 窗口生命周期由 presenter-window.test.ts 用假窗口覆盖。
vi.mock("../presenter-window", () => ({
  openPresenterWindow: vi.fn(async () => {}),
}));

import { registerSlidesHandlers } from "./slides";
import { openPresenterWindow } from "../presenter-window";
import { writeBentoDoc } from "../capabilities/slides/bento-workspace";
import { buildStarterBentoDoc } from "@cortex-work/core/design/slides/bento/bento-doc-schema";
import { extractBentoDocJson, injectBentoDoc } from "@cortex-work/core/design/slides/bento/bento-embed";
import { SLIDES_IPC_CHANNELS } from "./slides-ipc-types";

const DECK = "deckipc01";
let root: string;

// 便捷 invoke:直接调用被捕获的 handler(event 传 null,handler 只在导出对话框用 sender)。
async function invoke<T>(channel: string, req: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册: ${channel}`);
  return (await handler(null, req)) as T;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-ipc-"));
  registerSlidesHandlers();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("契约镜像一致性", () => {
  it("core 与 desktop 的通道清单常量逐项一致", () => {
    expect([...SLIDES_IPC_CHANNELS]).toEqual([...CORE_CHANNELS]);
  });

  it("注册面恰好等于契约通道清单", () => {
    expect([...handlers.keys()].sort()).toEqual([...SLIDES_IPC_CHANNELS].sort());
  });
});

describe("bento deck 生命周期经 IPC", () => {
  it("bentoCreateDeck(真实 runtime 壳)→ bentoGetDeck 往返,stage=draft", async () => {
    const created = await invoke<{ ok: boolean; revision?: number }>("slides:bentoCreateDeck", {
      workspaceRoot: root,
      deckId: DECK,
      title: "IPC 测试",
    });
    expect(created.ok).toBe(true);
    const loaded = await invoke<{ ok: boolean; json: string | null; revision: number; stage: string }>(
      "slides:bentoGetDeck",
      { workspaceRoot: root, deckId: DECK },
    );
    expect(loaded.ok).toBe(true);
    expect(loaded.stage).toBe("draft");
    expect(JSON.parse(loaded.json!).title).toBe("IPC 测试");
  });

  it("bentoGetDeck 在编辑器加载前把旧壳换成当前 runtime,revision 不变", async () => {
    const deckId = "deckoldrt1";
    const created = await invoke<{ ok: boolean; revision?: number }>("slides:bentoCreateDeck", {
      workspaceRoot: root,
      deckId,
      title: "旧壳",
    });
    expect(created.ok).toBe(true);
    const doc = buildStarterBentoDoc("旧壳");
    const staleShell =
      "STALE_EDITOR_RUNTIME " +
      '<!DOCTYPE html><html><head><title>旧壳</title>' +
      '<script type="application/bento+json" id="bento-doc"></script>' +
      "</head><body></body></html>";
    const staleHtml = injectBentoDoc(staleShell, doc)!;
    const saved = await invoke<{ ok: boolean; revision?: number }>("slides:bentoWriteDeckHtml", {
      workspaceRoot: root,
      deckId,
      html: staleHtml,
    });
    expect(saved.ok).toBe(true);

    const loaded = await invoke<{ ok: boolean; revision?: number; json?: string }>("slides:bentoGetDeck", {
      workspaceRoot: root,
      deckId,
    });

    expect(loaded.ok).toBe(true);
    expect(loaded.revision).toBe(saved.revision);
    expect(JSON.parse(loaded.json!).title).toBe("旧壳");
    const migrated = readFileSync(join(root, ".cortex-design", deckId, "deck.bento.html"), "utf8");
    expect(migrated).not.toContain("STALE_EDITOR_RUNTIME");
    expect(migrated).toContain('name="cortex-slides-runtime"');
  });

  it("bentoSetStage 推进 gate;bentoWriteDeckHtml 覆写并 bump revision", async () => {
    const staged = await invoke<{ ok: boolean }>("slides:bentoSetStage", {
      workspaceRoot: root,
      deckId: DECK,
      stage: "outline-approved",
    });
    expect(staged.ok).toBe(true);
    const loaded = await invoke<{ ok: boolean; stage: string; revision: number }>("slides:bentoGetDeck", {
      workspaceRoot: root,
      deckId: DECK,
    });
    expect(loaded.stage).toBe("outline-approved");

    // 用当前文件内容微调后整份回写(模拟编辑器 autosave 产物)。
    const html = readFileSync(join(root, ".cortex-design", DECK, "deck.bento.html"), "utf8").replace(
      "IPC 测试",
      "IPC 已编辑",
    );
    const saved = await invoke<{ ok: boolean; revision?: number }>("slides:bentoWriteDeckHtml", {
      workspaceRoot: root,
      deckId: DECK,
      html,
    });
    expect(saved.ok).toBe(true);
    expect(saved.revision).toBe(loaded.revision + 1);
  });

  it("bentoExportFile:用户取消 → canceled=true 不算失败", async () => {
    const res = await invoke<{ ok: boolean; canceled?: boolean }>("slides:bentoExportFile", {
      workspaceRoot: root,
      deckId: DECK,
    });
    expect(res.ok).toBe(false);
    expect(res.canceled).toBe(true);
  });

  it("bentoExportFile 使用当前 runtime 换壳并采用中性文件类型名称", async () => {
    const deckId = "deckexport1";
    const target = join(root, "exported.bento.html");
    const created = await invoke<{ ok: boolean }>("slides:bentoCreateDeck", {
      workspaceRoot: root,
      deckId,
      title: "导出测试",
    });
    expect(created.ok).toBe(true);
    const doc = buildStarterBentoDoc("导出测试");
    const staleHtml = injectBentoDoc(
      'STALE_EXPORT_RUNTIME <html><head><title>旧</title><script type="application/bento+json" id="bento-doc"></script></head><body></body></html>',
      doc,
    )!;
    expect((await invoke<{ ok: boolean }>("slides:bentoWriteDeckHtml", {
      workspaceRoot: root,
      deckId,
      html: staleHtml,
    })).ok).toBe(true);
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: target });

    const result = await invoke<{ ok: boolean; path?: string }>("slides:bentoExportFile", {
      workspaceRoot: root,
      deckId,
    });

    expect(result).toEqual({ ok: true, path: target });
    const exported = readFileSync(target, "utf8");
    expect(exported).not.toContain("STALE_EXPORT_RUNTIME");
    expect(exported).toContain('name="cortex-slides-runtime"');
    expect(JSON.parse(extractBentoDocJson(exported)!)).toMatchObject({ title: "导出测试" });
    expect(vi.mocked(dialog.showSaveDialog)).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ name: "HTML 演示文稿", extensions: ["html"] }] }),
    );
  });

  it("bentoExportFile 在用户选定路径后读取最新文档,不丢失对话框等待期间的编辑", async () => {
    const deckId = "deckexport2";
    const target = join(root, "exported-latest.bento.html");
    expect((await invoke<{ ok: boolean }>("slides:bentoCreateDeck", {
      workspaceRoot: root,
      deckId,
      title: "导出前",
    })).ok).toBe(true);
    let resolveDialog!: (value: { canceled: false; filePath: string }) => void;
    let markDialogShown!: () => void;
    const dialogShown = new Promise<void>((resolve) => { markDialogShown = resolve; });
    vi.mocked(dialog.showSaveDialog).mockImplementationOnce(async () => {
      markDialogShown();
      return await new Promise((resolve) => { resolveDialog = resolve; });
    });

    const exporting = invoke<{ ok: boolean; path?: string }>("slides:bentoExportFile", {
      workspaceRoot: root,
      deckId,
    });
    await dialogShown;
    const currentHtml = readFileSync(join(root, ".cortex-design", deckId, "deck.bento.html"), "utf8");
    const latestDoc = buildStarterBentoDoc("导出后");
    expect((await invoke<{ ok: boolean }>("slides:bentoWriteDeckHtml", {
      workspaceRoot: root,
      deckId,
      html: injectBentoDoc(currentHtml, latestDoc)!,
    })).ok).toBe(true);
    resolveDialog({ canceled: false, filePath: target });

    expect(await exporting).toEqual({ ok: true, path: target });
    expect(JSON.parse(extractBentoDocJson(readFileSync(target, "utf8"))!)).toMatchObject({ title: "导出后" });
  });
});

describe("演示模式经 IPC(bento)", () => {
  const PRESENT_DECK = "deckpres01";
  const presentMock = vi.mocked(openPresenterWindow);

  it("加载 deck 后开窗:railIndices 剔除 stateOf 状态页;deck 不存在 → not_found", async () => {
    const created = await invoke<{ ok: boolean }>("slides:bentoCreateDeck", {
      workspaceRoot: root,
      deckId: PRESENT_DECK,
      title: "演示",
    });
    expect(created.ok).toBe(true);
    const starter = buildStarterBentoDoc("演示") as unknown as { slides: Array<Record<string, unknown>> };
    const base = starter.slides[0]!;
    const doc = {
      ...(starter as unknown as Record<string, unknown>),
      slides: [
        { ...structuredClone(base), id: "s1" },
        { ...structuredClone(base), id: "s2", stateOf: "s1" },
        { ...structuredClone(base), id: "s3" },
      ],
    };
    const written = await writeBentoDoc({ workspaceRoot: root, deckId: PRESENT_DECK, doc, expectedRevision: 0 });
    expect(written.ok).toBe(true);

    // 模拟「创建后 runtime 已升级」的旧 deck:把 deck 文件换成带旧壳标记的合成壳。
    const staleShell =
      "STALE_RUNTIME_MARKER " +
      '<!DOCTYPE html>\n<html><head><title>Bento Slides</title>\n' +
      '<script type="application/bento+json" id="bento-doc"></script>\n' +
      "</head><body></body></html>";
    const staleHtml = injectBentoDoc(staleShell, doc as { title?: unknown })!;
    const resaved = await invoke<{ ok: boolean }>("slides:bentoWriteDeckHtml", {
      workspaceRoot: root,
      deckId: PRESENT_DECK,
      html: staleHtml,
    });
    expect(resaved.ok).toBe(true);

    presentMock.mockClear();
    const hit = await invoke<{ ok: boolean }>("slides:present", {
      workspaceRoot: root,
      deckId: PRESENT_DECK,
      startIndex: 1,
    });
    expect(hit.ok).toBe(true);
    expect(presentMock).toHaveBeenCalledTimes(1);
    const args = presentMock.mock.calls[0]![0];
    expect(args).toMatchObject({ title: "演示", startIndex: 1, railIndices: [0, 2] });
    // 放映换壳:加载的不是 deck 原文件,而是当前 runtime + deck 文档的临时副本,
    // 临时目录经 cleanupPath 交给演示窗口在关闭时删除。
    expect(args.deckHtmlPath.startsWith(tmpdir())).toBe(true);
    expect(args.cleanupPath).toBe(args.deckHtmlPath.replace(/[/\\]deck\.bento\.html$/, ""));
    const presented = readFileSync(args.deckHtmlPath, "utf8");
    expect(presented).not.toContain("STALE_RUNTIME_MARKER");
    expect(presented).toContain('id="bento-rt"'); // 当前压缩 runtime 壳标记
    expect(extractBentoDocJson(presented)).toContain('"s1"');

    // deck 不存在 → not_found,且不开窗。
    presentMock.mockClear();
    const missing = await invoke<{ ok: boolean; error?: { code: string } }>("slides:present", {
      workspaceRoot: root,
      deckId: "decknone01",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.error) expect(missing.error.code).toBe("not_found");
    expect(presentMock).not.toHaveBeenCalled();
  });
});
