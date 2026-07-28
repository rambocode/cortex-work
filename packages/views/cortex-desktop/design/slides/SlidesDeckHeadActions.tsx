// 演示文稿在「会话产物」右栏顶部那一行的标题与操作(播放 / 导出)。
//
// 为什么不复用 SlidesToolbar:产物面板的宿主(PersonalRightPanel)本来就有一条顶栏,
// 再叠一条工具栏等于同一屏里两行标题、白吃 38px 高度(用户反馈)。这里只出标题与两个动作,
// 塞进宿主顶栏;左侧栏折叠按钮与设计助手开关不带过来 —— 产物面板里两者都无处可开。
//
// 组件自足(不收 props):deck 坐标与桥都在 bento store 里,宿主不必了解 slides 的内部结构。
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Play } from 'lucide-react'
import { useBentoSlidesStore } from './bento-slides-store'

/** 会话产物顶栏用:deck 标题 + 播放/导出。fallbackTitle 用于 deck 尚未读出时(会话产物标题)。 */
export function SlidesDeckHeadActions({ fallbackTitle }: { fallbackTitle?: string }): ReactElement {
  const { t } = useTranslation('design')
  const doc = useBentoSlidesStore((s) => s.doc)
  const mutating = useBentoSlidesStore((s) => s.mutating)
  const exportDeck = useBentoSlidesStore((s) => s.exportDeck)
  const presentDeck = useBentoSlidesStore((s) => s.presentDeck)
  const [exporting, setExporting] = useState(false)

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    await exportDeck()
    setExporting(false)
  }

  return (
    <>
      <span className="pw-col-head-title min-w-0 flex-1 truncate">{doc?.title || fallbackTitle || ''}</span>
      <button
        type="button"
        onClick={presentDeck}
        disabled={!doc}
        title={t('slidesPlay')}
        data-testid="slides-play"
        className="pw-rp-head-action"
      >
        <Play size={13} strokeWidth={1.9} />
        <span>{t('slidesPlay')}</span>
      </button>
      <button
        type="button"
        onClick={() => void handleExport()}
        disabled={!doc || mutating || exporting}
        title={t('slidesExport')}
        data-testid="slides-export"
        className="pw-rp-head-action"
      >
        {exporting ? <Loader2 size={13} className="animate-spin" strokeWidth={1.9} /> : <Download size={13} strokeWidth={1.9} />}
        <span>{exporting ? t('slidesExporting') : t('slidesExport')}</span>
      </button>
    </>
  )
}
