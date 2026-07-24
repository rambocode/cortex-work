// bento 化 Slides 的前端状态(Zustand,客户端态:deck 快照/gate 阶段/弹层)。
// 服务端事实(deck.bento.html + meta)在主进程;这里只持有最近一次 bentoGetDeck 快照,
// AI/编辑器写盘后经 refresh() 重新拉取。文档正文的编辑权威在 bento 编辑器 webview 内,
// 本 store 不复制编辑态,只管宿主外壳需要的元信息(标题/页数/阶段/提纲)。
import { create } from 'zustand'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import type { BentoDeckIpcError, BentoDeckStage } from '@cortex-work/core/desktop/slides-ipc-types'
import { parseBentoDoc, type BentoDoc } from '@cortex-work/core/design/slides/bento/bento-doc-schema'
import type { SlidesOutline } from '@cortex-work/core/design/slides/slides-types'

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

  /** 挂载/切 deck:读取,不存在则用文档标题补建(设计稿索引先行的场景)。 */
  setup(options: { bridge: DesktopBridge; workspaceRoot: string; deckId: string; title: string }): Promise<void>
  refresh(): Promise<void>
  openOutlineDialog(): void
  closeOutlineDialog(): void
  /** 批准提纲:gate 推进到 outline-approved;编辑后的提纲随生成指令进入对话(不回写 meta)。 */
  approveOutline(outline: Omit<SlidesOutline, 'approvedAt'>): Promise<boolean>
  /** 编辑器 autosave 整份 HTML 落盘(SlidesStage drain 调用)。 */
  saveEditedDeckHtml(html: string): Promise<boolean>
  /** 另存为 .bento.html(交付物即文件本体)。返回 false 仅在真实失败(取消不算)。 */
  exportDeck(): Promise<boolean>
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

  async setup({ bridge, workspaceRoot, deckId, title }) {
    // doc 先清空:SlidesWorkspace 以「doc 就绪」gate 舞台挂载 —— deck 文件可能尚在
    // 主进程补建中,残留上一稿的 doc 会让 webview 提前对不存在的文件发起授权(竞态)。
    set({ bridge, workspaceRoot, deckId, doc: null, revision: 0, outline: null, loading: true, deckError: null, outlineDialogOpen: false })
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

  async approveOutline() {
    const { bridge, workspaceRoot, deckId } = get()
    if (!bridge?.slidesBentoSetStage) return false
    set({ mutating: true })
    const res = await bridge.slidesBentoSetStage({ workspaceRoot, deckId, stage: 'outline-approved' })
    set({ mutating: false })
    if (!res.ok) {
      set({ deckError: res.error })
      return false
    }
    set({ stage: 'outline-approved', outlineDialogOpen: false })
    return true
  },

  async saveEditedDeckHtml(html) {
    const { bridge, workspaceRoot, deckId } = get()
    if (!bridge?.slidesBentoWriteDeckHtml) return false
    const res = await bridge.slidesBentoWriteDeckHtml({ workspaceRoot, deckId, html })
    if (!res.ok) {
      // 编辑落盘失败要浮出(磁盘满/权限),但不打断编辑器 —— 下一次变更会重试。
      set({ deckError: res.error })
      return false
    }
    set({ revision: res.revision, deckError: null })
    return true
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
      outlineDialogOpen: false
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
