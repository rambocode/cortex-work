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
  readSlideNotes,
  updateDeckManifest,
  writeDeckAsset,
  writeSlideHtml,
  writeSlideNotes,
  writeSlidesOutlineDraft,
  MAX_ASSET_BASE64_CHARS,
  type SlidesWorkspaceResult,
} from "./workspace";
import { checkSlides, screenshotSlideToSnapshot } from "./inspect";
import { registerSlidesPipelineTools } from "./pipeline/tools";
import { getSlidesTemplate, listSlidesTemplates, readTemplateReferenceHtml } from "./templates";

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
        ? "The deck is a draft: set the theme via set_theme first, then submit an outline with propose_outline and wait for user approval."
        : manifest.status === "outline-proposed"
          ? "The outline is submitted and awaiting user approval in the UI; slides cannot be written before approval."
          : manifest.status === "outline-approved" || manifest.status === "generating"
            ? "The outline is approved: write 1280×720 HTML slot by slot via place_slide_html."
            : "The deck is ready: keep revising individual slides or respond to the user's check/export requests.",
  };
}

// 主题输入 schema(与 core SlidesTheme 对齐;zod v4 raw shape 交给 registerTool)。
const themeShape = {
  name: z.string().min(1).describe("Theme name"),
  mood: z.array(z.string()).describe("Mood keywords, e.g. ['clean','modern']"),
  palette: z
    .object({
      background: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      foreground: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      primary: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      secondary: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
      accent: z.string().regex(/^#[0-9a-fA-F]{3,6}$/),
    })
    .describe("Hex color palette"),
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
  id: z.string().min(1).describe("Stable outline item id, e.g. 'o1'"),
  title: z.string().min(1),
  purpose: z.string().describe("This slide's role in the narrative"),
  keyPoints: z.array(z.string()),
  visualIntent: z.string().optional().describe("Visual intent (layout/chart/illustration direction)"),
});

// 提纲批准 gate:仅这些状态允许写正式 slide HTML。
const HTML_WRITE_ALLOWED_STATUS = new Set(["outline-approved", "generating", "ready", "error"]);

// 动画枚举(与 core slides-types 的联合类型对齐;schema 层还有 .catch 容错)。
const animationStyleEnum = z.enum(["none", "subtle", "lively"]);
const entrancePresetEnum = z.enum([
  "fade-in",
  "fade-up",
  "slide-in-left",
  "slide-in-right",
  "zoom-in",
  "reveal-clip",
]);
const transitionEnum = z.enum([
  "none",
  "fade",
  "push-horizontal",
  "push-vertical",
  "zoom",
  "page-flip",
  "cube-rotate",
]);

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
        "Read the deck's full state: title, theme, outline, slide list (slot id/order/status) and revision. " +
        "Every write tool requires the revision returned here as expected_revision.",
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
      description: "Set the deck's structured theme (palette/fonts/density/mood). Requires expected_revision (optimistic lock).",
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
        "Submit an outline draft for user confirmation. The draft is written to drafts/outline.json and the deck status becomes outline-proposed; " +
        "place_slide_html is rejected until the user approves. If the user asks for changes, call this tool again to submit a new version (version+1).",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        summary: z.string().describe("One-sentence summary of the whole deck"),
        audience: z.string().optional(),
        goal: z.string().optional(),
        items: z.array(outlineItemShape).min(1).describe("One item per slide, in presentation order"),
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
        message: "Outline draft submitted. Slides can be written only after the user approves it in the UI.",
      });
    },
  );

  mcp.registerTool(
    "place_slide_html",
    {
      description:
        "Write (create or fully replace) one slot's HTML. Precondition: the outline has been approved by the user. " +
        "The HTML must be a self-contained document on a fixed 1280×720 canvas (no remote JS; assets via " +
        "deck-relative paths or data URIs; key elements tagged with data-cortex-id).",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slot_id: z.string().describe("Target slot id (from get_deck_state)"),
        html: z.string().min(1),
      },
    },
    async ({ expected_revision, slot_id, html }): Promise<ToolResult> => {
      const current = await loadDeck();
      if (!current.ok) return fromWorkspaceError(current);
      if (!HTML_WRITE_ALLOWED_STATUS.has(current.value.status)) {
        return errorResult(
          "outline_not_approved",
          "The outline is not yet approved by the user, so slides cannot be written. Call propose_outline first and wait for approval in the UI.",
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
      description: "Read the current HTML content of the given slot.",
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
        "Perform one exact text replacement in the slot's HTML. find must occur exactly once in the slide, " +
        "otherwise an error is returned (to avoid collateral edits); for large changes use place_slide_html.",
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
      if (occurrences === 0) return errorResult("not_found", "The find text does not occur in the slide");
      if (occurrences > 1) {
        return errorResult("invalid_payload", `The find text occurs ${occurrences} times; it must be unique — provide longer context`);
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
      description: "Move the given slot to the target position (to_index, 0-based). Other slides keep their relative order.",
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
      description: "Insert a new empty slot (with a stable generated id). Appends to the end when after_slot_id is omitted.",
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
      description: "Delete a slot (soft delete: files move to the deck's trash area and can be restored by the user).",
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
    "list_templates",
    {
      description:
        "List built-in slide templates (id/title/description/light-dark/tags). When the user has no style preference, " +
        "recommend one based on topic and audience, then apply it with apply_template. Templates are data, not prompts: " +
        "applying one writes the theme and style guide into the deck.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const templates = await listSlidesTemplates();
      return jsonResult({
        ok: true,
        templates: templates.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          descriptionZh: t.descriptionZh,
          category: t.category,
          tags: t.tags,
        })),
      });
    },
  );

  mcp.registerTool(
    "apply_template",
    {
      description:
        "Apply a built-in template to the deck: writes its structured theme (palette/density) and style guide. " +
        "Returns the full styleGuide and a reference slide HTML (if any) — follow their visual language strictly when generating slides.",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        template_id: z.string().describe("An id returned by list_templates"),
        include_reference: z.boolean().optional().describe("Whether to return the reference slide HTML (default true)"),
      },
    },
    async ({ expected_revision, template_id, include_reference }): Promise<ToolResult> => {
      const template = await getSlidesTemplate(template_id);
      if (!template) return errorResult("not_found", `模板不存在: ${template_id}`);
      const updated = await updateDeckManifest({
        ...ctx,
        expectedRevision: expected_revision,
        mutate: (m) => {
          m.theme = template.theme;
          return m;
        },
      });
      if (!updated.ok) return fromWorkspaceError(updated);
      // 参考页 HTML 可能较大(几十 KB),默认给但允许关掉。
      let referenceHtml: string | null = null;
      if (include_reference !== false && template.referenceSlides[0]) {
        referenceHtml = await readTemplateReferenceHtml(template.id, template.referenceSlides[0].file);
      }
      log.info(`[slides] template applied deck=${state.documentId} template=${template.id}`);
      return jsonResult({
        ok: true,
        revision: updated.value.revision,
        template: { id: template.id, title: template.title, category: template.category },
        theme: template.theme,
        styleGuide: template.styleGuide,
        referenceHtml,
      });
    },
  );

  mcp.registerTool(
    "generate_speaker_notes",
    {
      description:
        "Write speaker notes for a slide (Markdown, stored at notes/<slot>.md). Notes are included in PPTX and HTML presenter exports; " +
        "PDF/PNG exports do not contain notes.",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slot_id: z.string(),
        markdown: z.string().min(1).describe("The slide's script / talking points"),
      },
    },
    async ({ expected_revision, slot_id, markdown }): Promise<ToolResult> => {
      const result = await writeSlideNotes({
        ...ctx,
        slotId: slot_id,
        markdown,
        expectedRevision: expected_revision,
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, revision: result.value.revision });
    },
  );

  mcp.registerTool(
    "read_speaker_notes",
    {
      description: "Read the slide's speaker notes (empty string when absent).",
      inputSchema: { slot_id: z.string() },
    },
    async ({ slot_id }): Promise<ToolResult> => {
      const result = await readSlideNotes({ ...ctx, slotId: slot_id });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, markdown: result.value });
    },
  );

  mcp.registerTool(
    "set_deck_animation_style",
    {
      description:
        "Set the deck-wide animation style: none (static) / subtle / lively. " +
        "The style decides the default transition and entrance pacing during playback; slides without explicit choreography auto-enter per the style.",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        style: animationStyleEnum,
      },
    },
    async ({ expected_revision, style }): Promise<ToolResult> => {
      const result = await updateDeckManifest({
        ...ctx,
        expectedRevision: expected_revision,
        mutate: (m) => {
          m.animationStyle = style;
          return m;
        },
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, revision: result.value.revision });
    },
  );

  mcp.registerTool(
    "set_slide_animation",
    {
      description:
        "Declare a slide's animation choreography: the transition into the slide and the element entrance sequence. " +
        "entrances reference in-slide data-cortex-id elements via element_id; elements sharing a step enter together, " +
        "step 0 plays automatically on slide entry, step >= 1 advances on the presenter's click (PowerPoint-style builds). " +
        "Passing only transition keeps existing entrances, and vice versa. Animations apply only to playback / HTML export.",
      inputSchema: {
        expected_revision: z.number().int().min(0),
        slot_id: z.string(),
        transition: transitionEnum.optional(),
        entrances: z
          .array(
            z.object({
              element_id: z.string().min(1).describe("The element's data-cortex-id inside the slide"),
              preset: entrancePresetEnum,
              step: z.number().int().min(0),
              delay_ms: z.number().int().min(0).optional(),
              duration_ms: z.number().int().min(0).optional(),
            }),
          )
          .optional(),
      },
    },
    async ({ expected_revision, slot_id, transition, entrances }): Promise<ToolResult> => {
      const current = await loadDeck();
      if (!current.ok) return fromWorkspaceError(current);
      // slot 存在性前置校验:mutate 内抛错不会被乐观锁管线捕获,必须先拒。
      if (!current.value.slides.some((s) => s.id === slot_id)) {
        return errorResult("not_found", `slot 不存在: ${slot_id}`);
      }
      // element_id 只做软校验(HTML 可能后写):孤儿注解由播放器「找不到即忽略」容错。
      const result = await updateDeckManifest({
        ...ctx,
        expectedRevision: expected_revision,
        mutate: (m) => {
          const slot = m.slides.find((s) => s.id === slot_id);
          if (!slot) return null;
          const animation = { ...(slot.animation ?? {}) };
          if (transition !== undefined) animation.transition = transition;
          if (entrances !== undefined) {
            animation.entrances = entrances.map((e) => ({
              elementId: e.element_id,
              preset: e.preset,
              step: e.step,
              delayMs: e.delay_ms,
              durationMs: e.duration_ms,
            }));
          }
          slot.animation = animation;
          return m;
        },
      });
      if (!result.ok) return fromWorkspaceError(result);
      const slot = result.value.slides.find((s) => s.id === slot_id);
      return jsonResult({ ok: true, revision: result.value.revision, animation: slot?.animation });
    },
  );

  mcp.registerTool(
    "check_slide",
    {
      description:
        "Run static + render checks for one slide (or the whole deck): overflow/clipping, minimum font size, broken images, " +
        "remote resources, dangerous scripts, text density, empty slides, etc. Returns structured findings (fix blocking ones). " +
        "Also refreshes the affected slide thumbnails.",
      inputSchema: {
        slot_id: z.string().optional().describe("Checks the whole deck when omitted"),
      },
    },
    async ({ slot_id }): Promise<ToolResult> => {
      const result = await checkSlides({
        ...ctx,
        slotIds: slot_id ? [slot_id] : undefined,
      });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, findings: result.value });
    },
  );

  mcp.registerTool(
    "screenshot_slide",
    {
      description: "Re-render the slide and refresh its thumbnail (fixed 1280×720 viewport, 10s timeout).",
      inputSchema: { slot_id: z.string() },
    },
    async ({ slot_id }): Promise<ToolResult> => {
      const result = await screenshotSlideToSnapshot({ ...ctx, slotId: slot_id });
      if (!result.ok) return fromWorkspaceError(result);
      return jsonResult({ ok: true, snapshotPath: result.value.snapshotPath });
    },
  );

  mcp.registerTool(
    "upload_asset",
    {
      description:
        "Write an image asset into the deck's assets/ directory (base64; png/jpg/jpeg/gif/webp/svg, <=8MB). " +
        "Returns a workspace-relative path; reference it from slide HTML via a slide-relative path (../assets/...).",
      inputSchema: {
        file_name: z.string().describe("Target file name with extension, e.g. hero.png"),
        base64: z.string().min(1).max(MAX_ASSET_BASE64_CHARS),
        kind: z.enum(["source", "generated"]).optional().describe("Defaults to generated"),
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

  registerSlidesPipelineTools(mcp, state);
}
