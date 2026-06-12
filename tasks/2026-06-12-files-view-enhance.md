# 个人工作区 · 项目文件浏览区增强

计划详情见 `~/.claude/plans/eager-knitting-parasol.md`（已批准）。

## 决策记录
- 3/7：文件区占整个应用宽度 3/7（≈43vw），关闭文件恢复 320px
- 发送到 Chat：插入 composer 输入框（预填），不直接发送
- 工具栏：完整版对齐 fanbox（含系统打开/访达显示，新增 shell IPC）

## 任务清单

- [x] 阶段 1：文件类型图标 `fileIcons.tsx(+test)` + `<FileIcon>` 接入 FilesView（树行 + 变更行 + 预览标题）
- [x] 阶段 2：3/7 布局（`.pw-rp-view.is-fileopen` + `:has()` CSS，沿用 todos detail 先例）
- [x] 阶段 3：目录实时刷新（`watch.ts` + `watch-noise.ts(+test)` IPC 四层 + 250ms 去抖 + FilesView 接线 + app 退出清理）
- [x] 阶段 4：Monaco 预览/编辑（`monacoLang.ts(+test)`、`MonacoViewer.tsx`、完整版工具栏、`shell:openPath`/`shell:revealInFolder` IPC）
- [x] 阶段 5：发送到终端/Chat（store `pendingTerminalText`/`composerInsert(+test)`、`sendContext.ts(+test)`、选区发送条、TerminalPanel 双路投递、Composer nonce 去重插入）
- [x] 验证：vitest 全绿 + typecheck + lint + web build + desktop build

## 执行结果

**测试**：views 48 / core 66 / desktop 36 全部通过；三包 typecheck + lint 通过。
**构建**：`pnpm -F web build` 通过（Monaco 未进 web 产物顶层，动态 import 隔离生效）；`pnpm -F desktop build` 通过（Monaco 按语言代码分割懒加载，`editor.worker-*.js` 正常 emit）。

**改动文件**：
- 新增：`packages/views/cortex-desktop/personal/{fileIcons.tsx,monacoLang.ts,sendContext.ts,MonacoViewer.tsx}` 及对应 test、`apps/desktop/src/main/ipc/{watch.ts,watch-noise.ts,watch-noise.test.ts}`
- 改造：`FilesView.tsx`（图标/Monaco/工具栏/选区发送/watcher）、`TerminalPanel.tsx`（ready 标记 + pending 投递）、`PersonalComposer.tsx`（composerInsert 插入）、`personal.ts` store、`fs.ts`（export assertAllowed + shell IPC）、`register.ts`、`main/index.ts`（closeAllWatchers）、`preload/index.ts`、`bridge.ts`、`cortex-desktop.css`
- 顺手修复：`TodosView.test.tsx:114` 预先存在的 TS2532（与本任务无关的工作区遗留）

**实现要点**：
- 实时刷新只推「变了」信号（噪声过滤 + 250ms 去抖在主进程），renderer 重扫 scanDirTree；监听失败静默降级到手动刷新
- Monaco worker 用 `new URL(...)` 跨打包器写法；file:// 下创建失败自动降级主线程 tokenizer（高亮不受影响）
- 终端发送走 bracketed paste（`\x1b[200~…\x1b[201~`）防多行逐行执行；PTY 未就绪时暂存，spawn 完成后投递（原子 consume 防双发）
- vitest 对 monaco-editor 加了 resolve.alias（该包无 "main" 字段，vitest node 解析不到 "module"）

## 反馈调整

- [x] 选区发送按钮从顶部固定条改为**选区位置就地浮出**（fanbox 同款）：`MonacoViewer` 用 `getScrolledVisiblePosition` 计算选区末尾下方坐标，滚动跟随、滚出可视区自动隐藏、贴边自动钳位；FilesView 在 `.pw-mona-wrap` 内绝对定位 `.pw-sel-pop` 弹窗。
- [x] 修复：项目视图右栏停在文件面板时切回首页，右栏未联动。根因是 `openHome()` 不重置 `rightView`；现回首页时右栏同步切回 todos（TodosView 的 `homeOpen` 模式即全部项目列表），含 store 回归测试。

## 待用户手动验证（UI）
1. 实时刷新：终端里 `touch` / agent 改文件 → 文件树自动更新；`.git`/`node_modules` 变动不触发
2. 图标：ts/go/md/png/Dockerfile 等显示品牌色徽章
3. 3/7：打开文件右栏变宽 ≈43vw，返回列表恢复 320px
4. Monaco：高亮 + 行号；「编辑」→ 改动出现 ● → ⌘S/保存 → 完成回预览
5. 工具栏：内容/路径复制、打开（默认应用）、访达
6. 选区发送：预览中选中文字（双击单词亦可）→ 发送条出现 → 终端收到 `（来自 ~/… 的片段）+ 代码块`；发到 Chat 预填输入框
7. 构建产物（非 dev）下 Monaco worker 加载情况（预期最多 console 警告，高亮正常）
