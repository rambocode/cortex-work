// SlidesStage 收到 slides:deckChanged 之后「该做什么」的纯判定,抽出来是为了能单测 ——
// webview 的 dom-ready / loadURL 真实时序无法在 jsdom 里复现,只有决策本身可测。
//
// revision 空间警告(三套,绝不可混用):
//   R_disk = deck.meta.json 的 meta.revision —— 磁盘权威内容版本,事件里带的就是它;
//   R_page = webview 内存文档对应的那个 R_disk(SlidesStage 维护);
//   useDesignHtmlPreview 内部的 revision —— watcher 本地计数器,从 0 起,与上面两个无关。
// 本模块的两个入参都属于 R_disk 空间。

export type SlidesRefreshDecision = 'ignore' | 'refresh' | 'defer'

/**
 * 收到 deckChanged 后的动作:
 *  - 'ignore':事件 revision 不比页面持有的版本新 —— 即自己刚落盘的回声。
 *    这里刻意不做内容 hash 比对(writing/baseline.ts 那套):revision 就是内容身份证,
 *    有服务端版本号时它比 hash 更强(能分清「同内容的两次写」)也更便宜(不读整份 HTML)。
 *  - 'defer':有更新的版本,但刷新/热应用正在进行 —— 排队,由 mergeDeferredRevision 合并。
 *  - 'refresh':有更新的版本且空闲,立即刷新。
 */
export function slidesRefreshDecision(input: {
  eventRevision: number
  pageRevision: number
  busy: boolean
}): SlidesRefreshDecision {
  if (input.eventRevision <= input.pageRevision) return 'ignore'
  if (input.busy) return 'defer'
  return 'refresh'
}

/**
 * 把 busy 期间堆积的多条 deckChanged 合并成一次刷新的目标 revision。
 * 分批改稿会连发十几条事件,逐条跑等于连刷十几次;只认最新的那一版即可,
 * 因为磁盘是唯一真源、新版本已包含旧版本的内容。取 max 而非直接覆盖:
 * 事件到达顺序不保证单调(广播与 IPC 队列各自调度),不能把已排队的新版降级。
 */
export function mergeDeferredRevision(pending: number | null, incoming: number): number {
  if (pending === null) return incoming
  return Math.max(pending, incoming)
}

/**
 * 首帧 / 切 deck 时 R_page 的对齐决策。返回 null 表示**不要动 R_page**。
 *
 * 为什么需要「只对齐一次」这条规则(实现时踩过):store 的 revision 除了首帧读回,
 * 还会被 SlidesWorkspace 在 AI 回合期间每 2s 的轮询刷新推到磁盘最新值。若 R_page 跟着它走,
 * 就会在 webview 尚未应用新内容时先"追平"磁盘,紧随其后的 deckChanged 便被
 * slidesRefreshDecision 判成自写回声丢弃 —— 症状与本次要修的 bug 一模一样:画布不刷新。
 */
export function slidesPageRevisionAlignment(input: {
  deckId: string
  /** 已完成对齐的 deckId(尚未对齐过时为空串)。 */
  alignedDeckId: string
  storeRevision: number
}): { pageRevision: number; markAligned: boolean } | null {
  if (input.alignedDeckId === input.deckId) return null
  // setup() 会先把 revision 归 0,真实值随后到达;0 视为「还没读回来」,先归零继续等。
  if (input.storeRevision <= 0) return { pageRevision: 0, markAligned: false }
  return { pageRevision: input.storeRevision, markAligned: true }
}
