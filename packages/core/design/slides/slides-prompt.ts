/**
 * Slides 回合的用户 prompt 构造(纯函数)。
 *
 * 为什么 slides 不能复用 design 的 prompt 路由:自由画布的 `sendDesignPrompt` 会过
 * multi-page 闸门,把一句话展开成 Kun 的多页流水线(设计规格 → 设计系统与令牌 →
 * 品牌标识 → 并行多页),产物是 `.cortex-design/<doc>/` 下的自由画布 HTML ——
 * 与 deck.json / slot HTML 完全无关,页面也不会出现在缩略图栏(用户实测踩到)。
 * slides 走自己的合同:主题 → 提纲(等用户批准)→ 逐页 place_slide_html。
 *
 * 这里只拼「回合指令」,不含任何平台/文件系统假设;真正的落盘全在 cortex-slides 工具里。
 */

/** deck 状态 → 该回合该做什么(与 manifest.status 对齐)。 */
export type SlidesTurnStage = 'draft' | 'outline-proposed' | 'outline-approved' | 'generating' | 'ready' | 'error'

/** 用户在舞台上选中的元素(编辑桥上报;id 已由桥就地补打并落盘)。 */
export type SlidesSelectionContext = {
  /** 选中元素所在页的 slot id。 */
  slotId: string
  /** 页序号(1 起,供 Agent 与用户口径对齐);未知可省略。 */
  slideIndex?: number
  items: Array<{
    /** 元素的 data-cortex-id(已存在于该页 HTML 文件中)。 */
    id: string
    tag: string
    /** 文本摘要(可能截断;空串表示图形类元素)。 */
    text?: string
  }>
}

export type BuildSlidesTurnPromptOptions = {
  /** 用户原话。 */
  text: string
  /** 当前 deck 状态;缺省按 draft 处理。 */
  stage?: SlidesTurnStage
  /** 已应用的模板/主题名(有则提示 Agent 沿用,不要自己另起一套配色)。 */
  themeName?: string
  /** 舞台选区:用户点选了具体元素再发话,本轮应以这些元素为修订对象。 */
  selection?: SlidesSelectionContext
}

const CONTRACT = [
  'You are working in the Cortex "Slides" workspace. Read and write this deck only through the cortex-slides tools:',
  '- Start with get_deck_state to fetch the current theme, outline, slide list and revision (every write tool requires expected_revision).',
  '- Every slide must be a self-contained HTML document on a fixed 1280×720 (16:9) canvas: no remote JavaScript;',
  '  reference assets via deck-relative paths or data URIs; tag key elements with data-cortex-id.',
  '- For data charts to stay editable in the PPTX export, embed',
  '  <script type="application/json" data-cortex-chart-spec> inside the chart container, using version=1',
  '  bar/line/pie with explicit categories + series data. Never make the exporter reverse-engineer a canvas.',
  '- When the user explicitly starts the AI workflow, call create_pipeline_run first, then delegate the fixed',
  '  roles via delegate_slides_role. Roles only submit structured results; when done, call get_pipeline_run and',
  '  wait for user approval. The reviewer reports without fixing by default; notes-writer runs only after review.',
  '- Never modify the deck directory with generic file tools (Write/Edit), and never produce free-canvas pages',
  '  or design-system documents.',
  '- Animations are declarative annotations — do NOT write entrance/transition CSS inside slide HTML',
  '  (decorative looping animations are the only exception). Use set_deck_animation_style for the global style',
  '  (none/subtle/lively) and set_slide_animation per slide to declare its transition',
  '  (none/fade/push-horizontal/push-vertical/zoom/page-flip/cube-rotate) and element entrances',
  '  (entrances reference data-cortex-id; presets: fade-in/fade-up/slide-in-left/slide-in-right/',
  '  zoom-in/reveal-clip; same step enters together, step 0 plays automatically on slide entry,',
  '  step >= 1 advances on click). Slides without explicit choreography auto-enter per the global style,',
  '  so only slides that need emphasized pacing deserve per-element choreography.'
].join('\n')

const STAGE_INSTRUCTION: Record<SlidesTurnStage, string> = {
  draft: [
    'Goal for this turn: settle the theme first, then submit an outline draft for user confirmation.',
    '1) If the user did not specify a style, pick a suitable template via list_templates + apply_template (or customize with set_theme);',
    '2) Then call propose_outline to submit the outline (one item per slide: title / purpose / key points);',
    '3) The outline requires user approval in the UI — do not call place_slide_html before that (it will be rejected).',
    'After submitting the outline, briefly explain your thinking. Do not start writing slides on your own.'
  ].join('\n'),
  'outline-proposed': [
    'The outline draft has been submitted and is awaiting user confirmation. If the user asks for changes,',
    'call propose_outline again with a new version. Do not call place_slide_html before approval.'
  ].join('\n'),
  'outline-approved': [
    'The outline is approved. Following the slot order from get_deck_state, call place_slide_html for every',
    'slot whose status is empty (respect the deck theme and that slot\'s outline points).',
    'Once all slides are done, you may set the animation style with set_deck_animation_style and choreograph',
    'transitions/entrances for key slides with set_slide_animation. Report briefly after finishing each slide.'
  ].join('\n'),
  generating: [
    'Some slides are already generated. Continue per the user\'s request: touch only the relevant slots',
    '(place_slide_html / replace_slide_text). Do not rewrite finished slides the user did not mention.'
  ].join('\n'),
  ready: [
    'The deck is ready. Revise the requested slides per the user\'s instructions (replace_slide_text for precise',
    'text replacements; place_slide_html for full-slide rewrites). Use check_slide to verify when needed.'
  ].join('\n'),
  error: [
    'Some slides are in a failed state. Inspect with get_deck_state first, then re-run place_slide_html for the',
    'failed slots only. Do not touch slides that already succeeded.'
  ].join('\n')
}

// 选区上下文 → prompt 片段:逐元素列 id/标签/文本摘要,并限定本轮改动范围。
function selectionSection(selection: SlidesSelectionContext): string {
  const where = selection.slideIndex
    ? `slide ${selection.slideIndex} (slot: ${selection.slotId})`
    : `slot: ${selection.slotId}`
  const lines = selection.items.map((item) => {
    const text = item.text?.trim()
    return `- <${item.tag.toLowerCase()} data-cortex-id="${item.id}">${text ? `: "${text}"` : ' (graphic/decorative element, no text)'}`
  })
  return [
    `The user selected the following elements on ${where}. Adjust only these this turn (unless the user explicitly asks to change something else):`,
    ...lines,
    'Inspect the slide with read_slide_html first, then use replace_slide_text for precise text replacements;',
    'if a structural/style change requires place_slide_html, keep all unselected content intact',
    '(including these data-cortex-id attributes).'
  ].join('\n')
}

/**
 * 拼装一次 slides 回合的完整 prompt:合同 + 阶段指令 + 主题提示 + 选区上下文 + 用户原话。
 * 顺序固定(静态前缀在前、变量段在尾),便于命中供应商的 prompt 缓存。
 */
export function buildSlidesTurnPrompt(options: BuildSlidesTurnPromptOptions): string {
  const stage = options.stage ?? 'draft'
  const parts = [CONTRACT, STAGE_INSTRUCTION[stage]]
  if (options.themeName) {
    parts.push(
      `Current theme: "${options.themeName}" — keep its palette and visual language; do not invent a new one.`
    )
  }
  if (options.selection && options.selection.items.length > 0) {
    parts.push(selectionSection(options.selection))
  }
  // 用户原话原样透传(不翻译),仍固定在末尾以命中 prompt 缓存。
  parts.push(`User request:\n${options.text.trim()}`)
  return parts.join('\n\n')
}
