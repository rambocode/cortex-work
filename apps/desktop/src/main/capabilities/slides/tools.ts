// cortex-slides MCP 工具集(bento 化)。所有工具:
//   - 只经 bento-workspace 读写 deck(路径校验/原子写/revision 乐观锁全部继承);
//   - 主写工具 set_deck_doc 整份替换 BentoDoc(zod 结构校验 + expected_revision);
//   - 提纲批准 gate:stage 为 draft/outline-proposed 时拒绝多页全篇写入
//     (outline_not_approved),强制「先确认提纲再生成全篇」的产品流程;
//   - 结果一律 JSON 文本(ok/code/message + 数据),Agent 可直接机读。
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { slidesOutlineSchema } from "@cortex-work/core/design/slides/slides-schema";
import { createLogger } from "../../log";
import type { SlidesSessionState } from "./session";
import {
  appendSlidesSource,
  readBentoDeck,
  readSlidesSources,
  updateBentoDeckMeta,
  writeBentoDoc,
  writeBentoSlides,
  type BentoDeckStage,
} from "./bento-workspace";

const log = createLogger("slides");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, message }) }], isError: true };
}

// 单个 base64 资产上限(约 3MB 原始字节;更大的图应引导外部压缩后再入)。
export const MAX_ASSET_BASE64_CHARS = 4 * 1024 * 1024;

const outlineItemShape = z.object({
  id: z.string().min(1).describe("Stable outline item id, e.g. 'o1'"),
  title: z.string().min(1),
  purpose: z.string().describe("This slide's role in the narrative"),
  keyPoints: z.array(z.string()),
  visualIntent: z.string().optional().describe("Visual intent (layout/chart/table/morph direction)"),
});

const deckDocInputShape = z.union([
  z.record(z.string(), z.unknown()),
  z.string().min(2),
]);

const slidesInputShape = z.union([
  z.array(z.unknown()),
  z.string().min(2),
]);

/** 与 deck doc 同样的容错:部分 provider 会把深层嵌套的工具参数整体字符串化。 */
function normalizeSlidesInput(slides: unknown[] | string): unknown[] | null {
  if (Array.isArray(slides)) return slides;
  try {
    const parsed = JSON.parse(slides) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeDeckDocInput(doc: Record<string, unknown> | string): Record<string, unknown> | null {
  if (typeof doc !== "string") return doc;
  try {
    const parsed = JSON.parse(doc) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

// stage → Agent 下一步提示(与 slides-prompt 的阶段指令口径一致)。
function stageHint(stage: BentoDeckStage): string {
  switch (stage) {
    case "draft":
      return "The deck is a draft: submit an outline with propose_outline and wait for user approval before generating the full deck.";
    case "outline-proposed":
      return "The outline is submitted and awaiting user approval in the UI; full-deck set_deck_doc is rejected before approval.";
    case "outline-approved":
      return "The outline is approved: produce the complete document (all slides) in one set_deck_doc call.";
    case "ready":
      return "The deck is ready: fetch with get_deck_state, then edit ONLY the affected slides with set_slides (send just those slides, not the whole deck). Use set_deck_doc only when adding, deleting or reordering slides.";
  }
}

export function registerSlidesTools(mcp: McpServer, state: SlidesSessionState): void {
  const ctx = { workspaceRoot: state.workspaceRoot, deckId: state.documentId };

  mcp.registerTool(
    "get_deck_state",
    {
      description:
        "Read the deck's current Bento document (format bento/slides), pending outline draft, stage and revision. " +
        "set_deck_doc requires the revision returned here as expected_revision.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const result = await readBentoDeck(ctx);
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      const { doc, json, revision, stage, outline } = result.value;
      return jsonResult({
        ok: true,
        revision,
        stage,
        outline,
        // doc 优先给解析后的对象;上游新格式解析失败时退回原文,Agent 仍可读改。
        doc: doc ?? (json ? json : null),
        hint: stageHint(stage),
      });
    },
  );

  mcp.registerTool(
    "propose_outline",
    {
      description:
        "Submit an outline draft (one item per slide) for user approval in the UI. " +
        "Re-submit a new version if the user asks for changes. Full-deck generation stays locked until approval.",
      inputSchema: {
        version: z.number().int().min(1).describe("Outline version, bump on re-submission"),
        summary: z.string().describe("One-paragraph summary of the deck narrative"),
        audience: z.string().optional(),
        goal: z.string().optional(),
        items: z.array(outlineItemShape).min(1),
      },
    },
    async (input): Promise<ToolResult> => {
      const parsed = slidesOutlineSchema.safeParse(input);
      if (!parsed.success) return errorResult("invalid_outline", parsed.error.issues[0]?.message ?? "invalid outline");
      const result = await updateBentoDeckMeta({
        ...ctx,
        patch: { stage: "outline-proposed", outline: parsed.data },
      });
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      log.info(`[mcp] propose_outline deck=${ctx.deckId} items=${parsed.data.items.length}`);
      return jsonResult({
        ok: true,
        stage: result.value.stage,
        hint: "Outline submitted. Tell the user it is awaiting their approval in the outline panel; do not generate slides yet.",
      });
    },
  );

  mcp.registerTool(
    "set_deck_doc",
    {
      description:
        "Replace the deck's COMPLETE Bento document (format bento/slides). Pass every slide — this is a full overwrite, " +
        "not a merge; preserve untouched content verbatim from get_deck_state. Requires expected_revision. " +
        "While the outline is not approved, only single-slide skeleton writes are allowed (multi-slide docs are rejected).",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        doc: deckDocInputShape.describe(
          "The full BentoDoc JSON object (format/title/size/theme/slides…). " +
          "A JSON-encoded object string is also accepted for providers that stringify deeply nested tool arguments.",
        ),
      },
    },
    async ({ expected_revision, doc }): Promise<ToolResult> => {
      const normalizedDoc = normalizeDeckDocInput(doc);
      if (!normalizedDoc) {
        return errorResult("invalid_doc", "doc 必须是 BentoDoc 对象或可解析为对象的 JSON 字符串");
      }
      const current = await readBentoDeck(ctx);
      if (!current.ok) return errorResult(current.error.code, current.error.message);
      const stage = current.value.stage;
      const slideCount = Array.isArray(normalizedDoc.slides)
        ? normalizedDoc.slides.length
        : 0;
      // 提纲 gate:批准前禁止多页全篇生成(允许单页骨架,如标题页微调)。
      if ((stage === "draft" || stage === "outline-proposed") && slideCount > 1) {
        return errorResult(
          "outline_not_approved",
          "The outline has not been approved yet. Call propose_outline and wait for the user to approve it in the UI before generating the full deck.",
        );
      }
      // 全篇生成成功即视为 ready(gate 完成使命);其余写入保持原 stage。
      const nextStage: BentoDeckStage | undefined = stage === "outline-approved" && slideCount > 1 ? "ready" : undefined;
      const result = await writeBentoDoc({
        ...ctx,
        doc: normalizedDoc,
        expectedRevision: expected_revision,
        stage: nextStage,
      });
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      log.info(`[mcp] set_deck_doc deck=${ctx.deckId} slides=${slideCount} rev=${result.value.revision}`);
      return jsonResult({ ok: true, revision: result.value.revision, stage: nextStage ?? stage });
    },
  );

  // 局部写入:改一页就只发这一页。整份 12 页 deck 的 JSON 约 12 万字符(~5.6 万 token),
  // 走 set_deck_doc 改一条折线颜色会慢到像卡死、且极易撞上模型输出上限被截断(用户实测)。
  mcp.registerTool(
    "set_slides",
    {
      description:
        "Replace one or more EXISTING slides by id, leaving every other slide untouched. " +
        "This is the DEFAULT way to edit a deck that already exists — send only the slides you changed, " +
        "never the whole document. Each item must be a COMPLETE slide object (id + background + transition + " +
        "elements + notes); it replaces that slide wholesale, it is not a field-level merge. " +
        "Requires expected_revision. Cannot add, delete or reorder slides — use set_deck_doc for that.",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slides: slidesInputShape.describe(
          "Array of complete slide objects, each with an existing slide id. " +
          "A JSON-encoded array string is also accepted for providers that stringify deeply nested tool arguments.",
        ),
      },
    },
    async ({ expected_revision, slides }): Promise<ToolResult> => {
      const normalized = normalizeSlidesInput(slides);
      if (!normalized) {
        return errorResult("invalid_doc", "slides 必须是 slide 对象数组,或可解析为该数组的 JSON 字符串");
      }
      const result = await writeBentoSlides({
        ...ctx,
        slides: normalized,
        expectedRevision: expected_revision,
      });
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      log.info(
        `[mcp] set_slides deck=${ctx.deckId} ids=${result.value.replacedIds.join(",")} rev=${result.value.revision}`,
      );
      return jsonResult({
        ok: true,
        revision: result.value.revision,
        replacedSlideIds: result.value.replacedIds,
      });
    },
  );

  mcp.registerTool(
    "add_asset",
    {
      description:
        "Store a binary asset (image etc.) into the deck's asset table and get back an 'asset:<key>' reference " +
        "for image/svg elements — use this instead of inlining large data URIs into set_deck_doc.",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        file_name: z.string().describe("File name with extension, e.g. hero.png (key is derived from it)"),
        mime_type: z.string().describe("MIME type, e.g. image/png"),
        base64: z.string().min(1).describe("Base64-encoded file content (no data: prefix)"),
      },
    },
    async ({ expected_revision, file_name, mime_type, base64 }): Promise<ToolResult> => {
      if (base64.length > MAX_ASSET_BASE64_CHARS) {
        return errorResult("too_large", `Asset exceeds ${MAX_ASSET_BASE64_CHARS} base64 chars; compress it first.`);
      }
      if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return errorResult("invalid_asset", "base64 content is not valid");
      const current = await readBentoDeck(ctx);
      if (!current.ok) return errorResult(current.error.code, current.error.message);
      if (!current.value.doc) return errorResult("invalid_doc", "Deck document is not readable; fix it via set_deck_doc first.");
      // key 由文件名净化而来,冲突时追加序号(资产表键需稳定可引用)。
      const base = file_name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
      const assets = { ...(current.value.doc.assets ?? {}) };
      let key = base;
      for (let i = 2; key in assets; i += 1) key = `${base}-${i}`;
      assets[key] = `data:${mime_type};base64,${base64.replace(/\s+/g, "")}`;
      const result = await writeBentoDoc({
        ...ctx,
        doc: { ...current.value.doc, assets },
        expectedRevision: expected_revision,
      });
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      return jsonResult({
        ok: true,
        revision: result.value.revision,
        asset: `asset:${key}`,
        hint: `Reference it as src/asset "asset:${key}" in image/svg elements.`,
      });
    },
  );

  // 研究来源登记（spec §15.3）。与 add_asset 的关键差别：**不动 deck 文档**，
  // 因此不需要 expected_revision——来源清单是 deck 外的独立 sidecar，
  // 与页面写入互不争用乐观锁（理由见 bento-workspace 的 appendSlidesSource 注释）。
  mcp.registerTool(
    "add_source",
    {
      description:
        "Record an external source you used while building this deck (from web_search / web_read / deep_research). " +
        "Sources are stored alongside the deck as production-time provenance — they are NOT rendered into slides, " +
        "so the presenter can verify where each figure or claim came from. " +
        "Call this whenever a slide states a fact, figure or quote taken from the web.",
      inputSchema: {
        url: z.string().min(1).max(2048).describe("Source URL"),
        title: z.string().min(1).max(300).describe("Source title"),
        used_for: z
          .string()
          .max(300)
          .optional()
          .describe("Which slide or claim this source supports, e.g. 'slide 3 market size'"),
        chunk_id: z
          .string()
          .max(128)
          .optional()
          .describe("Evidence chunk id, only available for deep_research results"),
      },
    },
    async ({ url, title, used_for, chunk_id }): Promise<ToolResult> => {
      const result = await appendSlidesSource({
        ...ctx,
        entry: {
          url,
          title,
          ...(used_for ? { usedFor: used_for } : {}),
          ...(chunk_id ? { chunkId: chunk_id } : {}),
          addedAt: new Date().toISOString(),
        },
      });
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      return jsonResult({ ok: true, total: result.value.total });
    },
  );

  // 读回全部来源：agent 收尾时可据此在备注里列出参考资料，
  // 也让「这一版 deck 引了哪些东西」有个可机读的答案。
  mcp.registerTool(
    "list_sources",
    {
      description:
        "List all external sources recorded for this deck via add_source (production-time provenance).",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const result = await readSlidesSources(ctx);
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      return jsonResult({ ok: true, sources: result.value.sources });
    },
  );
}
