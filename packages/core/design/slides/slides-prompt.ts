/**
 * Slides 回合的用户 prompt 构造(纯函数,bento 合同)。
 *
 * 为什么 slides 不能复用 design 的 prompt 路由:自由画布的 `sendDesignPrompt` 会过
 * multi-page 闸门,把一句话展开成多页流水线,产物与 deck.bento.html 完全无关(用户实测踩到)。
 * slides 走自己的合同:主题+提纲(等用户批准)→ 一次 set_deck_doc 产出整份 BentoDoc。
 *
 * 底层是 bento(nyblnet/bento)单文件演示格式:文档是一份声明式 JSON(format "bento/slides"),
 * AI 用 cortex-slides 工具整份读写;渲染/动画/图表由 bento 运行时兜底。
 * 这里只拼「回合指令」,不含任何平台/文件系统假设;真正的落盘全在 cortex-slides 工具里。
 */

import {
  formatSlidesSelectionForPrompt,
  type SlidesSelectionSnapshot
} from './slides-selection'
import {
  formatSlidesTextFilesForPrompt,
  type SlidesTextFile
} from './slides-text-files'

/** deck 阶段 → 该回合该做什么(与 deck.meta.json 的 stage 对齐)。 */
export type SlidesTurnStage = 'draft' | 'outline-proposed' | 'outline-approved' | 'ready'

export type BuildSlidesTurnPromptOptions = {
  /** 用户原话。 */
  text: string
  /** 当前 deck 阶段;缺省按 draft 处理。 */
  stage?: SlidesTurnStage
  /** 用户在 bento 编辑器里选中的元素;空/缺省时整段不拼。 */
  selection?: SlidesSelectionSnapshot | null
  /** 用户本轮提供的纯文本参考文件。 */
  files?: SlidesTextFile[]
}

// BentoDoc schema 摘要 + 素材→特性映射 + 转义红线。权威定义在 vendor/bento/src/model.ts;
// 结构性校验(set_deck_doc 的守门)在 core/design/slides/bento/bento-doc-schema.ts。
const CONTRACT = [
  'You are working in the Cortex "Slides" workspace. The deck is a Bento Slides document: one declarative',
  'JSON model (format "bento/slides") rendered by the bento runtime. Read and write it ONLY through the',
  'cortex-slides tools:',
  '- Start with get_deck_state to fetch the current document JSON and revision (both write tools require',
  '  expected_revision; on revision_conflict re-fetch and re-apply your change).',
  '- EDIT an existing deck with set_slides: send ONLY the slides you actually change, each as a complete',
  '  slide object keyed by its existing id. This is the default for every revision request. A full deck is',
  '  tens of thousands of tokens — re-emitting all of it to change one element is slow, and long enough to',
  '  be cut off mid-JSON so the write never lands. BATCH IT: at most 3 slides per set_slides call, then call',
  '  it again for the next batch until the revision is complete. Each successful call returns',
  '  nextExpectedRevision — pass THAT as expected_revision for the following batch (no need to re-run',
  '  get_deck_state). Small batches land reliably instead of being truncated, and the user watches the deck',
  '  update page by page instead of staring at nothing until the end.',
  '- Use set_deck_doc ONLY to create the deck initially, or to add / delete / reorder slides. It passes the',
  '  COMPLETE document (all slides), not a diff.',
  '- Either way: preserve untouched slides/elements verbatim from get_deck_state — never regenerate content',
  '  the user did not ask to change, and keep existing element ids stable (ids drive morph pairing and',
  '  user selections).',
  '',
  'Document shape (structural essentials; unknown/misspelled fields fail silently — use ONLY these):',
  '- Root: { format:"bento/slides", version:1, title, size:{width:1280,height:720},',
  '  theme:{background,color,accent,fontFamily,chartPalette?}, assets?:{key:dataURI},',
  '  slides:[Slide], present?:{slideNumber?,controls?,progress?} }',
  '- Slide: { id, background, transition:"none"|"fade"|"slide"|"zoom"|"morph", elements:[Element],',
  '  notes:"speaker notes markdown-free plain text", stateOf?:parentSlideId, name? }',
  '- Element (absolute canvas coords, px): common fields { id, x, y, w, h, rotation:0, opacity:1 },',
  '  then one of:',
  '  · text: { type:"text", html:"inline HTML, b/i/u/br/span only", fontSize, fontFamily, fontWeight,',
  '    color, align:"left"|"center"|"right", valign:"top"|"middle"|"bottom", lineHeight }',
  '  · shape: { type:"shape", shape:"rect"|"ellipse"|"triangle"|"arrow"|"line"|"path", fill, stroke,',
  '    strokeWidth, radius }',
  '  · image: { type:"image", src:"data: URI or asset:<key>", fit:"contain"|"cover"|"fill", radius }',
  '  · svg: { type:"svg", markup:"<svg…>" or asset:<key> }',
  '  · chart: { type:"chart", option:<pure-JSON ECharts option — template-string formatters only,',
  '    never functions> }',
  '  · table: { type:"table", columns:[{w:1}…], rows:[{cells:[{html}…]}…], header:true,',
  '    style:{headerBg,headerColor,borderColor,borderWidth,cellPadX,cellPadY,fontSize,color,radius} }',
  '  · media: { type:"media", kind:"video"|"audio", src }',
  '  Optional element extras: link:targetSlideId (click-to-jump while presenting),',
  '  fx:{enter:"fade-up"|…, order?, countUp?, ambient:"kenburns"?}, morphId? (pair morph across slides).',
  '',
  'Feature mapping — pick the bento feature that fits the material:',
  '- Numbers to compare / trends → chart (ECharts option; bar/line need pure numeric data).',
  '- Specs / feature matrices / pricing → table.',
  '- A concept evolving across slides → transition:"morph" with SAME element ids (or morphId) on both slides.',
  '- Drill-down / on-demand detail → a stateOf slide reached via an element link (hidden from linear flow).',
  '- Emphasized pacing → element fx.enter with order for staggered entrances; use sparingly.',
  '',
  'Composition rules: keep >=96px side margins on the 1280×720 canvas, one accent color, at most 2 font',
  'families, generous whitespace; write slide notes for the presenter. Escape "<" as \\u003c-safe inline',
  'HTML only inside text/table html fields; never emit "</script>" anywhere in the JSON.',
  'Store images with add_asset (returns asset:<key>) instead of inlining large data URIs into set_deck_doc.',
  'Never touch the deck directory with generic file tools (Write/Edit), and never produce free-canvas pages',
  'or design-system documents.'
].join('\n')

const STAGE_INSTRUCTION: Record<SlidesTurnStage, string> = {
  draft: [
    'Goal for this turn: settle theme direction and submit an outline draft for user confirmation.',
    '1) Decide the deck theme (background/color/accent/fontFamily) from the topic and audience;',
    '2) Call propose_outline with one item per slide (title / purpose / key points / visualIntent);',
    '3) The outline requires user approval in the UI — do NOT generate the full deck before approval',
    '   (full-deck set_deck_doc is rejected while the outline is pending).',
    'After submitting the outline, briefly explain your thinking. Do not start writing slides on your own.'
  ].join('\n'),
  'outline-proposed': [
    'The outline draft has been submitted and is awaiting user confirmation. If the user asks for changes,',
    'call propose_outline again with a new version. Do not generate the full deck before approval.'
  ].join('\n'),
  'outline-approved': [
    'The outline is approved. Produce the COMPLETE document in ONE set_deck_doc call: theme + every slide',
    'from the approved outline (title slide, content slides, closing), each with elements and speaker notes.',
    'Prefer charts/tables/morph per the feature mapping. Report briefly after the write succeeds.'
  ].join('\n'),
  ready: [
    'The deck exists. Apply the requested revision with set_slides, IN BATCHES:',
    '1) get_deck_state once, then state which slide ids the request affects;',
    '2) send back ONLY those slides — at most 3 per set_slides call (complete slide objects; everything the',
    '   user did not ask about kept byte-identical), using the revision from get_deck_state for the first',
    '   batch and each response\'s nextExpectedRevision for the next;',
    '3) repeat until every affected slide is written, then report what changed.',
    'Do NOT re-emit the whole deck, and do not try to do it in one giant call: that is slow, risks being cut',
    'off mid-JSON (the write then never lands), and leaves the user with no visible progress. Reach for',
    'set_deck_doc only if the change adds, deletes or reorders slides.'
  ].join('\n')
}

/**
 * 拼装一次 slides 回合的完整 prompt:合同 + 阶段指令 + 用户原话。
 * 顺序固定(静态前缀在前、变量段在尾),便于命中供应商的 prompt 缓存。
 */
export function buildSlidesTurnPrompt(options: BuildSlidesTurnPromptOptions): string {
  const stage = options.stage ?? 'draft'
  const parts = [CONTRACT, STAGE_INSTRUCTION[stage]]
  // 选区引用同属变量段,排在用户原话之前:静态前缀(CONTRACT + 阶段指令)保持逐字节
  // 不变,prompt 缓存照常命中;空选区时整段不拼,输出与无选区完全一致。
  const selection = formatSlidesSelectionForPrompt(options.selection)
  if (selection) parts.push(selection)
  const files = formatSlidesTextFilesForPrompt(options.files ?? [])
  if (files) parts.push(files)
  // 用户原话原样透传(不翻译),仍固定在末尾以命中 prompt 缓存。
  parts.push(`User request:\n${options.text.trim()}`)
  return parts.join('\n\n')
}
