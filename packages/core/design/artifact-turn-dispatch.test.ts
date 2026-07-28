import { describe, expect, it, vi } from 'vitest'
import {
  clearArtifactTurnDispatcher,
  resolveArtifactTurnDispatcher,
  setArtifactTurnDispatcher,
  type ArtifactTurnDispatcher
} from './artifact-turn-dispatch'

function dispatcher(workspaceRoot: string, documentId: string): ArtifactTurnDispatcher {
  return { workspaceRoot, documentId, send: vi.fn(async () => true) }
}

describe('会话产物回合派发端口', () => {
  it('未注册时解析为 null(独立设计工作台入口)', () => {
    expect(resolveArtifactTurnDispatcher({ workspaceRoot: '/ws', documentId: 'd1' })).toBeNull()
  })

  it('同产物命中,异文稿 / 异工作区不命中', () => {
    const d = dispatcher('/ws', 'd1')
    setArtifactTurnDispatcher(d)
    expect(resolveArtifactTurnDispatcher({ workspaceRoot: '/ws', documentId: 'd1' })).toBe(d)
    expect(resolveArtifactTurnDispatcher({ workspaceRoot: '/ws', documentId: 'd2' })).toBeNull()
    expect(resolveArtifactTurnDispatcher({ workspaceRoot: '/other', documentId: 'd1' })).toBeNull()
    clearArtifactTurnDispatcher(d)
  })

  it('清除按引用生效:换产物时旧面板的卸载不能抹掉新面板的注册', () => {
    const older = dispatcher('/ws', 'd1')
    const newer = dispatcher('/ws', 'd2')
    setArtifactTurnDispatcher(older)
    // React 切换子树时先挂新的、后卸旧的;无条件清空会让新面板的派发静默失效。
    setArtifactTurnDispatcher(newer)
    clearArtifactTurnDispatcher(older)
    expect(resolveArtifactTurnDispatcher({ workspaceRoot: '/ws', documentId: 'd2' })).toBe(newer)
    clearArtifactTurnDispatcher(newer)
    expect(resolveArtifactTurnDispatcher({ workspaceRoot: '/ws', documentId: 'd2' })).toBeNull()
  })
})
