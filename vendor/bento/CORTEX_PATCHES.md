# Cortex 对 vendored bento 的补丁点清单

上游:https://github.com/nyblnet/bento (MIT)
vendored 内容:上游仓库 `slides/` 子目录(不含 `server/`、`plugins/`、`site-src/`)
  + 根 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`scripts/postbuild-compress.mjs`、`docs/agents.md`。
vendored 基线 commit:`455517a2b3a55fe655cae6842318cd86d8041915`(2026-07-24,上游 v1.0.7)

## 升级方式

1. 拉取上游新版本,diff `slides/` 与本目录(排除 `src/cortex/`、本文件、`package.json`)。
2. 覆盖上游文件后,按下面的补丁点清单逐一重放(全部有 `CORTEX-PATCH` 注释标记,可 grep)。
3. `pnpm --filter @cortex-work/bento-slides build` 验证产物,再跑 desktop 相关单测。

## 补丁点(grep `CORTEX-PATCH`)

### 新增文件(整目录隔离,升级时原样保留)
- `src/cortex/host-bridge.ts` — Electron 宿主桥,三件事:
  1. 保存:订阅 Store 的 `doc` 事件(debounce),把整份 `serializeAuto()` HTML 经
     `host.save()` 回写磁盘,取代 File System Access 保存;
  2. 选区回传:订阅 `selection` **与** `current` 事件(切页也会让引用失效),把当前选区
     快照 JSON 经 `host.selectionChanged()` 推给宿主,右栏「演示助手」据此显示引用;
     校验/截断在宿主侧(`packages/core/design/slides/slides-selection.ts`);
  3. `host.authorName` — 宿主身份名,作为评论作者的默认值。
  另外导出宿主热应用闸门 `beginHostApply()` / `endHostApply()`(计数式):`store.on('doc')`
  首行判 `applyDepth > 0` 就 return。否则宿主刚塞进来的文档会被立刻原样回写一遍
  —— 多一次 revision、多一次 `slides:deckChanged` 广播、多一条版本快照,还会与主进程的
  乐观锁打成回环。`beginHostApply()` 同时清掉 debounce timer 与 pending 补写标记:
  热应用前压着的那笔写已经过期,让它落盘等于用旧稿盖掉刚拿到的 AI 新稿。
- `src/cortex/no-sync.ts` — **与 `SyncSession` 同形状的零同步空壳**,`main.ts` 用它替换
  `new SyncSession(store)`。理由见下方「关掉在线协作」一节。末尾一次
  `as unknown as SyncSession` 断言,使 `editor.ts` / `sync/online.ts` 的类型零改动;
  安全性依据是 **`shareEligible()` 恒 false ⇒ `joinFromDoc()` 不可达**。
- `src/cortex/apply-doc.ts` — 宿主热应用入口 `window.__cortexApplyDeckDoc(json, revision)
  → boolean`:`parseDoc` → 记住 `currentIndex`/`selection` → `beginHostApply()` →
  `store.replaceDoc()`(**刻意走 checkpoint**,⌘Z 是「热应用覆盖了我未落盘的编辑」唯一
  救命通道)→ `injectFonts()`(`replaceDoc` 覆盖不到 —— `@font-face` 只在 boot 注入,
  不补就是字体静默失效)→ 恢复页码(clamp)/过滤失效选区/清 `hoverPreview` →
  `emit('current')`/`emit('selection')` → `editor.cortexAfterHostApply()` →
  `endHostApply()`。返回 false 时宿主回落 webview 整页重载,所以失败路径必须零副作用。
  同一 revision 且文档未被改动时幂等短路,并把已应用的 revision 写到
  `window.__cortexAppliedDeckRevision` 供竞态排查。
  已知限制:`editor/canvas.ts` 的 `render()` 在**内联编辑进行中**会推迟重绘(上游刻意防止
  远端改动抢走正在打字的焦点),此时数据已换、像素等编辑提交后才追上。
- `src/cortex/prompt-dialog.ts` — 页内文本输入弹层 `cortexPromptText()`,替代
  `window.prompt`。**Electron 把 `window.prompt` 覆写成直接抛异常**
  (`throw new Error("prompt() is not supported.")`),上游 5 处调用在 Cortex Desktop 里
  因此全部静默失效。实现照抄上游 `editor.ts` 的 `promptPassword()` 范式
  (`<dialog>` + `showModal()`)。`window.confirm` / `alert` 在 Electron 里可用,不受影响。
- `src/cortex/present-modes.ts` — 宿主受控放映模式:按 boot hash
  (`#cortex-present-solo` / `#cortex-present-audience` / `#cortex-present-speaker`)
  决定放映形态,暴露 `window.cortexPresent = { goto, next, prev, count }` 给主进程
  `executeJavaScript` 驱动;speaker 形态自渲染演讲者视图(notes + 下一页预览),
  控制按钮走 `cortex-presenter://control/...` URL(主进程 will-navigate 拦截)。
- `src/sync/offline.ts` — 浏览器侧在线协作总开关。上游原实现与自更新共处
  `src/update.ts`;Cortex 删除自更新后将该偏好独立保留。
  **`offlineEnabled()` 现在恒返回 `true`,不再读 localStorage。** 主防线是「不建
  SyncSession」,但 `src/sync/online.ts` 仍会被 `src/editor/editor.ts` 带进产物(内含
  `wss://sync.bento.page` 与 `new WebSocket`),所以出站连接的最后一道门必须在源码层恒闭:
  `joinFromDoc()` 与 `startSharing()` 都以 `if (offlineEnabled()) return null` 开头,这条改动
  同时封住两者,且不依赖 session 的形状、也不受宿主 shim 注入时机(dom-ready 晚于 boot)影响。
  勾选框仍写偏好(`setOffline` 保留),但已不参与判定。回归闸见
  `apps/desktop/src/main/capabilities/slides/bento-runtime-no-sync.test.ts`。

### 修改的上游文件(每处都有 `// CORTEX-PATCH` 行内标记)
- `src/main.ts` — boot 分派单点 hook:`bootWith()` 里优先尝试
  `tryCortexPresentBoot(doc)`(放映窗直接进放映,不建 Editor);`editorMode()` 里
  store 建立后依次调用 `initCortexHostBridge(store)` 与 `initCortexApplyDoc(store, editor)`
  (顺序有依赖:热应用要用保存桥的写入闸门);移除 `window.bento.updates`,
  空壳回退为单页空文稿,页面标题不追加上游品牌。
  **协作接线整体拆除**:`new SyncSession(store)` → `createNoSyncSession(store)`,
  并删掉 `./sync/session` 与 `./sync/online`(`onlineTransport` / `startSharing` /
  `stopSharing`)两个 import(`noUnusedLocals` 会报未使用)。
  **对外脚本面契约变化**:`window.bento.sync` 形状不变(诊断脚本/自动化不会崩),
  语义降级为「永远离线」—— `share()` 恒 `null`、`unshare()` 无操作、`online()` 恒 `'off'`、
  `peers()` 恒空、`transports()` 恒 `[]`、`serialize()` 不再烙 CRDT 状态。
- `src/present.ts` — `startPresentation(doc, startIndex, onExit, opts)` 增加
  `opts.hostControlled`:为 true 时不挂自身 keydown、不进/退 fullscreen、不开
  speaker popup、不响应页内 link 点击(翻页权威在 Electron 主进程);并把
  goNext/goPrev/goFirst/goLast/deck.slide 暴露为返回值 controls 供 cortex 层转发。
- `src/editor/comments.ts` — 评论的三处 `window.prompt` 改走 `cortexPromptText()`:
  `commentAuthor()` / `changeCommentAuthor()` 转 async,`openNew()` 转 async(正文用多行输入),
  回复按钮内的作者名解析改 `.then()`。`commentAuthor()` 在询问前先取 `host.authorName`
  作默认值(桌面端已知道用户是谁,不该再拦一次);写入 localStorage 后用户仍可经气泡的
  「✎」改名。**评论功能本身是上游完整实现,此前唯一的断点就是 `window.prompt`。**
- `src/editor/canvas.ts` — 评论落点 handler 的两个 `openNew()` 调用加 `void`
  (handler 保持同步:`preventDefault`/`stopPropagation` 不能挪到 await 之后)。
- `src/editor/editor.ts` — 除下方品牌相关改动外,`promptMediaUrl()`(从链接添加视频/音频)
  转 async 走 `cortexPromptText()`,两个菜单项调用点加 `void`。另有三处与「关掉协作」相关:
  1. `build()` 的 `actions.append(...)` **不再 append `this.shareDropdown()`,但仍调用它**
     —— `this.shareB` 是 `wireOnlineStatus()`(被无条件调用)的必需引用,直接删会抛
     TypeError,且 `noUnusedLocals` 会因私有方法无调用点报 TS6133。节点建好后留在游离
     DOM 里,用户点不到。这比「删按钮 + 拆 offline 勾选块」小一个数量级。
  2. `savePresentationPackage()` / `saveAsTemplate()` 从 Share 面板挪进 `saveDropdown()`
     —— 上游把它们放在 Share 面板的 `canWrite` 分支里,而 collab 一剥离 `canWrite` 恒 false,
     这两个**与协作无关**的入口会连带消失。
  3. **IndexedDB crash-recovery 在宿主环境整体关闭**:`wireAutosave()` 里 `cortexHost()`
     为真时 `clearRecovery(docId)` 且**不**调 `checkRecovery()`;`runAutosave()` 里
     `putRecovery` 包 `if (!cortexHost())`。宿主环境磁盘才是唯一真源(主进程按 revision
     乐观锁写 `deck.bento.html`),AI 每改一次稿这份浏览器侧快照都必然「比文件新且不同」,
     横幅必弹,点 Restore = 用旧稿整份覆盖 AI 新稿。只在落盘后 `clearRecovery` 不够 ——
     editor 自己 2500ms 的 `runAutosave` 会把它写回来。**`addVersion` 刻意保留**:
     版本历史是「热应用覆盖了我的编辑」的第二条找回途径。
  4. 新增公开方法 `cortexAfterHostApply()`:`canvas.render()` + 清 autosave timer +
     `store.setDirty(false)`(热应用进来的内容**就是磁盘上的内容**,不该再被当成
     「用户的未保存修改」回写一遍)。
- `src/editor/panels.ts` — 「保存为布局」的命名 `window.prompt` 改走 `cortexPromptText()`。
- `src/styles.css` — 追加 `dialog.ed-cortexprompt` 样式块(沿用密码弹层观感 + 多行输入形态);
  sv-* 段末追加 `.bento-speaker--split` 样式块
  (`/* CORTEX-PATCH */` 标记):Electron 演讲者视图的 split 布局(当前页占满主区
  + NEXT 右上 + NOTES 底部通栏),scoped 在修饰类下,不影响上游弹窗版 speaker 视图。
- `src/editor/editor.ts`、`index.html`、`src/save.ts` — 移除顶部/启动页/favicon/
  页面标题中的上游可见品牌;文档属性与离线开关移到保存菜单;删除版本检测、更新提示
  与外部帮助推广入口。
- `src/sync/online.ts` — 离线偏好改从 `src/sync/offline.ts` 读取。
- `vite.config.ts` — 不再向运行包注入 `__APP_VERSION__`。
- `scripts/postbuild-compress.mjs` — 根据实际 JS/CSS 生成
  `cortex-slides-runtime` 内容标识,供 Desktop 打开存量 deck 前判断是否需要换壳;
  同步修正 `window.bento` 工具说明。

### 删除文件
- `src/update.ts` — Cortex 不提供上游单文件自更新:无启动检测、手动检查、发布服务器
  请求或运行时更新 API。

## 关掉在线协作(CRDT + 中继)

**结论:`src/sync/*` 源码全部保留、一个文件都不删,但整体不再接线。** 唯一的接入点
`main.ts` 改挂 `src/cortex/no-sync.ts` 的空壳。

为什么必须关:上游 `SyncSession` 的构造函数就会 `attach()`,并给**没有 `collab` 字段**的
文档**自动铸造**协作凭据(`sync/online.ts` 的 `mintCollab`,`on: true`,room 指向公共中继
`wss://sync.bento.page`)并写进 `.bento.html`。此后每次打开都 `since=0` 全量重放房间历史,
而 `sync/crdt.ts` 的 `mergeSnapshot` 对页/元素是**并集**语义(`slides.push` /
`host.elements.push`);AI 经磁盘写入的元素在 `SyncState.adopt` 里只拿到 null register
(上游注释原文 "loses to every real op"),逐字段全输。用户看到的就是**「新旧内容重贴在
一起」**,并且 deck 内容会被上传到第三方中继。

Cortex Desktop 的 deck 是**单机单编辑器**的:一个 deck 只有一个 editor webview(放映窗走
`cortex/present-modes.ts` 的 `tryCortexPresentBoot` 提前 return,从不建 `Store`),真源在
磁盘,写入协调由主进程的 `revision` 乐观锁负责。整套 CRDT 与中继对我们零收益、全是风险。

不删文件只断引用,是为了让下一次跟上游 diff 的代价最小。

**回归闸**:`apps/desktop/src/main/capabilities/slides/bento-runtime-no-sync.test.ts` 用源码
文本断言守住这条契约(`main.ts` 无 `new SyncSession` / 无 `sync/online` import、
`no-sync.ts` 无 `BroadcastChannel` / `WebSocket` / `mintCollab`、`wireAutosave` 含
`cortexHost()`、append 那行不含 `shareDropdown`)。出站 WebSocket「不存在」无法用单测证明,
文本闸是唯一能在常规测试轮次里挡住「上游合并把协作带回来」的手段。

**人工核验**(页内 Console):`window.bento.doc.collab → undefined`、
`window.bento.sync.transports() → []`、`window.bento.sync.online() → 'off'`。

## 刻意不动的部分
- `src/sync/` 全部源码文件保留(仅断引用,见上一节);离线偏好从已删除的自更新模块拆出到
  `src/sync/offline.ts`。
- 源码版权、许可证、`bento/slides` 内部格式名与 `.bento.html` 扩展名保留。
- 压缩壳(`scripts/postbuild-compress.mjs`):保留——产物体积减半,且
  `#bento-doc` 明文合同不受影响(Cortex 的 extract/inject 只依赖该明文块)。
