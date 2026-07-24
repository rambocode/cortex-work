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
- `src/cortex/host-bridge.ts` — Electron 宿主保存桥:检测 preload 注入的
  `window.cortexSlidesHost` 后,订阅 Store 的 `doc` 事件(debounce),把整份
  `serializeAuto()` HTML 经 `host.save()` 回写磁盘,取代 File System Access 保存。
- `src/cortex/present-modes.ts` — 宿主受控放映模式:按 boot hash
  (`#cortex-present-solo` / `#cortex-present-audience` / `#cortex-present-speaker`)
  决定放映形态,暴露 `window.cortexPresent = { goto, next, prev, count }` 给主进程
  `executeJavaScript` 驱动;speaker 形态自渲染演讲者视图(notes + 下一页预览),
  控制按钮走 `cortex-presenter://control/...` URL(主进程 will-navigate 拦截)。

### 修改的上游文件(每处都有 `// CORTEX-PATCH` 行内标记)
- `src/main.ts` — boot 分派单点 hook:`bootWith()` 里优先尝试
  `tryCortexPresentBoot(doc)`(放映窗直接进放映,不建 Editor);`editorMode()` 里
  store 建立后调用 `initCortexHostBridge(store)`。
- `src/present.ts` — `startPresentation(doc, startIndex, onExit, opts)` 增加
  `opts.hostControlled`:为 true 时不挂自身 keydown、不进/退 fullscreen、不开
  speaker popup、不响应页内 link 点击(翻页权威在 Electron 主进程);并把
  goNext/goPrev/goFirst/goLast/deck.slide 暴露为返回值 controls 供 cortex 层转发。
- `src/styles.css` — sv-* 段末追加 `.bento-speaker--split` 样式块
  (`/* CORTEX-PATCH */` 标记):Electron 演讲者视图的 split 布局(当前页占满主区
  + NEXT 右上 + NOTES 底部通栏),scoped 在修饰类下,不影响上游弹窗版 speaker 视图。

## 刻意不动的部分
- `src/sync/`(CRDT 协作)与 `src/update.ts`(自更新):源码保留、编译进产物,
  但 Cortex 场景不初始化在线共享,自更新永远不会被触发(离线 file:// 环境)。
- 压缩壳(`scripts/postbuild-compress.mjs`):保留——产物体积减半,且
  `#bento-doc` 明文合同不受影响(Cortex 的 extract/inject 只依赖该明文块)。
