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
  '你正在 Cortex 的「演示文稿」工作台里工作。请只用 cortex-slides 工具读写这份 deck:',
  '- 先 get_deck_state 取当前主题、提纲、页面列表与 revision(所有写工具都要带 expected_revision);',
  '- 页面必须是 1280×720(16:9)固定画布的自包含 HTML:不依赖远程 JavaScript,',
  '  资源用 deck 相对路径或 data URI,关键元素带 data-cortex-id;',
  '- 不要用 Write/Edit 等文件工具直接改 deck 目录,也不要生成自由画布页面或设计系统文档。'
].join('\n')

const STAGE_INSTRUCTION: Record<SlidesTurnStage, string> = {
  draft: [
    '本轮目标:先把主题定下来,再提交提纲草案等用户确认。',
    '1) 如果用户没指定风格,可用 list_templates 挑一套合适的并 apply_template(或用 set_theme 自定义);',
    '2) 然后调用 propose_outline 提交提纲(每页一条,含标题/目的/要点);',
    '3) 提纲需要用户在界面上批准 —— 在此之前不要调用 place_slide_html(会被拒绝)。',
    '提交提纲后简要说明思路即可,不要自行开始写页面。'
  ].join('\n'),
  'outline-proposed': [
    '提纲草案已提交,正在等用户确认。若用户要求调整,请再次 propose_outline 提交新版本;',
    '在用户批准前不要调用 place_slide_html。'
  ].join('\n'),
  'outline-approved': [
    '提纲已获批准。请按 get_deck_state 返回的 slot 顺序,为每个 status 为 empty 的 slot 调用',
    'place_slide_html 生成页面(遵循 deck 主题与该 slot 的提纲要点)。逐页完成后简要汇报。'
  ].join('\n'),
  generating: [
    '部分页面已生成。请按用户要求继续:只改动相关 slot(place_slide_html / replace_slide_text),',
    '不要重写已完成且用户没提到的页面。'
  ].join('\n'),
  ready: [
    'deck 已就绪。请按用户要求修订指定页面(replace_slide_text 做精确文字替换,',
    '大改用 place_slide_html 整页替换);必要时用 check_slide 复核。'
  ].join('\n'),
  error: [
    '部分页面处于失败状态。请先 get_deck_state 查看,再针对失败的 slot 重新 place_slide_html;',
    '不要动已经成功的页面。'
  ].join('\n')
}

// 选区上下文 → prompt 片段:逐元素列 id/标签/文本摘要,并限定本轮改动范围。
function selectionSection(selection: SlidesSelectionContext): string {
  const where = selection.slideIndex ? `第 ${selection.slideIndex} 页(slot: ${selection.slotId})` : `slot: ${selection.slotId}`
  const lines = selection.items.map((item) => {
    const text = item.text?.trim()
    return `- <${item.tag.toLowerCase()} data-cortex-id="${item.id}">${text ? `:「${text}」` : '(图形/装饰元素,无文本)'}`
  })
  return [
    `用户在 ${where} 选中了以下元素,本轮请只调整它们(除非用户明确要求动别处):`,
    ...lines,
    '先 read_slide_html 查看该页,再用 replace_slide_text 精准替换文字;结构/样式改动用',
    'place_slide_html 整页替换时也要保持未选中内容原样(含这些 data-cortex-id 属性)。'
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
    parts.push(`当前主题:「${options.themeName}」—— 请沿用它的配色与风格,不要另起一套。`)
  }
  if (options.selection && options.selection.items.length > 0) {
    parts.push(selectionSection(options.selection))
  }
  parts.push(`用户的要求:\n${options.text.trim()}`)
  return parts.join('\n\n')
}
