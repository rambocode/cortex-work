// cortex-slides MCP 工具集(bento 化)。所有工具:
//   - 只经 bento-workspace 读写 deck(路径校验/原子写/revision 乐观锁全部继承);
//   - set_deck_doc 只做结构变更;初始生成与内容编辑统一走分批 set_slides;
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
  pendingBentoGenerationPages,
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
/** 强制小批写入,不能只靠模型遵循工具描述。 */
export const MAX_SLIDES_PER_BATCH = 3;

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

type AgentAssetManifestItem = {
  key: string;
  mimeType?: string;
  byteSize: number;
};

function assetManifestItem(key: string, value: unknown): AgentAssetManifestItem {
  if (typeof value !== "string") return { key, byteSize: 0 };
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) return { key, byteSize: Buffer.byteLength(value, "utf8") };
  const encoded = match[2]!.replace(/\s+/g, "");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return {
    key,
    mimeType: match[1],
    byteSize: Math.max(0, Math.floor((encoded.length * 3) / 4) - padding),
  };
}

/**
 * MCP 工具结果只传可编辑结构，不传 assets 里的 base64 二进制。
 *
 * 真实 deck 的两张 PNG 就可能占近 400 万字符；把它们塞进 tool_result 会在模型准备回答前
 * 直接撞穿上下文窗口。资产 key 仍经 assetManifest 暴露，页面里的 asset:<key> 引用不变。
 */
function deckStateForAgent(
  doc: Record<string, unknown>,
  requestedSlideIds: readonly string[],
): {
  doc: Record<string, unknown>;
  assetManifest: AgentAssetManifestItem[];
  totalSlideCount: number;
  returnedSlideIds: string[];
  missingSlideIds: string[];
  partial: boolean;
} {
  const { assets, ...withoutAssets } = doc;
  const allSlides = Array.isArray(doc.slides) ? doc.slides : [];
  const requested = new Set(requestedSlideIds);
  const slides = requested.size
    ? allSlides.filter(
        (slide) =>
          !!slide &&
          typeof slide === "object" &&
          requested.has(String((slide as { id?: unknown }).id ?? "")),
      )
    : allSlides;
  const returnedSlideIds = slides
    .map((slide) =>
      slide && typeof slide === "object" ? String((slide as { id?: unknown }).id ?? "") : "",
    )
    .filter(Boolean);
  const returned = new Set(returnedSlideIds);
  const assetRecord =
    assets && typeof assets === "object" && !Array.isArray(assets)
      ? (assets as Record<string, unknown>)
      : {};
  return {
    doc: { ...withoutAssets, slides },
    assetManifest: Object.entries(assetRecord).map(([key, value]) => assetManifestItem(key, value)),
    totalSlideCount: allSlides.length,
    returnedSlideIds,
    missingSlideIds: requestedSlideIds.filter((id) => !returned.has(id)),
    partial: requested.size > 0,
  };
}

// stage → Agent 下一步提示(与 slides-prompt 的阶段指令口径一致)。
function stageHint(stage: BentoDeckStage): string {
  switch (stage) {
    case "draft":
      return "The deck is a draft: submit an outline with propose_outline and wait for user approval before generating the full deck.";
    case "outline-proposed":
      return "The outline is submitted and awaiting user approval in the UI; full-deck set_deck_doc is rejected before approval.";
    case "outline-approved":
      return "The outline is approved and every page already exists as a pending placeholder. Replace those existing pages with set_slides, at most 3 per call, chaining nextExpectedRevision until remainingPages is empty. Do not call set_deck_doc.";
    case "ready":
      return "The deck is ready: fetch with get_deck_state, then edit ONLY the affected slides with set_slides — at most 3 slides per call, chaining nextExpectedRevision from each response into the next batch. Use set_deck_doc only when adding, deleting or reordering slides.";
  }
}

export function registerSlidesTools(mcp: McpServer, state: SlidesSessionState): void {
  const ctx = { workspaceRoot: state.workspaceRoot, deckId: state.documentId };

  mcp.registerTool(
    "get_deck_state",
    {
      description:
        "Read the deck's current Bento document (format bento/slides), pending outline draft, stage and revision. " +
        "For a page-scoped edit, pass the known slide id in slide_ids so only that page enters model context. " +
        "Embedded asset base64 is never returned; assetManifest lists its keys and metadata instead. " +
        "set_deck_doc requires the revision returned here as expected_revision and preserves existing assets when doc.assets is omitted.",
      inputSchema: {
        slide_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_SLIDES_PER_BATCH)
          .optional()
          .describe("Known slide ids to fetch for a page-scoped edit; omit only when the whole deck structure is needed"),
      },
    },
    async ({ slide_ids }): Promise<ToolResult> => {
      const result = await readBentoDeck(ctx);
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      const { doc, json, revision, stage, outline } = result.value;
      let rawDoc: Record<string, unknown> | null = doc as unknown as Record<string, unknown> | null;
      if (!rawDoc && json) {
        try {
          const parsed = JSON.parse(json) as unknown;
          rawDoc =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : null;
        } catch {
          rawDoc = null;
        }
      }
      const agentState = rawDoc ? deckStateForAgent(rawDoc, slide_ids ?? []) : null;
      return jsonResult({
        ok: true,
        revision,
        stage,
        outline,
        // 无论 schema 是否是上游新版本，都先按普通 JSON 解析并剥离二进制；解析失败不再把
        // 可能数 MB 的原文塞给模型，避免一次损坏文档拖垮整个会话。
        doc: agentState?.doc ?? null,
        assetManifest: agentState?.assetManifest ?? [],
        totalSlideCount: agentState?.totalSlideCount ?? 0,
        returnedSlideIds: agentState?.returnedSlideIds ?? [],
        missingSlideIds: agentState?.missingSlideIds ?? (slide_ids ?? []),
        partial: agentState?.partial ?? Boolean(slide_ids?.length),
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
        "Use only for structural add/delete/reorder operations. While the outline is not approved, only single-slide " +
        "skeleton writes are allowed; while approved placeholders are being generated, full overwrite is rejected.",
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
      // get_deck_state 刻意不回传 assets 的 base64。模型按完整结构写回时通常不会带 assets，
      // 这里由宿主补回磁盘上的权威资产表，避免结构性增删页顺手把所有图片删掉。
      const docForWrite =
        !Object.prototype.hasOwnProperty.call(normalizedDoc, "assets") &&
        current.value.doc?.assets
          ? { ...normalizedDoc, assets: current.value.doc.assets }
          : normalizedDoc;
      const stage = current.value.stage;
      const pendingPages = pendingBentoGenerationPages(current.value.doc);
      const slideCount = Array.isArray(docForWrite.slides)
        ? docForWrite.slides.length
        : 0;
      // 提纲 gate:批准前禁止多页全篇生成(允许单页骨架,如标题页微调)。
      if ((stage === "draft" || stage === "outline-proposed") && slideCount > 1) {
        return errorResult(
          "outline_not_approved",
          "The outline has not been approved yet. Call propose_outline and wait for the user to approve it in the UI before generating the full deck.",
        );
      }
      if (pendingPages.length > 0) {
        return errorResult(
          "streaming_required",
          `Initial generation is in progress on placeholder pages ${pendingPages.join(", ")}. Replace them with set_slides in batches of at most ${MAX_SLIDES_PER_BATCH}; do not overwrite the whole deck.`,
        );
      }
      // 全篇生成成功即视为 ready(gate 完成使命);其余写入保持原 stage。
      const nextStage: BentoDeckStage | undefined = stage === "outline-approved" && slideCount > 1 ? "ready" : undefined;
      const result = await writeBentoDoc({
        ...ctx,
        doc: docForWrite,
        expectedRevision: expected_revision,
        stage: nextStage,
      });
      if (!result.ok) return errorResult(result.error.code, result.error.message);
      log.info(`[mcp] set_deck_doc deck=${ctx.deckId} slides=${slideCount} rev=${result.value.revision}`);
      // slideCount / nextExpectedRevision 显式回传:UI 的工具芯片直接读它显示「全篇 13 页 · rev 72」,
      // 模型也不必再自己从 revision 推断下一批该带什么(推断错就是一次 revision_conflict)。
      return jsonResult({
        ok: true,
        revision: result.value.revision,
        nextExpectedRevision: result.value.revision,
        slideCount,
        stage: nextStage ?? stage,
      });
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
        "Send AT MOST 3 slides per call and call it repeatedly for larger revisions: the response returns " +
        "nextExpectedRevision, pass that as expected_revision for the next batch (no need to re-read the deck). " +
        "Small batches land reliably instead of being truncated mid-JSON, and the user sees the deck update " +
        "page by page. Requires expected_revision. Cannot add, delete or reorder slides — use set_deck_doc for that.",
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
      if (normalized.length > MAX_SLIDES_PER_BATCH) {
        return errorResult(
          "too_many_slides",
          `set_slides 每次最多写 ${MAX_SLIDES_PER_BATCH} 页;请拆分批次并把本次返回的 nextExpectedRevision 用于下一批`,
        );
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
      // replacedPages(1 基页码)给 UI 用 —— agent 只认 slide id,用户只认「第几页」;
      // nextExpectedRevision 让模型直接续写下一批,不必再跑一次 get_deck_state。
      return jsonResult({
        ok: true,
        revision: result.value.revision,
        nextExpectedRevision: result.value.revision,
        replacedSlideIds: result.value.replacedIds,
        replacedPages: result.value.replacedPages,
        stage: result.value.stage,
        remainingPages: result.value.remainingPages,
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
        activity: { kind: "asset", assetKey: key },
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
