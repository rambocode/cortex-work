// 会话产物右栏的宿主自带顶栏,工具栏行必须让位(hideActions),只保留 deck 错误条。
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBentoSlidesStore } from './bento-slides-store'
import { SlidesToolbar } from './SlidesToolbar'

describe('SlidesToolbar hideActions', () => {
  beforeEach(() => {
    useBentoSlidesStore.getState().reset()
    useBentoSlidesStore.setState({ doc: { title: '季度汇报' } as never })
  })

  afterEach(cleanup)

  it('默认渲染标题与播放/导出', () => {
    render(<SlidesToolbar />)
    expect(screen.getByText('季度汇报')).toBeInTheDocument()
    expect(screen.getByTestId('slides-play')).toBeInTheDocument()
    expect(screen.getByTestId('slides-export')).toBeInTheDocument()
  })

  it('hideActions 且无错误时整条不渲染(不留一条空的分隔线)', () => {
    const { container } = render(<SlidesToolbar hideActions />)
    expect(container.firstChild).toBeNull()
  })

  it('hideActions 仍要显示 deck 错误条(宿主顶栏不管错误)', () => {
    useBentoSlidesStore.setState({ deckError: { code: 'io_error', message: '磁盘写入失败' } })
    render(<SlidesToolbar hideActions />)
    expect(screen.getByText('磁盘写入失败')).toBeInTheDocument()
    expect(screen.queryByTestId('slides-play')).toBeNull()
  })
})
