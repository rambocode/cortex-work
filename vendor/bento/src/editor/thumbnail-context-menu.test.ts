// @vitest-environment jsdom
// CORTEX-PATCH: 左侧缩略图右键菜单的交互回归护栏。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BentoDoc } from '../model'

vi.mock('../autosave', () => ({
  addVersion: vi.fn(async () => {}),
  clearRecovery: vi.fn(async () => {}),
  clearVersions: vi.fn(async () => {}),
  docContentKey: vi.fn(() => 'content-key'),
  getRecovery: vi.fn(async () => null),
  listVersions: vi.fn(async () => []),
  pruneOld: vi.fn(async () => {}),
  putRecovery: vi.fn(async () => {}),
}))

vi.mock('../save', () => ({
  hasFileHandle: () => false,
  isEncryptionActive: () => false,
  saveFile: vi.fn(async () => 'saved'),
  serializeAuto: vi.fn(async () => '<html>deck</html>'),
  serializeFile: vi.fn(() => '<html>deck</html>'),
  setEncryptionPassword: vi.fn(),
  writeUpdatedFile: vi.fn(async () => {}),
  writeUpdatedFileAs: vi.fn(async () => true),
}))

vi.mock('../fonts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fonts')>()),
  injectFonts: vi.fn(),
}))

vi.mock('../render', () => ({
  renderSlide: vi.fn(() => {
    const node = document.createElement('div')
    node.className = 'bento-slide'
    return node
  }),
  renderThumbnail: vi.fn(() => {
    const node = document.createElement('div')
    node.className = 'bento-thumb-surface'
    return node
  }),
}))

import { Editor } from './editor'
import { Store } from '../store'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', NoopResizeObserver)
vi.stubGlobal('CSS', { escape: (value: string) => value })

function makeDoc(ids: string[]): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'context-menu-deck',
    title: 'Context menu deck',
    size: { width: 1280, height: 720 },
    theme: { background: '#ffffff', color: '#111111', accent: '#3b82d8', fontFamily: 'sans-serif' },
    slides: ids.map((id) => ({
      id,
      background: '#ffffff',
      transition: 'fade',
      notes: '',
      elements: [],
    })),
    modified: '2026-07-27T00:00:00.000Z',
  } as BentoDoc
}

function boot(ids = ['s1', 's2', 's3']): Store {
  const root = document.createElement('div')
  root.id = 'app'
  document.body.appendChild(root)
  const store = new Store(makeDoc(ids))
  new Editor(root, store)
  return store
}

function openMenu(index: number): HTMLElement {
  const thumb = document.querySelector<HTMLElement>(`.ed-thumb[data-index="${index}"]`)
  expect(thumb).not.toBeNull()
  thumb!.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 80,
  }))
  const menu = document.querySelector<HTMLElement>('.ed-thumb-context')
  expect(menu).not.toBeNull()
  return menu!
}

function clickAction(menu: HTMLElement, action: string): void {
  const button = menu.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
  expect(button).not.toBeNull()
  button!.click()
}

describe('幻灯片缩略图右键菜单', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('缩略图不再渲染悬浮复制和删除按钮', () => {
    boot()

    expect(document.querySelector('.ed-thumb-tools')).toBeNull()
  })

  it('右侧属性面板默认收起,仍可通过边缘按钮展开', () => {
    boot()

    const props = document.querySelector<HTMLElement>('.ed-props')
    const toggles = document.querySelectorAll<HTMLButtonElement>('.ed-panel-toggle')
    expect(props).not.toBeNull()
    expect(props!.classList.contains('ed-collapsed')).toBe(true)

    toggles[1]!.click()
    expect(props!.classList.contains('ed-collapsed')).toBe(false)
  })

  it('右键目标缩略图后显示移动、复制和删除操作', () => {
    const store = boot()

    const menu = openMenu(1)

    expect(store.currentIndex).toBe(1)
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.querySelectorAll(':scope > button[data-action], :scope > .ed-thumb-move > button[data-action]')).toHaveLength(5)
    expect(menu.querySelector('button[data-action="move-up"]')).not.toBeNull()
    expect(menu.querySelector('button[data-action="move-down"]')).not.toBeNull()
    expect(menu.querySelector('button[data-action="move-to"]')).not.toBeNull()
    expect(menu.querySelector('button[data-action="duplicate"]')).not.toBeNull()
    expect(menu.querySelector('button[data-action="delete"]')).not.toBeNull()
  })

  it('上移和下移会重排缩略图并继续选中被移动页', () => {
    const store = boot()

    clickAction(openMenu(1), 'move-up')
    expect(store.doc.slides.map((slide) => slide.id)).toEqual(['s2', 's1', 's3'])
    expect(store.currentIndex).toBe(0)

    clickAction(openMenu(0), 'move-down')
    expect(store.doc.slides.map((slide) => slide.id)).toEqual(['s1', 's2', 's3'])
    expect(store.currentIndex).toBe(1)
  })

  it('可选择任意目标页并把当前页移动到它后面', () => {
    const store = boot(['s1', 's2', 's3', 's4'])
    const menu = openMenu(0)

    clickAction(menu, 'move-to')
    const destination = menu.querySelector<HTMLButtonElement>(
      'button[data-action="move-after"][data-target-id="s3"]',
    )
    expect(destination).not.toBeNull()
    destination!.click()

    expect(store.doc.slides.map((slide) => slide.id)).toEqual(['s2', 's3', 's1', 's4'])
    expect(store.currentIndex).toBe(2)
  })

  it('复制会在目标页后插入副本并选中新页', () => {
    const store = boot()

    clickAction(openMenu(1), 'duplicate')

    expect(store.doc.slides).toHaveLength(4)
    expect(store.doc.slides[2].id).not.toBe('s2')
    expect(store.currentIndex).toBe(2)
  })

  it('删除会移除目标页并选中相邻页', () => {
    const store = boot()

    clickAction(openMenu(1), 'delete')

    expect(store.doc.slides.map((slide) => slide.id)).toEqual(['s1', 's3'])
    expect(store.currentIndex).toBe(1)
  })

  it('首尾页禁用越界移动，单页演示文稿禁用删除', () => {
    boot()
    const firstMenu = openMenu(0)
    expect(firstMenu.querySelector<HTMLButtonElement>('button[data-action="move-up"]')?.disabled).toBe(true)
    expect(firstMenu.querySelector<HTMLButtonElement>('button[data-action="move-down"]')?.disabled).toBe(false)

    document.body.innerHTML = ''
    boot(['only'])
    const onlyMenu = openMenu(0)
    expect(onlyMenu.querySelector<HTMLButtonElement>('button[data-action="move-up"]')?.disabled).toBe(true)
    expect(onlyMenu.querySelector<HTMLButtonElement>('button[data-action="move-down"]')?.disabled).toBe(true)
    expect(onlyMenu.querySelector<HTMLButtonElement>('button[data-action="delete"]')?.disabled).toBe(true)
  })

  it('右侧属性栏默认宽度增加到 256px', () => {
    boot()

    expect(document.querySelector<HTMLElement>('.ed-props')?.style.getPropertyValue('--panew')).toBe('256px')
  })
})
