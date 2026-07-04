import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isAbsoluteLocalImagePath,
  loadWorkspaceImageDataUrl
} from './canvas-image-source'
import { setKunGuiPort, type KunGuiPort } from '../compat/kun-gui-port'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // 源码已改走注入式端口，清理注入避免用例间串桩。
  setKunGuiPort(null)
})

describe('canvas image source loading', () => {
  it('does not permanently cache a failed workspace image read', async () => {
    const dataUrl = 'data:image/png;base64,ok'
    const readWorkspaceImage = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: 'File not found' })
      .mockResolvedValueOnce({ ok: true, dataUrl, path: '/ws/img/flaky.png', mimeType: 'image/png', size: 2 })
    setKunGuiPort({ readWorkspaceImage } as unknown as KunGuiPort)

    await expect(loadWorkspaceImageDataUrl('/ws', 'img/flaky-retry.png')).resolves.toBeNull()
    await expect(loadWorkspaceImageDataUrl('/ws', 'img/flaky-retry.png')).resolves.toBe(dataUrl)
    expect(readWorkspaceImage).toHaveBeenCalledTimes(2)
  })

  it('reads absolute local image paths without applying the canvas workspace boundary', async () => {
    const absolutePath = '/Users/zxy/.kun/default_workspace/.deepseekgui-images/generated.png'
    const readWorkspaceImage = vi.fn(async () => ({
      ok: true,
      dataUrl: 'data:image/png;base64,ok',
      path: absolutePath,
      mimeType: 'image/png',
      size: 2
    }))
    setKunGuiPort({ readWorkspaceImage } as unknown as KunGuiPort)

    await expect(loadWorkspaceImageDataUrl('/Users/zxy/.kun/design-workspace', absolutePath))
      .resolves.toBe('data:image/png;base64,ok')
    expect(isAbsoluteLocalImagePath(absolutePath)).toBe(true)
    expect(readWorkspaceImage).toHaveBeenCalledWith({ path: absolutePath })
  })
})
