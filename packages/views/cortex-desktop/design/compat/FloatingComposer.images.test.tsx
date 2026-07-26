// 设计/演示会话的图片发送:composer 侧的采集与展示。
// 落盘换绝对路径在 core 的 sendDesignMessage(经 bridge.imageSave),这里只保证
// 三个入口(粘贴 / 选取 / 拖入)都能把图片交出去,且非图片文件不会被误收。
import { createElement } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FloatingComposer, type ComposerPendingImage } from './FloatingComposer'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k })
}))

const png = (name = 'shot.png'): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

const pending = (id: string, name = 'shot.png'): ComposerPendingImage => ({
  id,
  name,
  mimeType: 'image/png',
  data: new ArrayBuffer(3),
  dataUrl: 'data:image/png;base64,AQID'
})

const base = { input: '', setInput: () => {}, onSend: () => {} }

// jsdom 未实现 DataTransfer;组件只读 .files,给最小桩即可。
const transfer = (...files: File[]): { files: File[] } => ({ files })

describe('FloatingComposer 图片', () => {
  it('未接线时不显示图片入口(旧调用点行为不变)', () => {
    const { queryByLabelText } = render(createElement(FloatingComposer, { ...base }))
    expect(queryByLabelText(/添加图片/)).toBeNull()
  })

  it('粘贴截图 → 交出图片文件', async () => {
    const got: File[][] = []
    const { container } = render(
      createElement(FloatingComposer, { ...base, onAddImages: (f: File[]) => got.push(f) })
    )
    const textarea = container.querySelector('textarea')!
    await userEvent.click(textarea)
    // userEvent.paste 不搬运 files,直接派发带 clipboardData 的 paste 事件。
    const ev = new Event('paste', { bubbles: true }) as Event & { clipboardData?: unknown }
    ev.clipboardData = transfer(png())
    textarea.dispatchEvent(ev)
    expect(got).toHaveLength(1)
    expect(got[0]![0]!.name).toBe('shot.png')
  })

  it('拖入图片 → 交出图片文件', () => {
    const got: File[][] = []
    const { container } = render(
      createElement(FloatingComposer, { ...base, onAddImages: (f: File[]) => got.push(f) })
    )
    const ev = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown }
    ev.dataTransfer = transfer(png('dragged.png'))
    container.firstElementChild!.dispatchEvent(ev)
    expect(got[0]![0]!.name).toBe('dragged.png')
  })

  it('非图片文件被忽略(拖入 PDF 不该当图片发)', () => {
    const got: File[][] = []
    const { container } = render(
      createElement(FloatingComposer, { ...base, onAddImages: (f: File[]) => got.push(f) })
    )
    const ev = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown }
    ev.dataTransfer = transfer(new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }))
    container.firstElementChild!.dispatchEvent(ev)
    expect(got).toHaveLength(0)
  })

  it('待发图片渲染为可移除的缩略图', async () => {
    const removed: string[] = []
    const { getByTestId, getByLabelText } = render(
      createElement(FloatingComposer, {
        ...base,
        onAddImages: () => {},
        images: [pending('i1'), pending('i2', 'b.png')],
        onRemoveImage: (id: string) => removed.push(id)
      })
    )
    expect(getByTestId('composer-images').querySelectorAll('img')).toHaveLength(2)
    await userEvent.click(getByLabelText('移除图片: b.png'))
    expect(removed).toEqual(['i2'])
  })

  it('只有图片没有文字时发送按钮可用', () => {
    const { getByRole } = render(
      createElement(FloatingComposer, { ...base, onAddImages: () => {}, images: [pending('i1')] })
    )
    expect((getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('既无文字也无图片时发送按钮禁用', () => {
    const { getByRole } = render(createElement(FloatingComposer, { ...base, onAddImages: () => {} }))
    expect((getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
