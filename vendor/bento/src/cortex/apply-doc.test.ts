// @vitest-environment jsdom
// CORTEX-PATCH file — 宿主热应用(window.__cortexApplyDeckDoc)的行为契约。
//
// 这组用例守的是「AI 改稿落盘后画布就地换文档」这条通路的三条红线:
//   1. 坏输入零副作用(宿主据此回落 webview 重载);
//   2. 换文档不丢用户视角(页码/选区)、不留脏标记、不触发宿主回写;
//   3. ⌘Z 一次能退回应用前的文档 —— 这是「热应用覆盖了我未落盘的编辑」唯一救命通道。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BentoDoc } from '../model'

// 替身集合走 vi.hoisted:vi.mock 的 factory 会被提升到文件顶部,直接引用普通
// top-level const 会撞上 TDZ(Cannot access before initialization)。
const mocks = vi.hoisted(() => ({
  // autosave 整体替身:既为断言「宿主在场时 recovery 通路零调用」提供计数器,
  // 也因为真实实现要开 IndexedDB(jsdom 下不可用)。
  addVersion: vi.fn(async () => {}),
  clearRecovery: vi.fn(async () => {}),
  clearVersions: vi.fn(async () => {}),
  docContentKey: vi.fn(() => 'content-key'),
  getRecovery: vi.fn(async () => null),
  listVersions: vi.fn(async () => []),
  pruneOld: vi.fn(async () => {}),
  putRecovery: vi.fn(async () => {}),
  // host-bridge 的落盘走 serializeAuto,真实实现依赖 boot 期的 capturePristine();
  // 这里只需要它「被调用过没有」这一个信号。
  serializeAuto: vi.fn(async () => '<html>deck</html>'),
  // 字体注入:replaceDoc 覆盖不到 @font-face,apply-doc 必须自己补一次。
  injectFonts: vi.fn(),
}))

vi.mock('../autosave', () => ({
  addVersion: mocks.addVersion,
  clearRecovery: mocks.clearRecovery,
  clearVersions: mocks.clearVersions,
  docContentKey: mocks.docContentKey,
  getRecovery: mocks.getRecovery,
  listVersions: mocks.listVersions,
  pruneOld: mocks.pruneOld,
  putRecovery: mocks.putRecovery,
}))

vi.mock('../save', () => ({
  hasFileHandle: () => false,
  isEncryptionActive: () => false,
  saveFile: vi.fn(async () => 'saved'),
  serializeAuto: mocks.serializeAuto,
  serializeFile: vi.fn(() => '<html>deck</html>'),
  setEncryptionPassword: vi.fn(),
  writeUpdatedFile: vi.fn(async () => {}),
  writeUpdatedFileAs: vi.fn(async () => true),
}))

// fonts 只**部分**替身:panels.ts 还从这里取 firstFamily 等真实工具函数,
// 整体替换会让属性面板在 selection 事件里炸掉。
vi.mock('../fonts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fonts')>()),
  injectFonts: mocks.injectFonts,
}))

// 渲染层替身:jsdom 下不需要真实 slide DOM,只要 canvas 能挂上节点。
vi.mock('../render', () => ({
  renderSlide: vi.fn(() => {
    const node = document.createElement('div')
    node.className = 'bento-slide'
    return node
  }),
  renderThumbnail: vi.fn(() => document.createElement('div')),
}))

import { Store } from '../store'
import { Editor } from '../editor/editor'
import { initCortexApplyDoc } from './apply-doc'
import { initCortexHostBridge } from './host-bridge'
import { createNoSyncSession } from './no-sync'

interface ApplyWindow {
  __cortexApplyDeckDoc?: (json: string, revision: number) => boolean
  cortexSlidesHost?: { save: (html: string) => void }
}

/** 造一份最小合法 deck:slides 为 [id, 元素 id 列表] 的二元组。 */
function makeDoc(docId: string, slides: Array<[string, string[]]>): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId,
    title: docId,
    size: { width: 1280, height: 720 },
    theme: { background: '#ffffff', color: '#111111', accent: '#3b82d8', fontFamily: 'sans-serif' },
    slides: slides.map(([id, elementIds]) => ({
      id,
      background: '#ffffff',
      transition: 'fade',
      elements: elementIds.map((elId, i) => ({
        id: elId,
        type: 'text',
        x: 0,
        y: i * 100,
        w: 200,
        h: 80,
        html: elId,
      })),
    })),
    modified: '2026-07-26T00:00:00.000Z',
  } as unknown as BentoDoc
}

const hostSave = vi.fn()

// jsdom 没有 ResizeObserver,而 SlideCanvas 构造时就 observe 画布容器做自适应布局。
// 这里只需要构造不抛;真实的布局回调在无视口的测试环境里没有意义。
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)
// jsdom 不提供 CSS.escape,而 canvas 在 'selection' 事件里用它拼 [data-el-id] 选择器。
// 测试里的 id 都是简单标识符,原样返回即等价。
vi.stubGlobal('CSS', { escape: (value: string) => value })

/**
 * 装一套「宿主在场」的完整运行时:host 注入必须早于 Editor 构造,
 * 否则 wireAutosave 看不到 cortexHost() 就走不进关 recovery 的分支。
 */
function boot(doc: BentoDoc): { store: Store; editor: Editor; apply: (json: string, revision: number) => boolean } {
  ;(window as unknown as ApplyWindow).cortexSlidesHost = { save: hostSave }
  const store = new Store(doc)
  const root = document.createElement('div')
  root.id = 'app'
  document.body.appendChild(root)
  const editor = new Editor(root, store)
  editor.connectSync(createNoSyncSession(store))
  initCortexHostBridge(store)
  initCortexApplyDoc(store, editor)
  const apply = (window as unknown as ApplyWindow).__cortexApplyDeckDoc!
  return { store, editor, apply }
}

describe('window.__cortexApplyDeckDoc — 宿主热应用', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as ApplyWindow).__cortexApplyDeckDoc
    delete (window as unknown as ApplyWindow).cortexSlidesHost
  })

  it('挂载后暴露 window.__cortexApplyDeckDoc', () => {
    boot(makeDoc('deck-1', [['s1', ['a']]]))
    expect(typeof (window as unknown as ApplyWindow).__cortexApplyDeckDoc).toBe('function')
  })

  it('坏 JSON 返回 false 且文档/脏标记完全不变', () => {
    const { store, apply } = boot(makeDoc('deck-1', [['s1', ['a']]]))
    const before = store.doc
    expect(apply('{ not json', 7)).toBe(false)
    expect(apply(JSON.stringify({ format: 'not/bento', slides: [] }), 7)).toBe(false)
    expect(store.doc).toBe(before)
    expect(store.dirty).toBe(false)
  })

  it('好 JSON 换新文档并把当前页码 clamp 到新页数范围内', () => {
    const { store, apply } = boot(
      makeDoc('deck-1', [['s1', ['a']], ['s2', ['b']], ['s3', ['c']], ['s4', ['d']], ['s5', ['e']]]),
    )
    store.goTo(4)
    const next = makeDoc('deck-1', [['n1', ['x']], ['n2', ['y']]])

    expect(apply(JSON.stringify(next), 12)).toBe(true)

    expect(store.doc.slides.map((s) => s.id)).toEqual(['n1', 'n2'])
    expect(store.currentIndex).toBe(1)
  })

  it('保留仍存在的选区、过滤掉新文档里已消失的选区 id', () => {
    const { store, apply } = boot(makeDoc('deck-1', [['s1', ['keep', 'gone']]]))
    store.select(['keep', 'gone'])
    const next = makeDoc('deck-1', [['s1', ['keep', 'fresh']]])

    expect(apply(JSON.stringify(next), 12)).toBe(true)

    expect(store.selection).toEqual(['keep'])
    expect(store.hoverPreview).toBeNull()
  })

  it('补注入新文档的 @font-face —— replaceDoc 覆盖不到字体表', () => {
    const { apply } = boot(makeDoc('deck-1', [['s1', ['a']]]))
    mocks.injectFonts.mockClear()
    const next = makeDoc('deck-1', [['n1', ['x']]])

    apply(JSON.stringify(next), 12)

    expect(mocks.injectFonts).toHaveBeenCalledTimes(1)
    expect(mocks.injectFonts.mock.calls[0][0]).toMatchObject({ slides: [{ id: 'n1' }] })
  })

  it('应用后不留脏标记,且应用期间的 doc 事件不触发宿主落盘', async () => {
    vi.useFakeTimers()
    const { store, apply } = boot(makeDoc('deck-1', [['s1', ['a']]]))
    hostSave.mockClear()
    mocks.serializeAuto.mockClear()

    apply(JSON.stringify(makeDoc('deck-1', [['n1', ['x']]])), 12)

    expect(store.dirty).toBe(false)
    // 越过 host-bridge 的 600ms 静默窗与 editor 的 2500ms autosave 窗
    await vi.advanceTimersByTimeAsync(4000)
    expect(mocks.serializeAuto).not.toHaveBeenCalled()
    expect(hostSave).not.toHaveBeenCalled()
  })

  it('应用后用户的下一笔编辑仍然会正常回写宿主(闸门不粘住)', async () => {
    vi.useFakeTimers()
    const { store, apply } = boot(makeDoc('deck-1', [['s1', ['a']]]))
    apply(JSON.stringify(makeDoc('deck-1', [['n1', ['x']]])), 12)
    hostSave.mockClear()

    store.commit(() => {
      store.doc.title = 'edited by user'
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(hostSave).toHaveBeenCalledTimes(1)
  })

  it('undo 一次即回到应用前的文档', () => {
    const { store, apply } = boot(makeDoc('deck-1', [['s1', ['a']], ['s2', ['b']]]))
    apply(JSON.stringify(makeDoc('deck-1', [['n1', ['x']]])), 12)
    expect(store.doc.slides.map((s) => s.id)).toEqual(['n1'])

    store.undo()

    expect(store.doc.slides.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('宿主在场时 recovery 通路零调用:既不读快照也不写快照', async () => {
    vi.useFakeTimers()
    const { store, apply } = boot(makeDoc('deck-1', [['s1', ['a']]]))

    apply(JSON.stringify(makeDoc('deck-1', [['n1', ['x']]])), 12)
    store.commit(() => {
      store.doc.title = 'typing'
    })
    await vi.advanceTimersByTimeAsync(5000)

    expect(mocks.getRecovery).not.toHaveBeenCalled()
    expect(mocks.putRecovery).not.toHaveBeenCalled()
    // 版本历史必须保留 —— 它是「热应用覆盖了我的编辑」的第二条找回途径
    expect(mocks.clearRecovery).toHaveBeenCalledWith('deck-1')
    expect(mocks.addVersion).toHaveBeenCalled()
  })

  it('同一 revision 在文档未被改动时重复应用是幂等的,不再压 undo 检查点', () => {
    const { store, apply } = boot(makeDoc('deck-1', [['s1', ['a']], ['s2', ['b']]]))
    const json = JSON.stringify(makeDoc('deck-1', [['n1', ['x']]]))

    expect(apply(json, 12)).toBe(true)
    const applied = store.doc
    expect(apply(json, 12)).toBe(true)
    expect(store.doc).toBe(applied)

    store.undo()
    expect(store.doc.slides.map((s) => s.id)).toEqual(['s1', 's2'])
  })
})

describe('createNoSyncSession — 空壳协作会话', () => {
  it('永不 share-eligible,即使 enableSharing 被调用', () => {
    const session = createNoSyncSession(new Store(makeDoc('deck-1', [['s1', ['a']]])))
    expect(session.shareEligible()).toBe(false)
    session.enableSharing()
    expect(session.shareEligible()).toBe(false)
  })

  it('没有 peer、没有 transport,onPeers 返回可调用的退订函数', () => {
    const session = createNoSyncSession(new Store(makeDoc('deck-1', [['s1', ['a']]])))
    expect(session.peers()).toEqual([])
    expect(session.transportKinds).toEqual([])
    expect(() => session.onPeers(() => {})()).not.toThrow()
  })

  it('stampInto 不再往 doc.collab.sync 写 CRDT 状态', () => {
    const doc = makeDoc('deck-1', [['s1', ['a']]])
    ;(doc as unknown as { collab: { on: boolean } }).collab = { on: true }
    const session = createNoSyncSession(new Store(doc))

    session.stampInto(doc)

    expect((doc as unknown as { collab: { sync?: unknown } }).collab.sync).toBeUndefined()
  })
})
