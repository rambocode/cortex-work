// 模板解析纯函数测试:frontmatter、主题归一化(含 text/textSecondary 错位的对比度择优)、
// 密度推导、id 白名单。
import { describe, expect, it } from 'vitest'
import {
  buildTemplateSummary,
  contrastRatio,
  isValidTemplateId,
  parseTemplateFrontmatter,
  templateToSlidesTheme,
  type SlidesTemplateJson
} from './slides-templates'

const MARKDOWN = `---
name: quiet-axis
description: Quiet warm-neutral palette with classical Playfair serifs.
description_zh: 静态坐标
version: 1.0.0
category: light
tags: [quiet, considered, elegant, warm-minimal]
readonly: true
---

# Quiet Axis

Quiet warm-neutral palette.

## Best For

White papers.
`

// 取自真实模板 quiet-axis:注意 text 是浅色、textSecondary 才是墨色(字段名与实际错位)。
const JSON_FIXTURE: SlidesTemplateJson = {
  version: 1,
  theme: {
    colors: {
      primary: '#8A8178',
      secondary: '#E2DBD1',
      accent: '#8A8178',
      background: '#EDE8E0',
      surface: '#E2DBD1',
      text: '#E2DBD1',
      textSecondary: '#1A1A1A',
      border: '#B8B0A4'
    },
    typography: { baseSize: 24, heading: { weight: 600, lineHeight: 1.12 }, body: { weight: 400, lineHeight: 1.55 } },
    styleGuide: 'Quiet Axis is a builtin visual reference…'
  },
  referenceSlides: [{ layout: 'cover', file: 'references/template.html' }]
}

describe('parseTemplateFrontmatter', () => {
  it('解析标量与数组字段', () => {
    const fm = parseTemplateFrontmatter(MARKDOWN)
    expect(fm.name).toBe('quiet-axis')
    expect(fm.description_zh).toBe('静态坐标')
    expect(fm.category).toBe('light')
    expect(fm.tags).toEqual(['quiet', 'considered', 'elegant', 'warm-minimal'])
  })

  it('无 frontmatter 时返回空对象', () => {
    expect(parseTemplateFrontmatter('# 只有标题')).toEqual({})
  })
})

describe('templateToSlidesTheme', () => {
  it('foreground 取与背景对比度更高者(模板 text/textSecondary 常错位)', () => {
    const theme = templateToSlidesTheme({
      id: 'quiet-axis',
      frontmatter: parseTemplateFrontmatter(MARKDOWN),
      json: JSON_FIXTURE
    })
    // 浅底 #EDE8E0:应选墨色 #1A1A1A 而不是同为浅色的 #E2DBD1。
    expect(theme.palette.background).toBe('#EDE8E0')
    expect(theme.palette.foreground).toBe('#1A1A1A')
    expect(contrastRatio(theme.palette.foreground, theme.palette.background)).toBeGreaterThan(4.5)
  })

  it('字体族不取模板字体名(本机未必装、不做嵌入),风格靠 styleGuide 引导', () => {
    const theme = templateToSlidesTheme({
      id: 'quiet-axis',
      frontmatter: parseTemplateFrontmatter(MARKDOWN),
      json: JSON_FIXTURE
    })
    expect(theme.fonts.heading).toBe('PingFang SC')
    expect(theme.customInstructions).toContain('Quiet Axis')
  })

  it('baseSize 推导密度', () => {
    const base = { id: 't', frontmatter: {}, json: {} as SlidesTemplateJson }
    expect(templateToSlidesTheme(base).density).toBe('balanced')
    expect(
      templateToSlidesTheme({ ...base, json: { theme: { typography: { baseSize: 26 } } } }).density
    ).toBe('minimal')
    expect(templateToSlidesTheme({ ...base, json: { theme: { typography: { baseSize: 14 } } } }).density).toBe(
      'dense'
    )
  })

  // 真实模板 pixel-orbit:标 dark、描述是 navy,但 colors.background 是粉色、
  // 两个文字候选都是亮色 —— 直接用会生成不可读页面,必须回落黑/白。
  it('候选文字色都不可读时按背景明暗回落黑/白', () => {
    const theme = templateToSlidesTheme({
      id: 'pixel-orbit',
      frontmatter: {},
      json: {
        theme: {
          colors: { background: '#F0A6CA', text: '#5EDCF4', textSecondary: '#F4D03F' }
        }
      }
    })
    expect(theme.palette.foreground).toBe('#0f172a')
    expect(contrastRatio(theme.palette.foreground, theme.palette.background)).toBeGreaterThanOrEqual(4.5)
  })

  it('深底且候选不可读时回落白字', () => {
    const theme = templateToSlidesTheme({
      id: 'x',
      frontmatter: {},
      json: { theme: { colors: { background: '#101828', text: '#1a2233', textSecondary: '#22304a' } } }
    })
    expect(theme.palette.foreground).toBe('#ffffff')
  })

  it('缺失/非法色值回落默认,#rgb 展开为六位', () => {
    const theme = templateToSlidesTheme({
      id: 't',
      frontmatter: {},
      json: { theme: { colors: { background: '#fff', primary: 'not-a-color' } } }
    })
    expect(theme.palette.background).toBe('#ffffff')
    expect(theme.palette.primary).toBe('#2563eb')
  })
})

describe('buildTemplateSummary', () => {
  it('组装摘要:标题取一级标题,带描述/分类/标签/参考页', () => {
    const summary = buildTemplateSummary({ id: 'quiet-axis', markdown: MARKDOWN, json: JSON_FIXTURE })
    expect(summary.id).toBe('quiet-axis')
    expect(summary.title).toBe('Quiet Axis')
    expect(summary.descriptionZh).toBe('静态坐标')
    expect(summary.category).toBe('light')
    expect(summary.tags).toContain('elegant')
    expect(summary.referenceSlides).toEqual([{ layout: 'cover', file: 'references/template.html' }])
    expect(summary.styleGuide).toContain('Quiet Axis')
  })

  it('未知 category 归一化为 unknown;无参考页时为空数组', () => {
    const summary = buildTemplateSummary({ id: 'x', markdown: '---\ncategory: neon\n---\n', json: {} })
    expect(summary.category).toBe('unknown')
    expect(summary.referenceSlides).toEqual([])
    expect(summary.title).toBe('x')
  })
})

describe('isValidTemplateId', () => {
  it('只接受小写字母数字连字符(同时是目录名,拒路径穿越)', () => {
    expect(isValidTemplateId('quiet-axis')).toBe(true)
    expect(isValidTemplateId('../evil')).toBe(false)
    expect(isValidTemplateId('Quiet')).toBe(false)
    expect(isValidTemplateId('a/b')).toBe(false)
    expect(isValidTemplateId('')).toBe(false)
  })
})
