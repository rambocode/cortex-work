// cortex-slides MCP 工具集测试:用捕获式假 McpServer + 真实 tmp deck 验证
// 工具清单契约、提纲批准 gate、revision 乐观锁、唯一匹配替换与资产白名单。
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { registerSlidesTools } from "./tools";
import { createDeckWorkspace, loadDeckManifest, updateDeckManifest } from "./workspace";
import {
  clearAllSlidesSessions,
  getSlidesSession,
  parseSlidesRunId,
  registerSlidesSession,
  unregisterSlidesSession,
} from "./session";
import { slidesSlideHtmlPath } from "@cortex-work/core/design/slides/slides-paths";

const DECK = "decktool01";
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

async function currentRevision(): Promise<number> {
  const loaded = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
  if (!loaded.ok) throw new Error("load failed");
  return loaded.value.manifest.revision;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-tools-"));
  const created = await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "工具测试" });
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

describe("工具清单契约(MVP)", () => {
  it("注册的工具名固定", () => {
    expect([...tools.keys()].sort()).toEqual(
      [
        "get_deck_state",
        "set_theme",
        "propose_outline",
        "place_slide_html",
        "read_slide_html",
        "replace_slide_text",
        "move_slide",
        "insert_slide",
        "delete_slide",
        "check_slide",
        "screenshot_slide",
        "upload_asset",
      ].sort(),
    );
  });
});

describe("提纲批准 gate 与生成流", () => {
  it("draft 态直接 place_slide_html 被拒(outline_not_approved)", async () => {
    // 先插入一个 slot(结构操作不受 gate 限制)。
    const inserted = await call("insert_slide", { expected_revision: await currentRevision(), title: "P1" });
    expect(inserted.ok).toBe(true);
    const result = await call("place_slide_html", {
      expected_revision: await currentRevision(),
      slot_id: inserted.slotId,
      html: "<!doctype html><html><body>x</body></html>",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("outline_not_approved");
  });

  it("propose_outline 写草案并把状态推进为 outline-proposed", async () => {
    const result = await call("propose_outline", {
      expected_revision: await currentRevision(),
      summary: "三页方案",
      items: [
        { id: "o1", title: "开场", purpose: "hook", keyPoints: ["a"] },
        { id: "o2", title: "收尾", purpose: "cta", keyPoints: ["b"] },
      ],
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, ".cortex-design", DECK, "drafts", "outline.json"))).toBe(true);
    const state = await call("get_deck_state");
    expect((state.deck as { status: string }).status).toBe("outline-proposed");
    // proposed 态仍不能写页面。
    const denied = await call("place_slide_html", {
      expected_revision: await currentRevision(),
      slot_id: "slot-001",
      html: "<html></html>",
    });
    expect(denied.code).toBe("outline_not_approved");
  });

  it("批准后 place_slide_html 可写入并 bump slot 状态", async () => {
    // 模拟用户批准(IPC approveOutline 的等价 manifest 变更)。
    const approved = await updateDeckManifest({
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: await currentRevision(),
      mutate: (m) => {
        m.status = "outline-approved";
        return m;
      },
    });
    expect(approved.ok).toBe(true);
    const result = await call("place_slide_html", {
      expected_revision: await currentRevision(),
      slot_id: "slot-001",
      html: "<!doctype html><html><body><h1 data-cortex-id=\"t\">标题一</h1></body></html>",
    });
    expect(result.ok).toBe(true);
    expect((result.slot as { status: string }).status).toBe("ready");
  });

  it("set_theme 携带过期 revision → revision_conflict", async () => {
    const result = await call("set_theme", {
      expected_revision: 0,
      theme: {
        name: "深色",
        mood: ["bold"],
        palette: {
          background: "#0f172a",
          foreground: "#f8fafc",
          primary: "#38bdf8",
          secondary: "#94a3b8",
          accent: "#f59e0b",
        },
        fonts: { heading: "PingFang SC", body: "PingFang SC" },
        density: "balanced",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("revision_conflict");
  });
});

describe("replace_slide_text 唯一匹配", () => {
  it("命中唯一目标才替换;0 次/多次都报错", async () => {
    const zero = await call("replace_slide_text", {
      expected_revision: await currentRevision(),
      slot_id: "slot-001",
      find: "不存在的文本",
      replace: "x",
    });
    expect(zero.code).toBe("not_found");

    const ok = await call("replace_slide_text", {
      expected_revision: await currentRevision(),
      slot_id: "slot-001",
      find: "标题一",
      replace: "标题壹",
    });
    expect(ok.ok).toBe(true);
    const html = readFileSync(join(root, slidesSlideHtmlPath(DECK, "slot-001")), "utf8");
    expect(html).toContain("标题壹");

    // 制造重复文本再断言多次匹配被拒。
    await call("place_slide_html", {
      expected_revision: await currentRevision(),
      slot_id: "slot-001",
      html: "<!doctype html><html><body><p>重复</p><p>重复</p></body></html>",
    });
    const multi = await call("replace_slide_text", {
      expected_revision: await currentRevision(),
      slot_id: "slot-001",
      find: "重复",
      replace: "x",
    });
    expect(multi.ok).toBe(false);
    expect(multi.code).toBe("invalid_payload");
  });
});

describe("结构操作与资产", () => {
  it("move_slide 调整顺序", async () => {
    await call("insert_slide", { expected_revision: await currentRevision(), title: "尾页" });
    const state = await call("get_deck_state");
    const ids = (state.deck as { slides: Array<{ id: string; order: number }> }).slides
      .sort((a, b) => a.order - b.order)
      .map((s) => s.id);
    const moved = await call("move_slide", {
      expected_revision: await currentRevision(),
      slot_id: ids.at(-1)!,
      to_index: 0,
    });
    expect(moved.ok).toBe(true);
    expect((moved.order as string[])[0]).toBe(ids.at(-1));
  });

  it("delete_slide 软删", async () => {
    const state = await call("get_deck_state");
    const ids = (state.deck as { slides: Array<{ id: string; order: number }> }).slides.map((s) => s.id);
    const removed = await call("delete_slide", {
      expected_revision: await currentRevision(),
      slot_id: ids.at(-1)!,
    });
    expect(removed.ok).toBe(true);
  });

  it("upload_asset 白名单与路径返回;非法扩展名被拒", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const ok = await call("upload_asset", { file_name: "hero.png", base64: png });
    expect(ok.ok).toBe(true);
    expect(ok.path).toBe(`.cortex-design/${DECK}/assets/generated/hero.png`);
    // 同名自动加序号。
    const again = await call("upload_asset", { file_name: "hero.png", base64: png });
    expect(again.path).toBe(`.cortex-design/${DECK}/assets/generated/hero-2.png`);
    const bad = await call("upload_asset", { file_name: "evil.sh", base64: png });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("unsupported_format");
  });
});

describe("session 注册表", () => {
  it("parseSlidesRunId 只接受 slides:<docId>: 前缀", () => {
    expect(parseSlidesRunId("slides:abc123:r1")).toBe("abc123");
    expect(parseSlidesRunId("design:abc123:r1")).toBeNull();
    expect(parseSlidesRunId("slides:../evil:r1")).toBeNull();
    expect(parseSlidesRunId("slides:abc123")).toBeNull();
  });

  it("register/unregister/clear 生命周期;未注册会话取不到 state", () => {
    expect(getSlidesSession("nope")).toBeUndefined();
    registerSlidesSession({ sessionId: "s1", runId: "slides:d1:r", documentId: "d1", workspaceRoot: "/w" });
    expect(getSlidesSession("s1")?.documentId).toBe("d1");
    unregisterSlidesSession("s1");
    expect(getSlidesSession("s1")).toBeUndefined();
    registerSlidesSession({ sessionId: "s2", runId: "slides:d2:r", documentId: "d2", workspaceRoot: "/w" });
    clearAllSlidesSessions();
    expect(getSlidesSession("s2")).toBeUndefined();
  });
});
