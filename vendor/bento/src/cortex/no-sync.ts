// CORTEX-PATCH file — 与 SyncSession 同形状的「零协作」空壳。
//
// 为什么需要它:上游 SyncSession 的构造函数就会 attach() 并给**没有 collab 字段**的文档
// 自动铸造协作凭据(sync/online.ts 的 mintCollab,on:true,room 指向公共中继
// wss://sync.bento.page),再写进 .bento.html。此后每次打开都 since=0 全量重放房间历史,
// 而 CRDT 的 mergeSnapshot 对页/元素是**并集**语义 —— AI 经磁盘写入的元素在
// SyncState.adopt 里只拿到 null register("loses to every real op"),逐字段全输。
// 用户看到的就是「新旧内容重贴在一起」,并且 deck 内容会被上传到第三方中继。
//
// Cortex Desktop 的 deck 是**单机单编辑器**的:一个 deck 只有一个 editor webview
// (放映窗走 cortex/present-modes 的 tryCortexPresentBoot 提前 return,从不建 Store),
// 真源在磁盘、协调由主进程的 revision 乐观锁负责。整套 CRDT 与中继对我们零收益、全是风险,
// 因此这里把会话整体空转:不建传输、不铸凭据、不写 CRDT 状态。
//
// 刻意保留 src/sync/* 源码不删,只断引用 —— 跟上游 diff 时代价最小。
import type { Store } from '../store'
import type { SyncSession } from '../sync/session'

/**
 * 造一个不做任何同步的 SyncSession 替身。
 *
 * 末尾的 `as unknown as SyncSession` 让 editor.ts / sync/online.ts 的类型零改动。
 * 断言的安全性依据:**shareEligible() 恒 false**,而上游所有真正会建立网络连接的
 * 入口都在它后面 ——
 *   - Editor.tryJoin() 先判 `this.session.shareEligible()` → joinFromDoc 不可达;
 *   - goLive() / startSharing() / rotateKeys() 只挂在 Share 面板上,而该面板的
 *     DOM 节点在 build() 里已不再 append 进工具栏(见 editor.ts 的 CORTEX-PATCH),
 *     用户点不到;
 *   - disconnectOnline() / stopSharing() 都先判 online.ts 的模块级 `active`,
 *     没有传输就直接 return —— 我们从不 addTransport,所以永远为 null。
 * 因此空壳上未实现的成员(addTransport/removeTransport/applyRemote…)全部不可达;
 * 下面仍为「经守卫可达」的那几个补了 no-op,免得上游哪天放松守卫就变成 TypeError。
 */
export function createNoSyncSession(store: Store): SyncSession {
  const shell = {
    // 诊断用的稳定本机标识。没有 peer,也就不需要上游的 per-tab actor 协商。
    actor: 'cortex-local',
    // 无 CRDT 状态。已 grep 核对:src/ 内除 src/sync/ 自身外没有任何 `.state` 访问点,
    // 字段只为形状对齐保留。
    state: null,

    // --- presence:永远只有你自己 ---
    peers: () => [],
    /** 契约上必须返回退订函数(editor.connectSync 会持有它)。 */
    onPeers: (_fn: () => void) => () => {},
    setEditing: () => {},
    pushPresence: () => {},

    // --- 分享资格:恒 false,这是整份断言的支点 ---
    shareEligible: () => false,
    /** 上游在 save() 成功后无条件调它「保存即上线」;这里刻意让它不改变任何状态。 */
    enableSharing: () => {},

    // --- 传输:一条都不建 ---
    get transportKinds(): string[] {
      return []
    },
    addTransport: () => null,
    removeTransport: () => {},

    // --- 帧收发:全部空转 ---
    flush: () => {},
    hello: () => {},
    applyRemote: () => {},
    applySnapshot: () => {},
    /** 返回 false = 「不需要上传新快照」。 */
    onRelayReady: () => false,
    /** 只在 online.ts 的快照上传路径被调,而那条路径不可达;返回当前文档保持形状。 */
    snapshot: () => ({ doc: store.doc, state: null }),

    /**
     * **空实现是本补丁的核心之一**:上游会在每次 serialize/save 时把 CRDT 状态
     * 烙进 doc.collab.sync,那份状态正是「重开后全量重放并集合并」的燃料。
     * 我们既不产生也不保存它。主进程侧还会再剥一层 collab(sanitizeDeckDoc)。
     */
    stampInto: () => {},
  }
  return shell as unknown as SyncSession
}
