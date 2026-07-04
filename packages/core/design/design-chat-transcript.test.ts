import { afterEach, describe, expect, it, vi } from 'vitest'
import { setKunGuiPort, type KunGuiPort } from './compat/kun-gui-port'
import { setDesignStorage } from './compat/browser-storage'
import type { ChatBlock } from './compat/agent-types'
import type { BrowserStorageLike } from './compat/browser-storage'
import {
  emptyDesignThreadRegistry,
  markDesignThread,
  readDesignThreadRegistry,
  saveDesignThreadRegistry
} from './design-thread-registry'
import {
  designChatMetaPath,
  designChatTranscriptRelativePath,
  hydrateDesignChatMetaForDoc,
  parseDesignChatMeta,
  persistDesignChatMetaForDoc,
  serializeDesignChatTranscript,
  writeDesignChatTranscriptForThread
} from './design-chat-transcript'

class MemoryStorage implements BrowserStorageLike {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  setKunGuiPort(null)
  // 源码内部的 registry 读写走默认 browserStorage()（注入端口），非测试显式传入的 storage；
  // 卸载注入避免用例间共享进程内 Map 造成串场。
  setDesignStorage(null)
})

describe('design-chat-transcript', () => {
  it('uses a chat directory inside the owning design document', () => {
    expect(designChatMetaPath('doc_123')).toBe('.cortex-design/doc_123/chat/meta.json')
    expect(designChatTranscriptRelativePath('doc_123', 'thr.design-1'))
      .toBe('.cortex-design/doc_123/chat/thr.design-1.md')
    expect(designChatTranscriptRelativePath('../doc', 'thr_1')).toBeNull()
    expect(designChatTranscriptRelativePath('doc', '../thr')).toBeNull()
  })

  it('serializes a readable transcript without leaking reasoning blocks', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'u1', text: 'hidden full prompt', meta: { displayText: '画一个首页' } },
      { kind: 'reasoning', id: 'r1', text: 'internal reasoning' },
      { kind: 'assistant', id: 'a1', text: '我会先做首页结构。' },
      { kind: 'tool', id: 't1', summary: '写入 v1.html', status: 'success' }
    ]

    const transcript = serializeDesignChatTranscript(blocks, {
      docId: 'doc',
      threadId: 'thr_1',
      generatedAt: '2026-07-01T00:00:00.000Z'
    })

    expect(transcript).toContain('# 设计 Agent 对话记录')
    expect(transcript).toContain('- 设计稿: doc')
    expect(transcript).toContain('## 用户\n\n画一个首页')
    expect(transcript).toContain('## 设计 Agent\n\n我会先做首页结构。')
    expect(transcript).toContain('> [工具] 写入 v1.html')
    expect(transcript).not.toContain('internal reasoning')
    expect(transcript).not.toContain('hidden full prompt')
  })

  it('persists per-design chat meta from the design thread registry', async () => {
    const storage = new MemoryStorage()
    setDesignStorage(storage)
    saveDesignThreadRegistry(
      markDesignThread('/workspace/app', 'doc', 'thr_1', emptyDesignThreadRegistry()),
      storage
    )
    const writes: Array<{ path: string; content: string }> = []
    setKunGuiPort({
      readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
      writeWorkspaceFile: vi.fn(async (payload: { path: string; content: string }) => {
        writes.push(payload)
        return { ok: true as const, path: payload.path, size: payload.content.length }
      })
    } as unknown as KunGuiPort)

    await expect(
      persistDesignChatMetaForDoc({
        workspaceRoot: '/workspace/app',
        docId: 'doc',
        stampThreadId: 'thr_1'
      })
    ).resolves.toBe(true)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe('.cortex-design/doc/chat/meta.json')
    expect(parseDesignChatMeta(writes[0]!.content)).toMatchObject({
      version: 1,
      activeThreadId: 'thr_1',
      threads: [{ id: 'thr_1' }]
    })
  })

  it('hydrates the design thread registry from chat meta in the design document directory', async () => {
    const storage = new MemoryStorage()
    setDesignStorage(storage)
    setKunGuiPort({
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        path: '.cortex-design/doc/chat/meta.json',
        content: JSON.stringify({
          version: 1,
          activeThreadId: 'thr_new',
          threads: [{ id: 'thr_old' }, { id: 'thr_new' }]
        })
      }))
    } as unknown as KunGuiPort)

    await expect(
      hydrateDesignChatMetaForDoc({
        workspaceRoot: '/workspace/app',
        docId: 'doc'
      })
    ).resolves.toBe(true)

    const record = readDesignThreadRegistry(storage).workspaces['/workspace/app\u0000doc']
    expect(record).toEqual({
      activeThreadId: 'thr_new',
      threadIds: ['thr_old', 'thr_new']
    })
  })

  it('writes transcript and updates chat meta together', async () => {
    const storage = new MemoryStorage()
    setDesignStorage(storage)
    saveDesignThreadRegistry(
      markDesignThread('/workspace/app', 'doc', 'thr_1', emptyDesignThreadRegistry()),
      storage
    )
    const writes: Array<{ path: string; content: string }> = []
    setKunGuiPort({
      readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
      writeWorkspaceFile: vi.fn(async (payload: { path: string; content: string }) => {
        writes.push(payload)
        return { ok: true as const, path: payload.path, size: payload.content.length }
      })
    } as unknown as KunGuiPort)

    await expect(
      writeDesignChatTranscriptForThread({
        workspaceRoot: '/workspace/app',
        docId: 'doc',
        threadId: 'thr_1',
        blocks: [{ kind: 'assistant', id: 'a1', text: '完成首页。' }]
      })
    ).resolves.toBe(true)

    expect(writes.map((entry) => entry.path)).toEqual([
      '.cortex-design/doc/chat/thr_1.md',
      '.cortex-design/doc/chat/meta.json'
    ])
    expect(writes[0]!.content).toContain('完成首页。')
  })
})
