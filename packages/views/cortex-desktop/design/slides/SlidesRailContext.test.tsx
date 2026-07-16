// 右栏 slides 上下文测试:演示文稿设计稿不该显示自由画布的 Web/App 目标与
// 「1280 × 800 Web 画布」,而应显示 16:9 演示上下文与演示口径的空态/占位。
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { DesignAIRail } from '../DesignAIRail'

// MessageTimeline 依赖大量渲染态,这里只关心 composer 上下文区与空态文案。
vi.mock('../compat/MessageTimeline', () => ({ MessageTimeline: () => <div data-testid="timeline" /> }))

const BASE_PROPS = {
  input: '',
  setInput: () => {},
  mode: 'agent' as const,
  setMode: () => {},
  busy: false,
  runtimeConnection: 'ready' as const,
  activeThreadId: null,
  blocks: [],
  liveReasoning: '',
  liveAssistant: '',
  composerModel: '',
  composerPickList: [],
  composerReasoningEffort: 'auto' as const,
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
  onCollapse: () => {}
}

beforeEach(() => {
  useDesignWorkspaceStore.setState({ workspaceRoot: '/ws', artifacts: [], activeArtifactId: null })
})

afterEach(() => {
  cleanup()
})

describe('DesignAIRail slidesMode', () => {
  it('slides:显示 16:9 演示上下文,隐藏 Web/App 目标切换', () => {
    render(<DesignAIRail {...BASE_PROPS} slidesMode />)
    expect(screen.getByText('演示上下文')).toBeInTheDocument()
    expect(screen.getByText('16:9 · 1280 × 720 演示页')).toBeInTheDocument()
    // 自由画布的目标切换不应出现。
    expect(screen.queryByText('Web')).toBeNull()
    expect(screen.queryByText('App')).toBeNull()
  })

  it('slides:空态与占位是演示口径,不是「设计界面」', () => {
    render(<DesignAIRail {...BASE_PROPS} slidesMode />)
    expect(screen.getByText('描述你的演示主题与受众,助手会先给出提纲。')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('描述你的演示主题…')).toBeInTheDocument()
    expect(screen.queryByText('描述你想设计的界面，助手会为你生成。')).toBeNull()
  })

  it('board(默认):仍显示设计目标切换与设计口径文案', () => {
    render(<DesignAIRail {...BASE_PROPS} />)
    expect(screen.queryByText('演示上下文')).toBeNull()
    expect(screen.getByText('描述你想设计的界面，助手会为你生成。')).toBeInTheDocument()
  })
})
