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

### 修改的上游文件(每处都有 `// CORTEX-PATCH` 行内标记)
- `src/main.ts` — boot 分派单点 hook:`bootWith()` 里优先尝试
  `tryCortexPresentBoot(doc)`(放映窗直接进放映,不建 Editor);`editorMode()` 里
  store 建立后调用 `initCortexHostBridge(store)`;移除 `window.bento.updates`,
  空壳回退为单页空文稿,页面标题不追加上游品牌。
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
  转 async 走 `cortexPromptText()`,两个菜单项调用点加 `void`。
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

## 刻意不动的部分
- `src/sync/` 的 CRDT 与在线协作能力保留;只把离线偏好从已删除的自更新模块拆出。
- 源码版权、许可证、`bento/slides` 内部格式名与 `.bento.html` 扩展名保留。
- 压缩壳(`scripts/postbuild-compress.mjs`):保留——产物体积减半,且
  `#bento-doc` 明文合同不受影响(Cortex 的 extract/inject 只依赖该明文块)。
