# Todos 详情：预览美化 + 编辑去背景（参考用户提供的设计图）

## 待办

- [x] TodoDetail 改就地编辑：移除 TodoEditorModal 浮层，textarea 原位替换预览（⌘S 保存 / Esc 取消）
- [x] 编辑态样式：透明背景、无边框卡片（参考图2）
- [x] 预览排版（参考图1）：标题层级 / GFM 任务清单（勾选项删除线+置灰）/ 代码块 / 链接 / 引用 / 表格 / 阅读宽度 760px
- [x] TodosView.test.tsx：3 个用例（GFM 渲染 / 就地编辑保存往返 / Esc 取消不写盘）
- [x] pnpm test + typecheck + lint 全绿

## 执行结果

- 121 个测试全过（core 61 / ui 3 / views 26 / desktop 31），typecheck、lint 通过。
- `TodosView.tsx`：删除 `TodoEditorModal`，编辑改为原位 textarea（头部「保存/取消」按钮，⌘S/Ctrl+S 保存、Esc 取消）；空内容也支持双击进入编辑。
- `cortex-desktop.css`：移除 `.pw-todo-modal*`；`.pw-todo-edit-ta` 透明背景贴应用底色；`.pw-todo-md` 补全 h1-h4 层级、`contains-task-list`/`task-list-item`（勾选项 `:has(:checked)` 删除线+置灰、checkbox accent 主题色）、pre 代码块卡片、链接/引用/表格/hr/strong、详情视图阅读宽度 760px。

## 手动验证清单（用户执行）

1. 右栏 Todos 打开详情：标题层级分明、已完成项 ✓+删除线+置灰、行内代码为浅色 chip、代码块为带边框卡片。
2. 点编辑（或双击正文）：原位变成无背景的等宽编辑区，无浮层卡片；⌘S 保存、Esc 取消。
3. 保存后立即回到渲染预览，内容已更新。

## 续：行号槽（用户要求继续补齐）

- [x] 编辑区左侧行号 gutter：与 textarea 同字体/行高，`onScroll` 纵向同步；textarea `wrap="off"`（长行横向滚动）保证行号逐行对齐。
- [x] 测试补 1 用例：行号数与内容行数一致、输入换行后增长。
- 122 个测试全过，typecheck、lint 通过。
- 取舍说明：图2 的软换行+行号需要逐行高度测量（mirror div），textarea 做不到；改用 `wrap="off"` 是行号对齐的标准廉价方案。
