// bento 化 Slides 的前端状态(Zustand,客户端态:deck 快照/gate 阶段/弹层)。
// 服务端事实(deck.bento.html + meta)在主进程;这里只持有最近一次 bentoGetDeck 快照,
// AI/编辑器写盘后经 refresh() 重新拉取。文档正文的编辑权威在 bento 编辑器 webview 内,
// 本 store 不复制编辑态,只管宿主外壳需要的元信息(标题/页数/阶段/提纲)。
import { create } from 'zustand'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import type { BentoDeckIpcError, BentoDeckStage } from '@cortex-work/core/desktop/slides-ipc-types'
import { parseBentoDoc, type BentoDoc } from '@cortex-work/core/design/slides/bento/bento-doc-schema'
import type {
  SlidesPageSnapshot,
  SlidesSelectionSnapshot
} from '@cortex-work/core/design/slides/slides-selection'
import type { SlidesOutline } from '@cortex-work/core/design/slides/slides-types'

/** 编辑器回写结果。stale 与 ok:false 的区别见 saveEditedDeckHtml 的注释。 */
export type SaveEditedDeckResult = {
  ok: boolean
  /** 写入成功后的磁盘 revision。 */
  revision?: number
  /** 磁盘已更新、本次回写被弱锁拒绝(不是错误)。 */
  stale?: boolean
}

interface BentoSlidesUiState {
  bridge: DesktopBridge | null
  workspaceRoot: string
  deckId: string
  /** 最近一次读取的文档快照(解析失败为 null,不阻断编辑器工作)。 */
  doc: BentoDoc | null
  revision: number
  stage: BentoDeckStage
  outline: SlidesOutline | null
  loading: boolean
  mutating: boolean
  deckError: BentoDeckIpcError | null
  outlineDialogOpen: boolean
  /**
   * bento 编辑器内的当前选区(SlidesStage 轮询回传)。纯运行时态、不落盘:
   * 右栏据此显示引用 chip,发送时并入 slides 回合 prompt。切 deck / 卸载时清空。
   */
  selection: SlidesSelectionSnapshot | null
  /** bento 编辑器当前页；与 selection 分离，空元素选区时仍存在。 */
  currentPage: SlidesPageSnapshot | null

  /** 挂载/切 deck:读取,不存在则用文档标题补建(设计稿索引先行的场景)。 */
  setup(options: { bridge: DesktopBridge; workspaceRoot: string; deckId: string; title: string }): Promise<void>
  refresh(): Promise<void>
  openOutlineDialog(): void
  closeOutlineDialog(): void
  /** 批准提纲:主进程持久化编辑后的提纲并建立逐页生成占位骨架。 */
  approveOutline(outline: Omit<SlidesOutline, 'approvedAt'>): Promise<boolean>
  /**
   * 编辑器 autosave 整份 HTML 落盘(SlidesStage drain 调用)。
   * baseRevision = webview 内存文档对应的磁盘 revision(弱乐观锁的输入);
   * 返回 stale:true 表示磁盘已经更新过(AI 写过盘),这份 HTML 是过期稿、已被主进程拒绝 ——
   * 调用方应当丢弃它并把舞台刷新到最新稿,**而不是**当成错误弹给用户。
   */
  saveEditedDeckHtml(html: string, baseRevision?: number): Promise<SaveEditedDeckResult>
  /** 另存为 .bento.html(交付物即文件本体)。返回 false 仅在真实失败(取消不算)。 */
  exportDeck(): Promise<boolean>
  setEditorContext(
    page: SlidesPageSnapshot | null,
    selection: SlidesSelectionSnapshot | null
  ): void
  reset(): void
}

/** meta 里的 outline 是宽松 unknown;仅在形状可用时透出给弹层。 */
function coerceOutline(outline: unknown): SlidesOutline | null {
  if (!outline || typeof outline !== 'object') return null
  const o = outline as SlidesOutline
  return Array.isArray(o.items) ? o : null
}

export const useBentoSlidesStore = create<BentoSlidesUiState>((set, get) => ({
  bridge: null,
  workspaceRoot: '',
  deckId: '',
  doc: null,
  revision: 0,
  stage: 'draft',
  outline: null,
  loading: false,
  mutating: false,
  deckError: null,
  outlineDialogOpen: false,
  selection: null,
  currentPage: null,

  async setup({ bridge, workspaceRoot, deckId, title }) {
    // doc 先清空:SlidesWorkspace 以「doc 就绪」gate 舞台挂载 —— deck 文件可能尚在
    // 主进程补建中,残留上一稿的 doc 会让 webview 提前对不存在的文件发起授权(竞态)。
    // selection 一并清空:上一稿的选区绝不能带进新 deck(会让右栏引用指向不存在的元素)。
    set({ bridge, workspaceRoot, deckId, doc: null, revision: 0, outline: null, loading: true, deckError: null, outlineDialogOpen: false, selection: null, currentPage: null })
    if (!bridge.slidesBentoGetDeck || !bridge.slidesBentoCreateDeck) {
      set({ loading: false, deckError: { code: 'io_error', message: 'bento slides 桥不可用(桌面端专属能力)' } })
      return
    }
    let res = await bridge.slidesBentoGetDeck({ workspaceRoot, deckId })
    if (!res.ok && res.error.code === 'not_found') {
      // 设计稿索引已存在但 deck 目录缺失(新建流程/手动删除):就地补建。
      const created = await bridge.slidesBentoCreateDeck({ workspaceRoot, deckId, title })
      if (!created.ok && created.error.code !== 'already_exists') {
        set({ loading: false, deckError: created.error })
        return
      }
      res = await bridge.slidesBentoGetDeck({ workspaceRoot, deckId })
    }
    if (!res.ok) {
      set({ loading: false, deckError: res.error })
      return
    }
    applyDeckSnapshot(set, res)
  },

  async refresh() {
    const { bridge, workspaceRoot, deckId } = get()
    if (!bridge?.slidesBentoGetDeck || !workspaceRoot || !deckId) return
    const res = await bridge.slidesBentoGetDeck({ workspaceRoot, deckId })
    if (!res.ok) {
      set({ loading: false, deckError: res.error })
      return
    }
    applyDeckSnapshot(set, res)
  },

  openOutlineDialog() {
    set({ outlineDialogOpen: true })
  },
  closeOutlineDialog() {
    set({ outlineDialogOpen: false })
  },

  async approveOutline(outline) {
    const { bridge, workspaceRoot, deckId } = get()
    if (!bridge?.slidesBentoSetStage) return false
    set({ mutating: true })
    const res = await bridge.slidesBentoSetStage({
      workspaceRoot,
      deckId,
      stage: 'outline-approved',
      outline
    })
    set({ mutating: false })
    if (!res.ok) {
      set({ deckError: res.error })
      return false
    }
    set({ revision: res.revision, stage: 'outline-approved', outlineDialogOpen: false })
    return true
  },

  async saveEditedDeckHtml(html, baseRevision) {
    const { bridge, workspaceRoot, deckId } = get()
    if (!bridge?.slidesBentoWriteDeckHtml) return { ok: false }
    const res = await bridge.slidesBentoWriteDeckHtml({
      workspaceRoot,
      deckId,
      html,
      ...(baseRevision === undefined ? {} : { baseRevision })
    })
    if (!res.ok) {
      // revision_conflict 不是失败:webview 持的是过期稿(AI 刚写过盘),主进程拒写是对的。
      // 报红只会让用户以为「存不进去了」,真正该做的是丢弃这份 HTML 并刷新到最新稿。
      if (res.error.code === 'revision_conflict') return { ok: false, stale: true }
      // 其余失败要浮出(磁盘满/权限),但不打断编辑器 —— 下一次变更会重试。
      set({ deckError: res.error })
      return { ok: false }
    }
    set({ revision: res.revision, deckError: null })
    return { ok: true, revision: res.revision }
  },

  async exportDeck() {
    const { bridge, workspaceRoot, deckId } = get()
    if (!bridge?.slidesBentoExportFile) return false
    set({ mutating: true })
    const res = await bridge.slidesBentoExportFile({ workspaceRoot, deckId })
    set({ mutating: false })
    if (!res.ok && !res.canceled && res.error) {
      set({ deckError: res.error })
      return false
    }
    return true
  },

  setEditorContext(page, selection) {
    set({ currentPage: page, selection })
  },

  reset() {
    set({
      bridge: null,
      workspaceRoot: '',
      deckId: '',
      doc: null,
      revision: 0,
      stage: 'draft',
      outline: null,
      loading: false,
      mutating: false,
      deckError: null,
      outlineDialogOpen: false,
      selection: null,
      currentPage: null
    })
  }
}))

type SetState = (partial: Partial<BentoSlidesUiState>) => void

function applyDeckSnapshot(
  set: SetState,
  res: { ok: true; json: string | null; revision: number; stage: BentoDeckStage; outline: unknown }
): void {
  let doc: BentoDoc | null = null
  if (res.json) {
    try {
      const parsed = parseBentoDoc(JSON.parse(res.json))
      doc = parsed.ok ? parsed.doc : null
    } catch {
      doc = null
    }
  }
  set({ doc, revision: res.revision, stage: res.stage, outline: coerceOutline(res.outline), loading: false, deckError: null })
}
