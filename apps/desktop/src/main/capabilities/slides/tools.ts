// cortex-slides MCP 工具集(MVP)。所有工具:
//   - 只经 workspace.ts 读写 deck(路径校验/原子写/revision 乐观锁全部继承);
//   - 写工具必须携带 expected_revision(get_deck_state 可得),冲突返回 revision_conflict;
//   - place_slide_html 受提纲批准 gate:manifest.status 为 draft/outline-proposed 时拒绝
//     (outline_not_approved),强制「先确认提纲再批量写页」的产品流程;
//   - 结果一律 JSON 文本(ok/code/message + 数据),Agent 可直接机读。
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlidesDeckManifest, SlidesOutline } from "@cortex-work/core/design/slides/slides-types";
import { createLogger } from "../../log";
import type { SlidesSessionState } from "./session";
import {
  deleteSlide,
  loadDeckManifest,
  readSlideHtml,
  updateDeckManifest,
  writeDeckAsset,
  writeSlideHtml,
  writeSlidesOutlineDraft,
  type SlidesWorkspaceResult,
} from "./workspace";

const log = createLogger("slides");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, message }) }], isError: true };
}

function fromWorkspaceError(result: { ok: false; error: { code: string; message: string } }): ToolResult {
  return errorResult(result.error.code, result.error.message);
}

// Agent 视角的 deck 状态:manifest 全量 + 提示性字段(下一步该干什么)。
function deckStatePayload(manifest: SlidesDeckManifest): Record<string, unknown> {
  return {
    ok: true,
    deck: manifest,
    hint:
      manifest.status === "draft"
        ? "deck 处于草稿态:先 set_theme 设定主题,再 propose_outline 提交提纲等待用户批准。"
        : manifest.status === "outline-proposed"
          ? "提纲已提交,等待用户在界面上批准;批准前不能写正式页面。"
          : manifest.status === "outline-approved" || manifest.status === "generating"
            ? "提纲已批准:用 place_slide_html 按 slot 逐页写入 1280×720 HTML。"
            : "deck 已就绪:可继续修订单页或响应用户的检查/导出请求。",
  };
}

// 主题输入 schema(与 core SlidesTheme 对齐;zod v4 raw shape 交给 registerTool)。
const themeShape = {
  name: z.string().min(1).describe("主题名称"),
  mood: z.array(z.string()).describe("氛围关键词,如 ['clean','modern']"),
  palette: z
    .object({
      background: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      foreground: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      primary: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      secondary: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      accent: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
    })
    .describe("hex 配色"),
  fonts: z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
    mono: z.string().optional(),
  }),
  density: z.enum(["minimal", "balanced", "dense"]),
  imageStyle: z.string().optional(),
  customInstructions: z.string().optional(),
};

const outlineItemShape = z.object({
  id: z.string().min(1).describe("提纲条目稳定 id,如 'o1'"),
  title: z.string().min(1),
  purpose: z.string().describe("该页在叙事中的作用"),
  keyPoints: z.array(z.string()),
  visualIntent: z.string().optional().describe("视觉意图(布局/图表/配图方向)"),
});

// 提纲批准 gate:仅这些状态允许写正式 slide HTML。
const HTML_WRITE_ALLOWED_STATUS = new Set(["outline-approved", "generating", "ready", "error"]);

export function registerSlidesTools(mcp: McpServer, state: SlidesSessionState): void {
  const ctx = { workspaceRoot: state.workspaceRoot, deckId: state.documentId };

  const loadDeck = async (): Promise<SlidesWorkspaceResult<SlidesDeckManifest>> => {
    const result = await loadDeckManifest(ctx);
    return result.ok ? { ok: true, value: result.value.manifest } : result;
  };

  mcp.registerTool(
    "get_deck_state",
    {
      description:
        "读取当前演示文稿(deck)的完整状态:标题、主题、提纲、页面列表(slot id/顺序/状态)与 revision。" +
        "所有写工具都需要本工具返回的 revision 作为 expected_revision。",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const result = await loadDeck();
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult(deckStatePayload(result.value));
    },
  );

  mcp.registerTool(
    "set_theme",
    {
      description: "设置 deck 的结构化主题(配色/字体/密度/氛围)。需要 expected_revision(乐观锁)。",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        theme: z.object(themeShape),
      },
    },
    async ({ expected_revision, theme }): Promise<ToolResult> => {
      const result = await updateDeckManifest({
        ...ctx,
        expectedRevision: expected_revision,
        mutate: (m) => {
          m.theme = theme;
          return m;
        },
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, revision: result.value.revision });
    },
  );

  mcp.registerTool(
    "propose_outline",
    {
      description:
        "提交提纲草案供用户确认。草案写入 drafts/outline.json 并把 deck 状态置为 outline-proposed;" +
        "用户批准前 place_slide_html 会被拒绝。若用户要求修改提纲,可再次调用本工具提交新版本(version+1)。",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        summary: z.string().describe("整套演示的一句话概要"),
        audience: z.string().optional(),
        goal: z.string().optional(),
        items: z.array(outlineItemShape).min(1).describe("每页一个条目,按演示顺序"),
      },
    },
    async ({ expected_revision, summary, audience, goal, items }): Promise<ToolResult> => {
      const current = await loadDeck();
      if (!current.ok) return fromWorkspaceError(current);
      const outline: SlidesOutline = {
        version: (current.value.outline?.version ?? 0) + 1,
        summary,
        audience,
        goal,
        items,
      };
      const draft = await writeSlidesOutlineDraft({ ...ctx, outline });
      if (!draft.ok) return fromWorkspaceError(draft);
      // 状态推进为 outline-proposed(UI 据此弹出确认面板);正式 outline 仍等批准时落 manifest。
      const updated = await updateDeckManifest({
        ...ctx,
        expectedRevision: expected_revision,
        mutate: (m) => {
          m.status = "outline-proposed";
          return m;
        },
      });
      if (!updated.ok) return fromWorkspaceError(updated);
      log.info(`[slides] outline proposed deck=${state.documentId} items=${items.length}`);
      return jsonResult({
        ok: true,
        revision: updated.value.revision,
        outlineVersion: outline.version,
        message: "提纲草案已提交,等待用户在界面上批准后才能写入正式页面。",
      });
    },
  );

  mcp.registerTool(
    "place_slide_html",
    {
      description:
        "写入(创建或整页替换)一个 slot 的 HTML。前置条件:提纲已被用户批准。" +
        "HTML 必须是 1280×720 固定画布的自包含文档(禁远程 JS,资源用 deck 相对路径或 data URI," +
        "关键元素带 data-cortex-id)。",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slot_id: z.string().describe("目标 slot id(get_deck_state 可得)"),
        html: z.string().min(1),
      },
    },
    async ({ expected_revision, slot_id, html }): Promise<ToolResult> => {
      const current = await loadDeck();
      if (!current.ok) return fromWorkspaceError(current);
      if (!HTML_WRITE_ALLOWED_STATUS.has(current.value.status)) {
        return errorResult(
          "outline_not_approved",
          "提纲尚未获用户批准,不能写入正式页面。请先 propose_outline 并等待用户在界面上批准。",
        );
      }
      const result = await writeSlideHtml({
        ...ctx,
        slotId: slot_id,
        html,
        expectedRevision: expected_revision,
      });
      if (!result.ok) return fromWorkspaceError(result);
      const slot = result.value.slides.find((s) => s.id === slot_id);
      return jsonResult({ ok: true, revision: result.value.revision, slot });
    },
  );

  mcp.registerTool(
    "read_slide_html",
    {
      description: "读取指定 slot 当前的 HTML 内容。",
      inputSchema: { slot_id: z.string() },
    },
    async ({ slot_id }): Promise<ToolResult> => {
      const result = await readSlideHtml({ ...ctx, slotId: slot_id });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, html: result.value });
    },
  );

  mcp.registerTool(
    "replace_slide_text",
    {
      description:
        "在指定 slot 的 HTML 里做一次精确文字替换。find 必须在页面中恰好出现一次," +
        "否则返回错误(避免误伤);大改请用 place_slide_html 整页替换。",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slot_id: z.string(),
        find: z.string().min(1),
        replace: z.string(),
      },
    },
    async ({ expected_revision, slot_id, find, replace }): Promise<ToolResult> => {
      const current = await readSlideHtml({ ...ctx, slotId: slot_id });
      if (!current.ok) return fromWorkspaceError(current);
      const occurrences = current.value.split(find).length - 1;
      if (occurrences === 0) return errorResult("not_found", "find 文本未在页面中出现");
      if (occurrences > 1) {
        return errorResult("invalid_payload", `find 文本出现 ${occurrences} 次,必须唯一;请提供更长的上下文`);
      }
      const result = await writeSlideHtml({
        ...ctx,
        slotId: slot_id,
        html: current.value.replace(find, replace),
        expectedRevision: expected_revision,
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, revision: result.value.revision });
    },
  );

  mcp.registerTool(
    "move_slide",
    {
      description: "把指定 slot 移动到目标位置(to_index,0 起)。其余页面相对顺序不变。",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slot_id: z.string(),
        to_index: z.number().int().min(0),
      },
    },
    async ({ expected_revision, slot_id, to_index }): Promise<ToolResult> => {
      const result = await updateDeckManifest({
        ...ctx,
        expectedRevision: expected_revision,
        mutate: (m) => {
          const ordered = [...m.slides].sort((a, b) => a.order - b.order);
          const from = ordered.findIndex((s) => s.id === slot_id);
          if (from === -1) throw new Error(`slot 不存在: ${slot_id}`);
          const [slot] = ordered.splice(from, 1);
          ordered.splice(Math.min(to_index, ordered.length), 0, slot!);
          ordered.forEach((s, i) => {
            s.order = i;
          });
          m.slides = ordered;
          return m;
        },
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({
        ok: true,
        revision: result.value.revision,
        order: [...result.value.slides].sort((a, b) => a.order - b.order).map((s) => s.id),
      });
    },
  );

  mcp.registerTool(
    "insert_slide",
    {
      description: "插入一个新的空 slot(生成稳定 id)。after_slot_id 缺省时追加到末尾。",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        title: z.string().optional(),
        after_slot_id: z.string().optional(),
        purpose: z.string().optional(),
      },
    },
    async ({ expected_revision, title, after_slot_id, purpose }): Promise<ToolResult> => {
      const { nextSlidesSlotId } = await import("@cortex-work/core/design/slides/slides-types");
      const { slidesSlideHtmlPath } = await import("@cortex-work/core/design/slides/slides-paths");
      let newSlotId = "";
      const result = await updateDeckManifest({
        ...ctx,
        expectedRevision: expected_revision,
        mutate: (m) => {
          newSlotId = nextSlidesSlotId(m.slides.map((s) => s.id));
          const ordered = [...m.slides].sort((a, b) => a.order - b.order);
          const anchor = after_slot_id ? ordered.findIndex((s) => s.id === after_slot_id) : ordered.length - 1;
          ordered.splice((anchor === -1 ? ordered.length - 1 : anchor) + 1, 0, {
            id: newSlotId,
            order: 0,
            title: title?.trim() || "新页面",
            purpose,
            htmlPath: slidesSlideHtmlPath(state.documentId, newSlotId),
            revision: 0,
            status: "empty",
            updatedAt: new Date().toISOString(),
          });
          ordered.forEach((s, i) => {
            s.order = i;
          });
          m.slides = ordered;
          return m;
        },
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, revision: result.value.revision, slotId: newSlotId });
    },
  );

  mcp.registerTool(
    "delete_slide",
    {
      description: "删除一个 slot(软删:文件移入 deck 内回收区,可由用户恢复)。",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slot_id: z.string(),
      },
    },
    async ({ expected_revision, slot_id }): Promise<ToolResult> => {
      const result = await deleteSlide({ ...ctx, slotId: slot_id, expectedRevision: expected_revision });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, revision: result.value.revision });
    },
  );

  mcp.registerTool(
    "upload_asset",
    {
      description:
        "把图片资产写入 deck 的 assets/ 目录(base64;png/jpg/jpeg/gif/webp/svg,≤8MB)。" +
        "返回工作区相对路径;slide HTML 中请用相对本页的路径(../assets/...)引用。",
      inputSchema: {
        file_name: z.string().describe("目标文件名(含扩展名),如 hero.png"),
        base64: z.string().min(1),
        kind: z.enum(["source", "generated"]).optional().describe("缺省 generated"),
      },
    },
    async ({ file_name, base64, kind }): Promise<ToolResult> => {
      const result = await writeDeckAsset({
        ...ctx,
        kind: kind ?? "generated",
        fileName: file_name,
        base64,
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, path: result.value });
    },
  );
}
