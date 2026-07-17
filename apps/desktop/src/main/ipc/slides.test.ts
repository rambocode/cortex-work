// Slides IPC 域测试:存根 ipcMain 捕获 handler,真实 fs(mkdtemp)走完整持久化;
// 同时验证「注册面 == 镜像契约通道清单」与 core/desktop 运行时常量一致(防漂移)。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlidesDeckManifest, SlidesOutline } from "@cortex-work/core/design/slides/slides-types";
import {
  SLIDES_EXPORT_FORMATS as CORE_FORMATS,
  SLIDES_IPC_CHANNELS as CORE_CHANNELS,
} from "@cortex-work/core/desktop/slides-ipc-types";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
}));

// app.getAppPath() → apps/desktop 根:模板通道走真实 resources/slides/templates 资源。
const APP_PATH = fileURLToPath(new URL("../../..", import.meta.url));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  },
  app: { getAppPath: () => APP_PATH },
}));

vi.mock("../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// 演示窗口是真实 BrowserWindow 的薄壳,IPC 层只验证「组装 + 起始页索引」;
// 窗口生命周期由 presenter-window.test.ts 用假窗口覆盖。
vi.mock("../presenter-window", () => ({
  openPresenterWindow: vi.fn(async () => {}),
}));

import { registerSlidesHandlers } from "./slides";
import { openPresenterWindow } from "../presenter-window";
import { SLIDES_EXPORT_FORMATS, SLIDES_IPC_CHANNELS } from "./slides-ipc-types";
import {
  createSlidesPipelineRunAction,
  recordSlidesPipelineRoleResult,
  startSlidesPipelineRole,
} from "../capabilities/slides/pipeline/tools";
import * as pipelineTools from "../capabilities/slides/pipeline/tools";

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

  it("readNotes / saveNotes 共用 slot 与 deck revision 合同", async () => {
    const before = await load();
    const slotId = before.slides[0]!.id;

    const empty = await invoke<{ ok: boolean; markdown?: string; slotRevision?: number }>("slides:readNotes", {
      workspaceRoot: root,
      deckId: DECK,
      slotId,
    });
    expect(empty).toMatchObject({ ok: true, markdown: "", slotRevision: before.slides[0]!.revision });

    const saved = await invoke<DeckResult>("slides:saveNotes", {
      workspaceRoot: root,
      deckId: DECK,
      slotId,
      markdown: "## 演讲提示\n\n先讲用户痛点。",
      expectedRevision: before.revision,
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.manifest.revision).toBe(before.revision + 1);
      expect(saved.manifest.slides.find((slot) => slot.id === slotId)?.notesPath).toContain(`notes/${slotId}.md`);
    }

    const readBack = await invoke<{ ok: boolean; markdown?: string }>("slides:readNotes", {
      workspaceRoot: root,
      deckId: DECK,
      slotId,
    });
    expect(readBack).toMatchObject({ ok: true, markdown: "## 演讲提示\n\n先讲用户痛点。" });

    const conflict = await invoke<DeckResult>("slides:saveNotes", {
      workspaceRoot: root,
      deckId: DECK,
      slotId,
      markdown: "过期覆盖",
      expectedRevision: before.revision,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("revision_conflict");
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

  it("导出质量预检对非法 deck 返回结构化错误", async () => {
    const result = await invoke<{ ok: boolean; error?: { code: string } }>("slides:analyzeExportQuality", {
      workspaceRoot: root,
      deckId: "../evil",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_path");
  });

  it("无历史 pipeline 时 latest 返回 null;不存在 run 结构化拒绝", async () => {
    const latest = await invoke<{ ok: boolean; run?: unknown }>("slides:getLatestPipelineRun", {
      workspaceRoot: root,
      deckId: DECK,
    });
    expect(latest).toEqual({ ok: true, run: null });
    const missing = await invoke<{ ok: boolean; error?: { code: string } }>("slides:getPipelineRun", {
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-missing",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("not_found");
  });

  it("acceptPipelineRole 会把 expectedUpdatedAt 下推到 action，避免 IPC 层分离校验", async () => {
    await seedAwaitingApprovalRun("run-accept-ipc");
    const loaded = await invoke<{ ok: boolean; run?: { updatedAt: string } }>("slides:getPipelineRun", {
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-accept-ipc",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !loaded.run) return;

    const acceptSpy = vi.spyOn(pipelineTools, "acceptSlidesPipelineRoleResult");
    const accepted = await invoke<{ ok: boolean }>("slides:acceptPipelineRole", {
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-accept-ipc",
      role: "topic-researcher",
      expectedUpdatedAt: loaded.run.updatedAt,
    });
    expect(accepted.ok).toBe(true);
    expect(acceptSpy).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: loaded.run.updatedAt }));
    acceptSpy.mockRestore();
  });
});

describe("演示模式经 IPC", () => {
  const PRESENT_DECK = "deckpres01";
  const presentMock = vi.mocked(openPresenterWindow);

  // 建一个含 3 页提纲的 deck,前两页写入 HTML(→ ready),第三页保持 empty。
  async function setupPresentDeck(): Promise<SlidesDeckManifest> {
    await invoke("slides:createDeck", { workspaceRoot: root, deckId: PRESENT_DECK, title: "演示" });
    let m = (await invoke<DeckResult>("slides:approveOutline", {
      workspaceRoot: root,
      deckId: PRESENT_DECK,
      expectedRevision: 0,
      outline: {
        version: 1,
        summary: "三页",
        items: [
          { id: "o1", title: "一", purpose: "hook", keyPoints: ["a"] },
          { id: "o2", title: "二", purpose: "body", keyPoints: ["b"] },
          { id: "o3", title: "三", purpose: "cta", keyPoints: ["c"] },
        ],
      },
    })) as Extract<DeckResult, { ok: true }>;
    expect(m.ok).toBe(true);
    for (const slotId of m.manifest.slides.slice(0, 2).map((slot) => slot.id)) {
      const saved = (await invoke<DeckResult>("slides:saveEditedHtml", {
        workspaceRoot: root,
        deckId: PRESENT_DECK,
        expectedRevision: m.manifest.revision,
        slotId,
        html: `<!doctype html><html><body>${slotId}</body></html>`,
      })) as Extract<DeckResult, { ok: true }>;
      expect(saved.ok).toBe(true);
      m = saved;
    }
    return m.manifest;
  }

  it("startSlideId 指向第 2 个 ready 页 → startIndex=1;非 ready 页回退 0;无 ready 页 → not_found", async () => {
    const manifest = await setupPresentDeck();
    const readySlots = manifest.slides.filter((slot) => slot.status === "ready");
    const emptySlot = manifest.slides.find((slot) => slot.status === "empty")!;
    expect(readySlots).toHaveLength(2);

    // 指向第 2 个 ready 页:索引按「ready 页序列」计,与 presenter 页序一致。
    presentMock.mockClear();
    const hit = await invoke<{ ok: boolean }>("slides:present", {
      workspaceRoot: root,
      deckId: PRESENT_DECK,
      startSlideId: readySlots[1]!.id,
    });
    expect(hit.ok).toBe(true);
    expect(presentMock).toHaveBeenCalledTimes(1);
    expect(presentMock.mock.calls[0]![0]).toMatchObject({ title: "演示", startIndex: 1 });
    expect(presentMock.mock.calls[0]![0].slides).toHaveLength(2);

    // 指向 empty 页(不在 ready 序列)→ 回退首个 ready 页。
    presentMock.mockClear();
    const fallback = await invoke<{ ok: boolean }>("slides:present", {
      workspaceRoot: root,
      deckId: PRESENT_DECK,
      startSlideId: emptySlot.id,
    });
    expect(fallback.ok).toBe(true);
    expect(presentMock.mock.calls[0]![0]).toMatchObject({ startIndex: 0 });

    // 全空 deck → not_found,且不开窗。
    presentMock.mockClear();
    await invoke("slides:createDeck", { workspaceRoot: root, deckId: "deckpres02", title: "空" });
    const empty = await invoke<{ ok: boolean; error?: { code: string } }>("slides:present", {
      workspaceRoot: root,
      deckId: "deckpres02",
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok && empty.error) expect(empty.error.code).toBe("not_found");
    expect(presentMock).not.toHaveBeenCalled();
  });
});

describe("模板参考页经 IPC", () => {
  it("读取声明过的参考页返回 HTML;未声明路径/未知模板回 not_found", async () => {
    // 走真实随包模板资源(electron mock 的 getAppPath 指向 apps/desktop 根)。
    const okResult = await invoke<{ ok: boolean; html?: string }>("slides:readTemplateReference", {
      templateId: "quiet-axis",
      file: "references/template.html",
    });
    expect(okResult.ok).toBe(true);
    expect(okResult.html?.toLowerCase()).toContain("<!doctype html>");

    // 路径守卫在 readTemplateReferenceHtml 内:非声明 file / 穿越 / 未知 id 一律 not_found。
    for (const req of [
      { templateId: "quiet-axis", file: "../../../etc/passwd" },
      { templateId: "quiet-axis", file: "template.json" },
      { templateId: "nope-xyz", file: "references/template.html" },
    ]) {
      const denied = await invoke<{ ok: boolean; error?: { code: string } }>("slides:readTemplateReference", req);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error?.code).toBe("not_found");
    }
  });
});

async function load(): Promise<SlidesDeckManifest> {
  const result = await invoke<DeckResult>("slides:loadDeck", { workspaceRoot: root, deckId: DECK });
  if (!result.ok) throw new Error("loadDeck failed");
  return result.manifest;
}

async function seedAwaitingApprovalRun(runId: string): Promise<void> {
  const created = await createSlidesPipelineRunAction({
    workspaceRoot: root,
    deckId: DECK,
    kind: "research",
    runId,
  });
  expect(created.ok).toBe(true);
  const started = await startSlidesPipelineRole({
    workspaceRoot: root,
    deckId: DECK,
    runId,
    role: "topic-researcher",
  });
  expect(started.ok).toBe(true);
  const recorded = await recordSlidesPipelineRoleResult({
    workspaceRoot: root,
    deckId: DECK,
    runId,
    role: "topic-researcher",
    result: {
      facts: ["事实 1"],
      sources: [{ title: "来源 A", url: "https://example.com/a" }],
      claims: ["判断 1"],
      openQuestions: ["问题 1"],
    },
  });
  expect(recorded.ok).toBe(true);
}
