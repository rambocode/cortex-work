// authorizeWritePrototype 的失败区分合同回归:
// 「文件不存在」必须返回 'prototype file not found'(PreviewHost 等待-重试分支的哨兵串,
// bento deck 主进程异步补建场景靠它自愈),真正越权才是 'local html not authorized' 硬错。
import { describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../../desktop/bridge'
import { createBridgeCortexGuiPort } from './bridge-adapter'

function makeBridge(overrides: Partial<DesktopBridge>): DesktopBridge {
  return {
    readFile: vi.fn(async () => ({ content: '', truncated: false })),
    ...overrides
  } as unknown as DesktopBridge
}

describe('authorizeWritePrototype', () => {
  it('授权成功 → ok + fileUrl', async () => {
    const port = createBridgeCortexGuiPort(
      makeBridge({ browserResolveLocalHtml: vi.fn(async () => 'file:///ws/a.html') } as Partial<DesktopBridge>)
    )
    const res = await port.authorizeWritePrototype({ path: '/ws/a.html', workspaceRoot: '/ws' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.fileUrl).toBe('file:///ws/a.html')
  })

  it('未授权且文件不存在(statFile 抛)→ prototype file not found(可重试哨兵)', async () => {
    const port = createBridgeCortexGuiPort(
      makeBridge({
        browserResolveLocalHtml: vi.fn(async () => null),
        statFile: vi.fn(async () => {
          throw new Error('ENOENT')
        })
      } as Partial<DesktopBridge>)
    )
    const res = await port.authorizeWritePrototype({ path: '/ws/missing.html', workspaceRoot: '/ws' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBe('prototype file not found')
  })

  it('未授权但文件存在(越权根)→ local html not authorized 硬错', async () => {
    const port = createBridgeCortexGuiPort(
      makeBridge({
        browserResolveLocalHtml: vi.fn(async () => null),
        statFile: vi.fn(async () => ({ size: 1, mtimeMs: 1 }))
      } as Partial<DesktopBridge>)
    )
    const res = await port.authorizeWritePrototype({ path: '/outside/a.html', workspaceRoot: '/ws' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBe('local html not authorized')
  })

  it('旧壳无 statFile → 退化用 readFile 探测存在性', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const port = createBridgeCortexGuiPort(
      makeBridge({ browserResolveLocalHtml: vi.fn(async () => null), readFile } as Partial<DesktopBridge>)
    )
    const res = await port.authorizeWritePrototype({ path: '/ws/missing.html', workspaceRoot: '/ws' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBe('prototype file not found')
    expect(readFile).toHaveBeenCalled()
  })
})
