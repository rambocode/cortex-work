import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SlidesPipelineRun } from '@cortex-work/core/design/slides/slides-pipeline-types'
import { SlidesWorkflowPanel } from './SlidesWorkflowPanel'

const RUN: SlidesPipelineRun = {
  schemaVersion: 1,
  id: 'run-review-1',
  deckId: 'deck1',
  kind: 'review',
  deckRevisionAtStart: 7,
  status: 'awaiting-approval',
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:05.000Z',
  roles: [
    {
      role: 'narrative-reviewer',
      status: 'awaiting-approval',
      artifactFile: 'narrative-review.json',
      updatedAt: '2026-07-17T00:00:05.000Z',
      summary: '发现两处叙事跳跃'
    },
    {
      role: 'render-reviewer',
      status: 'failed',
      artifactFile: 'render-review.json',
      updatedAt: '2026-07-17T00:00:04.000Z',
      errorMessage: '渲染超时'
    }
  ]
}

describe('SlidesWorkflowPanel', () => {
  it('无 run 时提供三个明确工作流动作', () => {
    const onStart = vi.fn()
    render(<SlidesWorkflowPanel open run={null} onClose={vi.fn()} onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: '生成前研究' }))
    fireEvent.click(screen.getByRole('button', { name: '整套深度审阅' }))
    fireEvent.click(screen.getByRole('button', { name: '批量生成备注' }))
    expect(onStart.mock.calls.map((call) => call[0])).toEqual(['research', 'review', 'notes'])
  })

  it('展示角色状态/摘要/错误并允许接受、拒绝、重试和取消', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    render(
      <SlidesWorkflowPanel
        open
        run={RUN}
        onClose={vi.fn()}
        onStart={vi.fn()}
        onAccept={onAccept}
        onReject={onReject}
        onRetry={onRetry}
        onCancel={onCancel}
      />
    )
    expect(screen.getByText('发现两处叙事跳跃')).toBeInTheDocument()
    expect(screen.getByText('渲染超时')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '接受 narrative-reviewer' }))
    fireEvent.click(screen.getByRole('button', { name: '拒绝 narrative-reviewer' }))
    fireEvent.click(screen.getByRole('button', { name: '重试 render-reviewer' }))
    fireEvent.click(screen.getByRole('button', { name: '取消工作流' }))
    expect(onAccept).toHaveBeenCalledWith('narrative-reviewer')
    expect(onReject).toHaveBeenCalledWith('narrative-reviewer')
    expect(onRetry).toHaveBeenCalledWith('render-reviewer')
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
