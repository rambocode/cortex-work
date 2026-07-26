// CORTEX-PATCH file — 宿主「热应用」入口。
//
// AI 改稿写盘后,宿主(SlidesStage)拿到 slides:deckChanged 广播,读回新的 #bento-doc,
// 经 executeJavaScript 调 window.__cortexApplyDeckDoc(json, revision) 就地换文档。
// 这样做而不是重载 webview,是为了保住**选区、撤销栈与滚动/缩放状态** —— 13 页分批改稿
// 会触发十几次刷新,每次重载都闪屏、跳回第 1 页、清空撤销栈。
//
// 返回 false 时宿主回落到「整页重载」,所以本文件的失败路径必须是零副作用的。
import { parseDoc } from '../model'
import { injectFonts } from '../fonts'
import type { Store } from '../store'
import type { Editor } from '../editor/editor'
import { beginHostApply, endHostApply } from './host-bridge'

/** 挂在 window 上的宿主契约(镜像见 views/design/slides/bento-stage-bridge.ts)。 */
interface ApplyDocWindow {
  /** 用整份文档 JSON 替换当前 deck;revision 为该 JSON 对应的磁盘 meta.revision。 */
  __cortexApplyDeckDoc?: (json: string, revision: number) => boolean
  /** 诊断/竞态排查用:webview 内存文档当前对应的磁盘 revision。 */
  __cortexAppliedDeckRevision?: number
}

/**
 * 注册热应用入口。浏览器环境下也只是挂一个函数,无副作用。
 *
 * 关于渲染时机的已知限制:canvas.render() 在**内联编辑进行中**会推迟重绘
 * (见 editor/canvas.ts 的 `if (this.editing) { this.pendingRender = true; return }`
 * —— 上游刻意防止远端改动抢走正在打字的焦点/光标)。因此如果用户此刻正在某个文本框里
 * 打字,画面要等编辑提交后才追上新文档。数据已经换掉了,只是像素晚到,可接受。
 */
export function initCortexApplyDoc(store: Store, editor: Editor): void {
  const win = window as unknown as ApplyDocWindow
  let lastAppliedRevision: number | null = null

  win.__cortexApplyDeckDoc = (json: string, revision: number): boolean => {
    const next = parseDoc(json)
    if (!next) return false // 宿主据此回落 webview 重载

    // 幂等短路:同一 revision 且文档自上次应用后未被改动过(revision 就是内容的身份证)。
    // 必须同时判 !dirty —— 只比 revision 会在「应用后用户又改了、宿主重发同一 revision」
    // 时静默丢掉用户的编辑。
    if (lastAppliedRevision === revision && !store.dirty) return true

    // 记住用户的视角:replaceDoc 会把 currentIndex 归零、selection 清空。
    const prevIndex = store.currentIndex
    const prevSelection = store.selection.slice()

    beginHostApply()
    try {
      // **刻意走 checkpoint**(replaceDoc 内部 checkpoint + 整份快照入 undo 栈):
      // ⌘Z 是「热应用覆盖了我还没落盘的编辑」唯一也足够的救命通道。
      store.replaceDoc(next)

      // @font-face 只在 boot 注入一次,replaceDoc 覆盖不到 —— 不补就是字体静默失效
      // (新文档里引用了新字体资产时,文字会退回系统兜底字形)。
      injectFonts(next)

      // 恢复视角:页码 clamp 到新页数,选区丢掉已不存在的 id。
      // 顺序要紧 —— store.element() 走 doc.slides[currentIndex],必须先把页码定好。
      store.currentIndex = Math.max(0, Math.min(prevIndex, next.slides.length - 1))
      store.selection = prevSelection.filter((id) => store.element(id))
      store.hoverPreview = null // 悬停预览是上一份文档的运行时态,不跟着走
      store.emit('current')
      store.emit('selection')

      editor.cortexAfterHostApply()
      lastAppliedRevision = revision
      win.__cortexAppliedDeckRevision = revision
      return true
    } finally {
      // 无论中途哪一步抛,闸门都必须放开,否则此后用户的编辑再也回写不到磁盘。
      endHostApply()
    }
  }
}
