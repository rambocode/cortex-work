import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import {
  DesignAIRail,
  deriveDesignThreadTitleFromBlocks,
  designThreadTitleLooksDefault
} from './DesignAIRail'
import { DesignTargetToggle } from './DesignTargetToggle'

type DesignAIRailProps = ComponentProps<typeof DesignAIRail>

function props(overrides: Partial<DesignAIRailProps> = {}): DesignAIRailProps {
  return {
    input: '',
    setInput: () => {},
    mode: 'agent',
    setMode: () => {},
    busy: false,
    runtimeConnection: 'ready',
    activeThreadId: null,
    blocks: [],
    liveReasoning: '',
    liveAssistant: '',
    composerModel: 'deepseek-chat',
    composerPickList: ['deepseek-chat'],
    composerReasoningEffort: 'auto',
    setComposerModel: () => {},
    setComposerReasoningEffort: () => {},
    queuedMessages: [],
    removeQueuedMessage: () => {},
    onSend: () => {},
    onInterrupt: () => {},
    onRetryConnection: () => {},
    onOpenSettings: () => {},
    onNewConversation: () => {},
    designThreads: [],
    onSwitchThread: () => {},
    onCollapse: () => {},
    designAgent: 'claude',
    onSwitchAgent: () => {},
    ...overrides
  }
}

beforeEach(() => {
  useDesignWorkspaceStore.setState({
    workspaceRoot: '/tmp/kun-design',
    artifacts: [],
    activeArtifactId: null,
    designContext: { designTarget: 'web' },
    pagesRun: null,
    multiPageMode: false
  })
})

describe('DesignAIRail target toggle', () => {
  it('derives visible drawing titles from the first design request', () => {
    expect(designThreadTitleLooksDefault('Design Assistant', '设计助手')).toBe(true)
    expect(designThreadTitleLooksDefault('设计助手', '设计助手')).toBe(true)
    expect(designThreadTitleLooksDefault('Kun mobile settings')).toBe(false)
    expect(deriveDesignThreadTitleFromBlocks([
      {
        kind: 'user',
        id: 'u1',
        text: '帮我设计一个 Kun 移动端设置页。需要深色主题和账号设置。'
      }
    ])).toBe('帮我设计一个 Kun 移动端设置页')
  })

  it('shows a derived drawing title instead of the default assistant title', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({
      activeThreadId: 'thread-current-document',
      blocks: [
        {
          kind: 'user',
          id: 'u1',
          text: '帮我设计一个 Kun 线程列表页面。包含搜索、会话分组和底部导航。'
        }
      ],
      designThreads: [{
        id: 'thread-current-document',
        title: 'Design Assistant',
        workspace: '/tmp/kun-design',
        model: 'deepseek-chat',
        mode: 'agent',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }]
    })))

    expect(html).toContain('帮我设计一个 Kun 线程列表页面')
    expect(html).not.toContain('>Design Assistant</span>')
  })

  it('does not render blocks from a thread outside the active design document', () => {
    const html = renderToStaticMarkup(
      createElement(DesignAIRail, props({
        activeThreadId: 'thread-old-document',
        blocks: [
          { kind: 'user', id: 'u1', text: 'old document request' },
          { kind: 'assistant', id: 'a1', text: 'old document answer' }
        ],
        liveReasoning: 'old live reasoning',
        liveAssistant: 'old live answer',
        designThreads: []
      }))
    )

    expect(html).not.toContain('old document request')
    expect(html).not.toContain('old document answer')
    expect(html).not.toContain('old live reasoning')
    expect(html).not.toContain('old live answer')
    expect(html).toContain('描述你想设计的界面，助手会为你生成。')
  })

  it('shows the design target toggle with Web selected by default', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props()))

    expect(html).toContain('选择设计 Agent 默认生成网页还是移动 App 页面')
    expect(html).toContain('aria-label="Web: 默认 1280 x 800 Web 画布"')
    expect(html).toContain('aria-label="App: 默认 390 x 844 App 画布"')
    expect(html).toContain('Agent 上下文')
    expect(html).toContain('aria-label="Agent 上下文: Web - 默认 1280 x 800 Web 画布"')
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?Web<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[\s\S]*?App<\/button>/)
  })

  it('reflects the selected App target and locks switching while busy', () => {
    const html = renderToStaticMarkup(
      createElement(DesignTargetToggle, {
        designTarget: 'app',
        disabled: true,
        disabledReason: '设计 Agent 工作中会暂时锁定目标类型',
        onChange: () => {}
      })
    )

    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*disabled=""[^>]*>[\s\S]*?Web<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*disabled=""[^>]*>[\s\S]*?App<\/button>/)
    expect(html).toContain('aria-label="设计 Agent 工作中会暂时锁定目标类型"')
    expect(html).toContain(
      'aria-label="App: 默认 390 x 844 App 画布. 设计 Agent 工作中会暂时锁定目标类型"'
    )
    expect(html).toContain(
      'title="默认 390 x 844 App 画布. 设计 Agent 工作中会暂时锁定目标类型"'
    )
  })

  it('renders the design agent selector with the selected agent label', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({ designAgent: 'claude' })))

    expect(html).toContain('pw-sh-agent')
    expect(html).toContain('Claude Code')
  })

  it('shows the design agent selector in slides mode too', () => {
    const html = renderToStaticMarkup(
      createElement(DesignAIRail, props({ slidesMode: true, designAgent: 'codex' }))
    )

    expect(html).toContain('pw-sh-agent')
    expect(html).toContain('Codex')
  })

  it('explains why the rail target switch is disabled while the agent is busy', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({
      activeThreadId: 'thread-current-document',
      busy: true,
      designThreads: [{
        id: 'thread-current-document',
        title: 'Design Assistant',
        workspace: '/tmp/kun-design',
        model: 'deepseek-chat',
        mode: 'agent',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }]
    })))

    expect(html).toContain('设计 Agent 工作中会暂时锁定目标类型')
    expect(html).toContain(
      'aria-label="Web: 默认 1280 x 800 Web 画布. 设计 Agent 工作中会暂时锁定目标类型"'
    )
  })
})

describe('DesignAIRail slides 联网 pill', () => {
  it('反映联网开关的两种状态', () => {
    const off = renderToStaticMarkup(createElement(DesignAIRail, props({
      slidesMode: true,
      slidesWebSearch: false,
      onToggleSlidesWebSearch: () => {}
    })))
    const on = renderToStaticMarkup(createElement(DesignAIRail, props({
      slidesMode: true,
      slidesWebSearch: true,
      onToggleSlidesWebSearch: () => {}
    })))
    expect(off).toMatch(/data-testid="slides-web-search-pill"[^>]*aria-pressed="false"/)
    expect(on).toMatch(/data-testid="slides-web-search-pill"[^>]*aria-pressed="true"/)
  })

  it('搜索后端未配置时禁用并解释原因', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({
      slidesMode: true,
      slidesWebSearchUnavailable: true,
      onToggleSlidesWebSearch: () => {}
    })))
    expect(html).toMatch(/data-testid="slides-web-search-pill"[^>]*disabled=""/)
    expect(html).toContain('请先在研究引擎设置中配置搜索后端')
  })

  it('运行中禁用', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({
      slidesMode: true,
      busy: true,
      activeThreadId: 'design-deck-1',
      designThreads: [{
        id: 'design-deck-1',
        title: 'Deck',
        model: 'deepseek-chat',
        mode: 'agent',
        updatedAt: '2026-07-26T00:00:00.000Z'
      }],
      onToggleSlidesWebSearch: () => {}
    })))
    expect(html).toMatch(/data-testid="slides-web-search-pill"[^>]*disabled=""/)
  })

  it('未接 toggle 或非 slides 模式时不渲染', () => {
    expect(renderToStaticMarkup(createElement(DesignAIRail, props({ slidesMode: true })))).not.toContain(
      'slides-web-search-pill'
    )
    expect(renderToStaticMarkup(createElement(DesignAIRail, props({
      slidesMode: false,
      onToggleSlidesWebSearch: () => {}
    })))).not.toContain('slides-web-search-pill')
  })
})
