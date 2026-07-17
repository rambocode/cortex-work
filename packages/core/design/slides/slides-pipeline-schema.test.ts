import { describe, expect, it } from 'vitest'
import type {
  SlidesPipelineRoleRun,
  SlidesPipelineRun,
  SlidesRole
} from './slides-pipeline-types'
import {
  SLIDES_PIPELINE_MAX_LIST_ITEMS,
  SLIDES_PIPELINE_MAX_MARKDOWN_CHARS,
  SLIDES_PIPELINE_MAX_RUN_JSON_BYTES,
  SLIDES_PIPELINE_MAX_SHORT_TEXT_CHARS,
  parseSlidesPipelineRun,
  parseSlidesRoleResult,
  serializeSlidesPipelineRun,
  serializeSlidesRoleResult
} from './slides-pipeline-schema'

const NOW = '2026-07-17T00:00:00.000Z'

function roleRun(role: SlidesRole, overrides: Partial<SlidesPipelineRoleRun> = {}): SlidesPipelineRoleRun {
  return {
    role,
    status: 'queued',
    artifactFile:
      role === 'topic-researcher'
        ? 'topic-research.json'
        : role === 'visual-researcher'
          ? 'visual-research.json'
          : role === 'narrative-reviewer'
            ? 'narrative-review.json'
            : role === 'render-reviewer'
              ? 'render-review.json'
              : 'notes-draft.json',
    updatedAt: NOW,
    ...overrides
  }
}

function validRun(overrides: Partial<SlidesPipelineRun> = {}): SlidesPipelineRun {
  return {
    schemaVersion: 1,
    id: 'run-001',
    deckId: 'deckabc1',
    kind: 'review',
    deckRevisionAtStart: 7,
    status: 'running',
    roles: [roleRun('narrative-reviewer'), roleRun('render-reviewer')],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

describe('parseSlidesPipelineRun', () => {
  it('接受合法 run（对象与 JSON 字符串两种输入）', () => {
    const run = validRun()
    expect(parseSlidesPipelineRun(run).ok).toBe(true)
    const fromString = parseSlidesPipelineRun(serializeSlidesPipelineRun(run))
    expect(fromString.ok).toBe(true)
    if (fromString.ok) expect(fromString.run.roles.map((role) => role.role)).toEqual(['narrative-reviewer', 'render-reviewer'])
  })

  it('拒绝额外键、重复 role 与错误 artifact 文件名', () => {
    const withExtra = validRun() as unknown as Record<string, unknown>
    withExtra.extra = true
    expect(parseSlidesPipelineRun(withExtra).ok).toBe(false)

    const duplicateRoles = validRun({
      roles: [roleRun('render-reviewer'), roleRun('render-reviewer', { updatedAt: '2026-07-17T00:00:01.000Z' })]
    })
    expect(parseSlidesPipelineRun(duplicateRoles).ok).toBe(false)

    const wrongArtifact = validRun({
      roles: [roleRun('topic-researcher', { artifactFile: 'render-review.json' })]
    })
    expect(parseSlidesPipelineRun(wrongArtifact).ok).toBe(false)
    expect(parseSlidesPipelineRun(validRun({ updatedAt: 'not-a-date' })).ok).toBe(false)
  })

  it('拒绝超过条目上限或总 JSON 过大的 run', () => {
    const tooManyRoles = validRun({
      roles: [
        roleRun('topic-researcher'),
        roleRun('visual-researcher'),
        roleRun('narrative-reviewer'),
        roleRun('render-reviewer'),
        roleRun('notes-writer'),
        roleRun('topic-researcher', { updatedAt: '2026-07-17T00:00:02.000Z' })
      ] as SlidesPipelineRoleRun[]
    })
    expect(parseSlidesPipelineRun(tooManyRoles).ok).toBe(false)

    const oversized = validRun({
      roles: [roleRun('topic-researcher', { rawSummary: 'x'.repeat(SLIDES_PIPELINE_MAX_RUN_JSON_BYTES) })]
    })
    expect(parseSlidesPipelineRun(oversized).ok).toBe(false)
  })
})

describe('parseSlidesRoleResult', () => {
  it('接受五种最小结构化结果并可稳定序列化', () => {
    const fixtures: Array<[SlidesRole, unknown]> = [
      [
        'topic-researcher',
        {
          facts: ['市场规模增长'],
          sources: [{ title: 'IDC 2026', url: 'https://example.com/idc-2026' }],
          claims: ['AI 办公渗透率继续上升'],
          openQuestions: ['是否需要按行业拆分数据']
        }
      ],
      [
        'visual-researcher',
        {
          assetIdeas: [{ query: 'team collaboration presentation', rationale: '封面需要团队协作氛围' }],
          chartIdeas: [{ chartType: 'bar', rationale: '对比不同季度增长' }],
          visualRisks: [{ message: '过度依赖 stock image 会削弱可信度' }]
        }
      ],
      [
        'narrative-reviewer',
        {
          deckFindings: [{ code: 'weak-hook', message: '开场缺少明确问题陈述' }],
          slideFindings: [{ slideId: 'slot-001', code: 'dense-copy', message: '第 1 页文案偏密' }],
          suggestedOrder: ['slot-001', 'slot-002']
        }
      ],
      [
        'render-reviewer',
        {
          findings: [
            {
              severity: 'warning',
              slideId: 'slot-001',
              elementId: 'hero-title',
              code: 'text-overflow',
              message: '标题可能溢出',
              hint: '减小字号或增加换行'
            }
          ]
        }
      ],
      [
        'notes-writer',
        {
          slots: [{ slotId: 'slot-001', markdown: '## 开场\n\n欢迎来到演示。' }]
        }
      ]
    ]

    for (const [role, payload] of fixtures) {
      const parsed = parseSlidesRoleResult(role, payload)
      expect(parsed.ok, role).toBe(true)
      const roundTrip = parseSlidesRoleResult(role, serializeSlidesRoleResult(role, payload as never))
      expect(roundTrip.ok, `${role} round trip`).toBe(true)
    }
  })

  it('拒绝额外键、过多条目与过长 Markdown', () => {
    const extra = {
      facts: ['x'],
      sources: [{ title: 'S' }],
      claims: ['y'],
      openQuestions: ['z'],
      extra: true
    }
    expect(parseSlidesRoleResult('topic-researcher', extra).ok).toBe(false)

    const tooManyFacts = {
      facts: Array.from({ length: SLIDES_PIPELINE_MAX_LIST_ITEMS + 1 }, (_, i) => `fact-${i}`),
      sources: [{ title: 'S' }],
      claims: ['claim'],
      openQuestions: ['question']
    }
    expect(parseSlidesRoleResult('topic-researcher', tooManyFacts).ok).toBe(false)

    const longMarkdown = {
      slots: [{ slotId: 'slot-001', markdown: 'x'.repeat(SLIDES_PIPELINE_MAX_MARKDOWN_CHARS + 1) }]
    }
    expect(parseSlidesRoleResult('notes-writer', longMarkdown).ok).toBe(false)
  })

  it('允许 review 明确报告没有问题，而不是强迫编造 finding', () => {
    expect(parseSlidesRoleResult('render-reviewer', { findings: [] }).ok).toBe(true)
    expect(
      parseSlidesRoleResult('narrative-reviewer', { deckFindings: [], slideFindings: [], suggestedOrder: [] }).ok
    ).toBe(true)
  })

  it('拒绝超长字符串与非法 slide/slot id', () => {
    const longText = 'x'.repeat(SLIDES_PIPELINE_MAX_SHORT_TEXT_CHARS + 1)
    expect(
      parseSlidesRoleResult('visual-researcher', {
        assetIdeas: [{ query: longText, rationale: 'ok' }],
        chartIdeas: [],
        visualRisks: []
      }).ok
    ).toBe(false)

    expect(
      parseSlidesRoleResult('render-reviewer', {
        findings: [{ severity: 'warning', slideId: '../evil', code: 'overflow', message: 'bad id' }]
      }).ok
    ).toBe(false)
  })
})
