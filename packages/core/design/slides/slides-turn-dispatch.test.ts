import { describe, expect, it, vi } from 'vitest'
import {
  clearSlidesTurnDispatcher,
  resolveSlidesTurnDispatcher,
  setSlidesTurnDispatcher,
  type SlidesTurnDispatcher
} from './slides-turn-dispatch'

function dispatcher(workspaceRoot: string, deckId: string): SlidesTurnDispatcher {
  return { workspaceRoot, deckId, send: vi.fn(async () => true) }
}

describe('slides 会话回合派发端口', () => {
  it('未注册时解析为 null(独立设计工作台入口)', () => {
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: '/ws', deckId: 'd1' })).toBeNull()
  })

  it('同 deck 命中,异 deck / 异工作区不命中', () => {
    const d = dispatcher('/ws', 'd1')
    setSlidesTurnDispatcher(d)
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: '/ws', deckId: 'd1' })).toBe(d)
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: '/ws', deckId: 'd2' })).toBeNull()
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: '/other', deckId: 'd1' })).toBeNull()
    clearSlidesTurnDispatcher(d)
  })

  it('清除按引用生效:换 deck 时旧面板的卸载不能抹掉新面板的注册', () => {
    const older = dispatcher('/ws', 'd1')
    const newer = dispatcher('/ws', 'd2')
    setSlidesTurnDispatcher(older)
    // React 切换子树时先挂新的、后卸旧的;无条件清空会让新面板的派发静默失效。
    setSlidesTurnDispatcher(newer)
    clearSlidesTurnDispatcher(older)
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: '/ws', deckId: 'd2' })).toBe(newer)
    clearSlidesTurnDispatcher(newer)
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: '/ws', deckId: 'd2' })).toBeNull()
  })
})
