// cortex-slides MCP 工具集测试(bento 化):捕获式假 McpServer + 真实 tmp deck 验证
// 工具清单契约、提纲批准 gate、revision 乐观锁与资产写入。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildStarterBentoDoc } from "@cortex-work/core/design/slides/bento/bento-doc-schema";

vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { registerSlidesTools } from "./tools";
import { createBentoDeck, readBentoDeck } from "./bento-workspace";

const DECK = "decktool01";
const SHELL =
  '<!DOCTYPE html>\n<html><head><title>Bento Slides</title>\n' +
  '<script type="application/bento+json" id="bento-doc"></script>\n' +
  "</head><body><div id=\"app\"></div></body></html>";

let root: string;

// 捕获式假 McpServer:只记录 registerTool,handler 由测试直接调用。
type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const tools = new Map<string, ToolHandler>();
const fakeMcp = {
  registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
    tools.set(name, handler);
  },
} as unknown as McpServer;

async function call(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool 未注册: ${name}`);
  const result = await handler(input);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** 以 starter 为基底扩展出 N 页文档(结构合法)。 */
function docWithSlides(title: string, count: number): Record<string, unknown> {
  const starter = buildStarterBentoDoc(title) as unknown as { slides: Array<Record<string, unknown>> };
  const first = starter.slides[0]!;
  const slides = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(first),
    id: `slide-${i + 1}`,
  }));
  return { ...(starter as unknown as Record<string, unknown>), slides };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cortex-bento-tools-"));
  const created = await createBentoDeck({ workspaceRoot: root, deckId: DECK, title: "工具测试", runtimeHtml: SHELL });
  expect(created.ok).toBe(true);
  registerSlidesTools(fakeMcp, {
    sessionId: "sess-1",
    runId: `slides:${DECK}:r1`,
    documentId: DECK,
    workspaceRoot: root,
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("工具清单契约(bento)", () => {
  it("注册的工具名固定且不含旧 slot 工具", () => {
    expect([...tools.keys()].sort()).toEqual([
      "add_asset",
      // 研究来源登记（演示文稿检索）：制作期溯源材料，不进 deck 交付物。
      "add_source",
      "get_deck_state",
      "list_sources",
      "propose_outline",
      "set_deck_doc",
      // 局部写入:改一页只发一页。整份 deck 可达数万 token,为改一处重发整份会被截断,
      // 写入永远落不了盘(用户实测「卡在正在生成演示文稿」)。
      "set_slides",
    ]);
  });
});

describe("get_deck_state", () => {
  it("返回 doc/revision/stage/hint", async () => {
    const res = await call("get_deck_state");
    expect(res.ok).toBe(true);
    expect(res.revision).toBe(0);
    expect(res.stage).toBe("draft");
    expect((res.doc as { title: string }).title).toBe("工具测试");
    expect(String(res.hint)).toContain("propose_outline");
  });
});

describe("提纲 gate 与 set_deck_doc", () => {
  it("draft 阶段拒绝多页全篇写入(outline_not_approved)", async () => {
    const res = await call("set_deck_doc", { expected_revision: 0, doc: docWithSlides("工具测试", 5) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("outline_not_approved");
  });

  it("propose_outline → stage 变 outline-proposed;仍拒绝全篇", async () => {
    const res = await call("propose_outline", {
      version: 1,
      summary: "narrative",
      items: [{ id: "o1", title: "开场", purpose: "hook", keyPoints: ["a"] }],
    });
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("outline-proposed");
    const rejected = await call("set_deck_doc", { expected_revision: 0, doc: docWithSlides("工具测试", 3) });
    expect(rejected.code).toBe("outline_not_approved");
  });

  it("批准(stage=outline-approved)后全篇写入成功且推进 ready", async () => {
    const { updateBentoDeckMeta } = await import("./bento-workspace");
    await updateBentoDeckMeta({ workspaceRoot: root, deckId: DECK, patch: { stage: "outline-approved" } });
    const res = await call("set_deck_doc", { expected_revision: 0, doc: docWithSlides("工具测试", 4) });
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("ready");
    expect(res.revision).toBe(1);
    const state = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    if (state.ok) expect(state.value.doc?.slides).toHaveLength(4);
  });

  it("兼容模型把完整 doc 作为 JSON 字符串传入", async () => {
    const doc = docWithSlides("字符串文档", 3);
    const res = await call("set_deck_doc", {
      expected_revision: 1,
      doc: JSON.stringify(doc),
    });
    expect(res.ok).toBe(true);
    expect(res.revision).toBe(2);
    const state = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    if (state.ok) {
      expect(state.value.doc?.title).toBe("字符串文档");
      expect(state.value.doc?.slides).toHaveLength(3);
    }
  });

  it("错误 expected_revision → revision_conflict", async () => {
    const res = await call("set_deck_doc", { expected_revision: 0, doc: docWithSlides("工具测试", 4) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("revision_conflict");
  });

  it("schema 不通过 → invalid_doc", async () => {
    const res = await call("set_deck_doc", { expected_revision: 2, doc: { format: "bento/slides", slides: [] } });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_doc");
  });
});

describe("add_asset", () => {
  it("写入资产表并返回 asset:<key> 引用", async () => {
    const res = await call("add_asset", {
      expected_revision: 2,
      file_name: "Hero Image.PNG",
      mime_type: "image/png",
      base64: "aGVsbG8=",
    });
    expect(res.ok).toBe(true);
    expect(res.asset).toBe("asset:hero-image.png");
    const state = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    if (state.ok) {
      expect(state.value.doc?.assets?.["hero-image.png"]).toBe("data:image/png;base64,aGVsbG8=");
    }
  });

  it("非法 base64 → invalid_asset", async () => {
    const res = await call("add_asset", {
      expected_revision: 3,
      file_name: "x.png",
      mime_type: "image/png",
      base64: "%%%",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_asset");
  });
});

describe("初始生成按页分批落盘", () => {
  it("占位骨架期间拒绝整份覆盖和 >3 页批次,最后一批自动推进 ready", async () => {
    const { updateBentoDeckMeta, writeBentoDoc } = await import("./bento-workspace");
    const skeleton = docWithSlides("流式生成", 4) as {
      slides: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    skeleton.slides = skeleton.slides.map((slide, index) => ({
      ...slide,
      name: `第 ${index + 1} 页`,
      cortexGeneration: { status: "pending", outlineItemId: `o${index + 1}` },
    }));
    expect(
      (
        await writeBentoDoc({
          workspaceRoot: root,
          deckId: DECK,
          doc: skeleton,
          expectedRevision: 3,
          stage: "outline-approved",
        })
      ).ok,
    ).toBe(true);
    await updateBentoDeckMeta({
      workspaceRoot: root,
      deckId: DECK,
      patch: { stage: "outline-approved" },
    });

    const fullWrite = await call("set_deck_doc", {
      expected_revision: 4,
      doc: docWithSlides("不应整份覆盖", 4),
    });
    expect(fullWrite).toMatchObject({ ok: false, code: "streaming_required" });

    const state = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    expect(state.ok).toBe(true);
    if (!state.ok || !state.value.doc) return;
    const generated = state.value.doc.slides.map((slide) => {
      const { cortexGeneration: _pending, ...complete } = slide as typeof slide & {
        cortexGeneration?: unknown;
      };
      return { ...complete, notes: "生成完成" };
    });

    const tooLarge = await call("set_slides", {
      expected_revision: 4,
      slides: generated,
    });
    expect(tooLarge).toMatchObject({ ok: false, code: "too_many_slides" });

    const firstBatch = await call("set_slides", {
      expected_revision: 4,
      slides: generated.slice(0, 3),
    });
    expect(firstBatch).toMatchObject({
      ok: true,
      revision: 5,
      nextExpectedRevision: 5,
      stage: "outline-approved",
      remainingPages: [4],
    });

    const lastBatch = await call("set_slides", {
      expected_revision: 5,
      slides: generated.slice(3),
    });
    expect(lastBatch).toMatchObject({
      ok: true,
      revision: 6,
      nextExpectedRevision: 6,
      stage: "ready",
      remainingPages: [],
    });
    const completed = await readBentoDeck({ workspaceRoot: root, deckId: DECK });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.stage).toBe("ready");
      expect(
        completed.value.doc?.slides.some((slide) => "cortexGeneration" in slide),
      ).toBe(false);
    }
  });
});
