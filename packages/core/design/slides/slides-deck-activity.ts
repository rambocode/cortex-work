/**
 * deck 变更事件 → 会话时间线活动条(纯函数)。
 *
 * 为什么需要:AI 改稿全程只在磁盘上发生,右栏此前只能看到工具芯片(而 codex 把所有 MCP
 * 调用都叫 "MCP")。把主进程算好的「改了第几页 / 到了哪个 revision」直接落成时间线条目,
 * 过程就不再依赖 agent 自述,也不受工具名归一化的影响。
 */

import type { SlidesDeckChangedEvent } from '../../desktop/slides-ipc-types'

/** 折尾阈值:页码段超过这么多就写「等 N 页」,免得一行被撑破。 */
const MAX_PAGE_SEGMENTS = 5

/** 去掉尾部斜杠(不动根路径 '/')。 */
function normalizeRoot(root: string): string {
  const trimmed = root.trim()
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

/**
 * 事件是否属于当前打开的 deck。
 *
 * workspaceRoot 两端可能一侧是 realpath(主进程会 realpath,渲染端拿的是用户选择的原始路径,
 * macOS 上 /var → /private/var 之类),所以先归一化再比,不等时退化为「一方是另一方的后缀」——
 * 宁可多匹配一次(代价只是多刷一次)也不要漏掉真实变更。deckId 必须严格相等,绝不放宽。
 */
export function matchesSlidesDeckChange(
  event: Pick<SlidesDeckChangedEvent, 'workspaceRoot' | 'deckId'>,
  target: { workspaceRoot: string; deckId: string }
): boolean {
  if (!target.deckId || !target.workspaceRoot) return false
  if (event.deckId !== target.deckId) return false
  const a = normalizeRoot(event.workspaceRoot)
  const b = normalizeRoot(target.workspaceRoot)
  if (!a || !b) return false
  return a === b || a.endsWith(b) || b.endsWith(a)
}

/**
 * 时间线条目 id:同一 deck 的同一 revision 只出现一条。
 * 广播可能因多窗口/重复订阅到达多次,而 chat 镜像的 pushBlock 是纯 append 不去重。
 */
export function slidesDeckActivityBlockId(
  event: Pick<SlidesDeckChangedEvent, 'deckId' | 'revision'>
): string {
  return `slides-act:${event.deckId}:${event.revision}`
}

/** 把 1 基页码压成人类可读片段:连续段折叠为 3–6,乱序/重复先排序去重。 */
function formatPages(pages: number[]): string {
  const sorted = [...new Set(pages.filter((p) => Number.isInteger(p) && p > 0))].sort((a, b) => a - b)
  if (!sorted.length) return ''
  const segments: string[] = []
  let start = sorted[0]!
  let prev = start
  for (const page of sorted.slice(1)) {
    if (page === prev + 1) {
      prev = page
      continue
    }
    segments.push(start === prev ? `${start}` : `${start}–${prev}`)
    start = page
    prev = page
  }
  segments.push(start === prev ? `${start}` : `${start}–${prev}`)
  if (segments.length > MAX_PAGE_SEGMENTS) {
    return `${segments.slice(0, MAX_PAGE_SEGMENTS).join('、')}页等 ${sorted.length} 页`
  }
  return `${segments.join('、')}页`
}

/**
 * 活动条文案。返回 null 表示这条事件不该进时间线。
 *
 * 只播报 agent 的写入:编辑器 autosave(source='editor')是用户自己的操作,
 * 换壳/清洗(source='runtime')是宿主维护动作,都写进时间线只会造成噪音。
 */
export function formatSlidesDeckActivity(event: SlidesDeckChangedEvent): string | null {
  if (event.source !== 'agent') return null
  const pages = formatPages(event.pages ?? [])
  if (pages) return `已更新 第${pages} · rev ${event.revision}`
  if (event.slideCount > 0) return `已重写全篇 ${event.slideCount} 页 · rev ${event.revision}`
  return `已重写演示文稿 · rev ${event.revision}`
}
