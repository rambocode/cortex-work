/**
 * Slides 模板域类型与纯解析函数。
 *
 * 模板是**数据**,不是写死在 prompt 里的字符串:每套模板一个目录,含
 *   TEMPLATE.md          ── frontmatter 元数据 + 人读说明(Best For / Avoid For …)
 *   template.json        ── 结构化主题(配色/字号/风格指南)+ 装饰花纹 + 参考页清单
 *   references/*.html    ── 参考页(预览用;也是 Agent 的视觉参照)
 *
 * 这里只做「纯解析 + 归一化」;目录扫描与文件读取在主进程(templates.ts),
 * 渲染端只经 IPC 拿归一化后的 summary。
 */
import type { SlidesTheme } from './slides-types'

/** 模板分类(来自 frontmatter category):明暗倾向或场景分类(business);其余值归一化为 unknown。 */
export type SlidesTemplateCategory = 'light' | 'dark' | 'business' | 'unknown'

/** 归一化后的模板摘要(IPC/UI/MCP 共用)。 */
export type SlidesTemplateSummary = {
  /** 目录名,同时是稳定 id(如 'quiet-axis')。 */
  id: string
  /** 展示名(优先 zh 描述所属的标题;缺省用 id)。 */
  title: string
  /** 英文一句话描述。 */
  description: string
  /** 中文简称/描述(frontmatter description_zh);缺省为空串。 */
  descriptionZh: string
  category: SlidesTemplateCategory
  tags: string[]
  /** 供 Agent 参照的风格指南长文(来自 template.json theme.styleGuide)。 */
  styleGuide: string
  /** 归一化为 deck 主题(可直接 set_theme)。 */
  theme: SlidesTheme
  /** 参考页(工作区外的只读资源路径,由主进程解析为可预览的绝对路径)。 */
  referenceSlides: Array<{ layout: string; file: string }>
}

/** template.json 的原始形状(只取我们用得到的字段)。 */
export type SlidesTemplateJson = {
  version?: number
  theme?: {
    colors?: Record<string, string>
    typography?: {
      baseSize?: number
      heading?: { weight?: number; lineHeight?: number }
      body?: { weight?: number; lineHeight?: number }
    }
    styleGuide?: string
  }
  decorativePatterns?: Array<{
    name?: string
    description?: string
    cssSnippets?: string[]
    htmlFragments?: string[]
  }>
  referenceSlides?: Array<{ layout?: string; file?: string }>
}

/** 极简 YAML frontmatter 解析:只支持 `key: value` 与 `key: [a, b]`(模板文件即此形状)。 */
export function parseTemplateFrontmatter(markdown: string): Record<string, string | string[]> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) return {}
  const out: Record<string, string | string[]> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!
    const raw = kv[2]!.trim()
    if (raw.startsWith('[') && raw.endsWith(']')) {
      out[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      out[key] = raw
    }
  }
  return out
}

function asString(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

function asArray(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : []
}

/** 六位 hex 归一化(模板色值可能是 #rgb 或带空白);非法时回落 fallback。 */
function normalizeHex(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  }
  return fallback
}

/** 正文可读性下限(WCAG AA 正文)。低于此值的配色一律回落黑/白。 */
export const MIN_TEXT_CONTRAST = 4.5

/**
 * 模板 → deck 主题的归一化。
 *
 * 这批模板的 `colors` 字段并不可靠,归一化必须自己兜底:
 *  1. `text` / `textSecondary` 在部分模板里错位(如 quiet-axis 的 text 反而是浅色、
 *     textSecondary 才是墨色)→ foreground 取「与 background 对比度更高者」,不盲信字段名;
 *  2. 个别模板的 `background` 压根不是实际底色(如 pixel-orbit 标 category: dark、
 *     描述是 "deep navy void",colors.background 却是粉色)→ 若两个候选都达不到
 *     MIN_TEXT_CONTRAST,直接按背景明暗回落黑/白,保证生成页面可读。
 * 真正的视觉风格由 styleGuide 引导 Agent,这里只保证「配色不至于不可读」。
 */
export function templateToSlidesTheme(options: {
  id: string
  frontmatter: Record<string, string | string[]>
  json: SlidesTemplateJson
}): SlidesTheme {
  const colors = options.json.theme?.colors ?? {}
  const background = normalizeHex(colors.background, '#ffffff')
  const candidates = [normalizeHex(colors.text, '#0f172a'), normalizeHex(colors.textSecondary, '#334155')]
  const best = candidates.reduce((acc, c) =>
    contrastRatio(c, background) > contrastRatio(acc, background) ? c : acc,
  )
  const foreground =
    contrastRatio(best, background) >= MIN_TEXT_CONTRAST
      ? best
      : contrastRatio('#0f172a', background) >= contrastRatio('#ffffff', background)
        ? '#0f172a'
        : '#ffffff'
  const density = densityFromBaseSize(options.json.theme?.typography?.baseSize)
  return {
    name: asString(options.frontmatter.name) || options.id,
    mood: asArray(options.frontmatter.tags).slice(0, 6),
    palette: {
      background,
      foreground,
      primary: normalizeHex(colors.primary, '#2563eb'),
      secondary: normalizeHex(colors.secondary, '#64748b'),
      accent: normalizeHex(colors.accent, '#f59e0b'),
    },
    // 字体族不从模板 JSON 取:模板里的字体名是「视觉参照」(如 Playfair Display),
    // 本机未必装、也不做嵌入;正文统一用系统中文字体栈,风格由 styleGuide 引导 Agent。
    fonts: { heading: 'PingFang SC', body: 'PingFang SC' },
    density,
    customInstructions: options.json.theme?.styleGuide ?? '',
  }
}

/** baseSize → 密度档:字号越大越"少而精"。 */
function densityFromBaseSize(baseSize: number | undefined): SlidesTheme['density'] {
  if (!baseSize || !Number.isFinite(baseSize)) return 'balanced'
  if (baseSize >= 24) return 'minimal'
  if (baseSize <= 16) return 'dense'
  return 'balanced'
}

/** WCAG 相对亮度。 */
function relativeLuminance(hex: string): number {
  const v = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

/** WCAG 对比度(1–21)。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** 组装模板摘要(纯函数;文件内容由调用方读入)。 */
export function buildTemplateSummary(options: {
  id: string
  markdown: string
  json: SlidesTemplateJson
}): SlidesTemplateSummary {
  const frontmatter = parseTemplateFrontmatter(options.markdown)
  const categoryRaw = asString(frontmatter.category)
  const category: SlidesTemplateCategory =
    categoryRaw === 'light' || categoryRaw === 'dark' || categoryRaw === 'business'
      ? categoryRaw
      : 'unknown'
  return {
    id: options.id,
    // 展示名:TEMPLATE.md 的一级标题优先(人写的漂亮名),否则 frontmatter name。
    title: /^#\s+(.+)$/m.exec(options.markdown)?.[1]?.trim() || asString(frontmatter.name) || options.id,
    description: asString(frontmatter.description),
    descriptionZh: asString(frontmatter.description_zh),
    category,
    tags: asArray(frontmatter.tags),
    styleGuide: options.json.theme?.styleGuide ?? '',
    theme: templateToSlidesTheme({ id: options.id, frontmatter, json: options.json }),
    referenceSlides: (options.json.referenceSlides ?? [])
      .filter((r): r is { layout: string; file: string } => typeof r.file === 'string' && r.file.length > 0)
      .map((r) => ({ layout: r.layout ?? 'unknown', file: r.file })),
  }
}

/** 模板 id 形状:只允许小写字母/数字/连字符(同时是目录名 —— 拒绝路径穿越)。 */
export function isValidTemplateId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}
