// Slides IPC 域测试:存根 ipcMain 捕获 handler,真实 fs(mkdtemp)走完整持久化;
// 同时验证「注册面 == 镜像契约通道清单」与 core/desktop 运行时常量一致(防漂移)。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlidesDeckManifest, SlidesOutline } from "@cortex-work/core/design/slides/slides-types";
import {
  SLIDES_EXPORT_FORMATS as CORE_FORMATS,
  SLIDES_IPC_CHANNELS as CORE_CHANNELS,
} from "@cortex-work/core/desktop/slides-ipc-types";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  },
}));

vi.mock("../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { registerSlidesHandlers } from "./slides";
import { SLIDES_EXPORT_FORMATS, SLIDES_IPC_CHANNELS } from "./slides-ipc-types";

const DECK = "deckipc01";
let root: string;

// 便捷 invoke:直接调用被捕获的 handler(event 传 null,handler 不使用 sender)。
async function invoke<T>(channel: string, req: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册: ${channel}`);
  return (await handler(null, req)) as T;
}

type DeckResult = { ok: true; manifest: SlidesDeckManifest; newSlotId?: string } | { ok: false; error: { code: string } };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-ipc-"));
  registerSlidesHandlers();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("契约镜像一致性", () => {
  it("core 与 desktop 的通道清单/导出格式常量逐项一致", () => {
    expect([...SLIDES_IPC_CHANNELS]).toEqual([...CORE_CHANNELS]);
    expect([...SLIDES_EXPORT_FORMATS]).toEqual([...CORE_FORMATS]);
  });

  it("注册面恰好等于契约通道清单", () => {
    expect([...handlers.keys()].sort()).toEqual([...SLIDES_IPC_CHANNELS].sort());
  });
});

describe("deck 生命周期经 IPC", () => {
  it("createDeck → loadDeck 往返", async () => {
    const created = await invoke<DeckResult>("slides:createDeck", {
      workspaceRoot: root,
      deckId: DECK,
      title: "IPC 测试",
    });
    expect(created.ok).toBe(true);
    const loaded = await invoke<DeckResult>("slides:loadDeck", { workspaceRoot: root, deckId: DECK });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.manifest.title).toBe("IPC 测试");
  });

  it("approveOutline 盖章 + 生成空 slots + 状态推进", async () => {
    const outline: Omit<SlidesOutline, "approvedAt"> = {
      version: 1,
      summary: "三页演示",
      items: [
        { id: "o1", title: "开场", purpose: "hook", keyPoints: ["a"] },
        { id: "o2", title: "论证", purpose: "body", keyPoints: ["b"] },
        { id: "o3", title: "收尾", purpose: "cta", keyPoints: ["c"] },
      ],
    };
    const result = await invoke<DeckResult>("slides:approveOutline", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: 0,
      outline,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.status).toBe("outline-approved");
      expect(result.manifest.outline?.approvedAt).toBeTruthy();
      expect(result.manifest.slides).toHaveLength(3);
      expect(result.manifest.slides.map((s) => s.status)).toEqual(["empty", "empty", "empty"]);
      expect(result.manifest.activeSlideId).toBe(result.manifest.slides[0]!.id);
    }
  });

  it("insert / duplicate / reorder / delete 全链路", async () => {
    let rev = (await load()).revision;
    const inserted = await invoke<DeckResult>("slides:insertSlide", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: rev,
      title: "插入页",
    });
    expect(inserted.ok).toBe(true);
    const newId = inserted.ok ? inserted.newSlotId! : "";
    expect(newId).toMatch(/^slot-\d{3}$/);

    rev = (await load()).revision;
    const duplicated = await invoke<DeckResult>("slides:duplicateSlide", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: rev,
      slotId: newId,
    });
    expect(duplicated.ok).toBe(true);

    const manifest = await load();
    const ids = manifest.slides.sort((a, b) => a.order - b.order).map((s) => s.id);
    const reversed = [...ids].reverse();
    const reordered = await invoke<DeckResult>("slides:reorderSlides", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: manifest.revision,
      orderedSlotIds: reversed,
    });
    expect(reordered.ok).toBe(true);
    if (reordered.ok) {
      expect(reordered.manifest.slides.sort((a, b) => a.order - b.order).map((s) => s.id)).toEqual(reversed);
    }

    const afterReorder = await load();
    const deleted = await invoke<DeckResult>("slides:deleteSlide", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: afterReorder.revision,
      slotId: newId,
    });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.manifest.slides.some((s) => s.id === newId)).toBe(false);
  });

  it("reorder 传入非法排列 → 结构化错误(不抛)", async () => {
    const manifest = await load();
    const result = await invoke<DeckResult>("slides:reorderSlides", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: manifest.revision,
      orderedSlotIds: ["slot-999"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("io_error");
  });

  it("saveEditedHtml 落盘并 bump revision;revision 过期 → revision_conflict", async () => {
    const manifest = await load();
    const slotId = manifest.slides.sort((a, b) => a.order - b.order)[0]!.id;
    const saved = await invoke<DeckResult>("slides:saveEditedHtml", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: manifest.revision,
      slotId,
      html: "<!doctype html><html><body>已编辑</body></html>",
    });
    expect(saved.ok).toBe(true);
    const read = await invoke<{ ok: true; html: string } | { ok: false }>("slides:readSlideHtml", {
      workspaceRoot: root,
      deckId: DECK,
      slotId,
    });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.html).toContain("已编辑");

    const stale = await invoke<DeckResult>("slides:saveEditedHtml", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: manifest.revision,
      slotId,
      html: "<html>stale</html>",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
  });

  it("setActiveSlide 更新指针", async () => {
    const manifest = await load();
    const last = manifest.slides.sort((a, b) => a.order - b.order).at(-1)!;
    const result = await invoke<DeckResult>("slides:setActiveSlide", {
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: manifest.revision,
      slotId: last.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.activeSlideId).toBe(last.id);
  });

  // 回归:renderer 页非 file:// 源,<img src="file://…"> 会被 Chromium 拦掉(实测碎图),
  // 故缩略图必须由主进程读盘转 data URL。
  it("readSnapshot:缺快照 → not_found;非法 slot/deck → invalid_path", async () => {
    const missing = await invoke<{ ok: boolean; error?: { code: string } }>("slides:readSnapshot", {
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("not_found");

    const badSlot = await invoke<{ ok: boolean; error?: { code: string } }>("slides:readSnapshot", {
      workspaceRoot: root,
      deckId: DECK,
      slotId: "../../etc/passwd",
    });
    expect(badSlot.ok).toBe(false);
    expect(badSlot.error?.code).toBe("invalid_path");

    const badDeck = await invoke<{ ok: boolean; error?: { code: string } }>("slides:readSnapshot", {
      workspaceRoot: root,
      deckId: "../evil",
      slotId: "slot-001",
    });
    expect(badDeck.ok).toBe(false);
    expect(badDeck.error?.code).toBe("invalid_path");
  });

  it("readSnapshot:真实 PNG → data URL", async () => {
    // 造一张最小合法 PNG(读闸门会嗅探扩展名与体积)。
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    mkdirSync(join(root, ".cortex-design", DECK, "snapshots"), { recursive: true });
    writeFileSync(join(root, ".cortex-design", DECK, "snapshots", "slot-001.png"), png);
    const result = await invoke<{ ok: boolean; dataUrl?: string }>("slides:readSnapshot", {
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-001",
    });
    expect(result.ok).toBe(true);
    expect(result.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("非法 workspaceRoot / deckId 结构化拒绝", async () => {
    const badRoot = await invoke<DeckResult>("slides:loadDeck", { workspaceRoot: join(root, "nope"), deckId: DECK });
    expect(badRoot.ok).toBe(false);
    if (!badRoot.ok) expect(badRoot.error.code).toBe("invalid_path");
    const badId = await invoke<DeckResult>("slides:loadDeck", { workspaceRoot: root, deckId: "../.." });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toBe("invalid_path");
  });

  it("export 占位通道返回结构化未启用错误(Task 9/10 前)", async () => {
    const exported = await invoke<{ ok: boolean }>("slides:export", { workspaceRoot: root, deckId: DECK, format: "pptx" });
    expect(exported.ok).toBe(false);
  });

  it("check/screenshot 通道走真实巡检:非法 deck 结构化拒绝(不抛)", async () => {
    // 真实渲染需 Electron GUI,本用例只验证 IPC 层错误封装;渲染路径由
    // capabilities/slides/inspect.test.ts 用假窗口覆盖。
    const check = await invoke<{ ok: boolean; error?: { code: string } }>("slides:check", {
      workspaceRoot: join(root, "nope"),
      deckId: DECK,
    });
    expect(check.ok).toBe(false);
    expect(check.error?.code).toBe("invalid_path");
    const shot = await invoke<{ ok: boolean; error?: { code: string } }>("slides:screenshot", {
      workspaceRoot: root,
      deckId: DECK,
      slotId: "slot-999",
    });
    expect(shot.ok).toBe(false);
    expect(shot.error?.code).toBe("not_found");
  });
});

async function load(): Promise<SlidesDeckManifest> {
  const result = await invoke<DeckResult>("slides:loadDeck", { workspaceRoot: root, deckId: DECK });
  if (!result.ok) throw new Error("loadDeck failed");
  return result.manifest;
}
