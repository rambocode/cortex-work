# 个人工作区：文件列表右键菜单

## 需求
右侧「文件」视图（全部文件树 + 最近变更列表）的文件行支持右键菜单：
- 打开（系统默认应用）
- 插入到聊天框（插入文件路径）
- 插入到终端（插入 shell 安全的路径）
- 删除（菜单内二次确认，删除后刷新列表）

## 方案
- 复用现有能力：`bridge.openPath` / `bridge.deleteFile`、store 的 `insertToComposer` / `sendToTerminal`。
- 新增 `FileContextMenu.tsx`：轻量自绘菜单（fixed 定位、视口内收敛、点击外部/Escape 关闭），删除项首点变「确认删除？」二次点击才执行。
- `sendContext.ts` 增加 `shellQuotePath`（终端插入用，处理空格/特殊字符）。
- `FilesView.tsx`：两种模式的文件行挂 `onContextMenu`，状态提升到 FilesView。
- CSS：`cortex-desktop.css` 增加 `.pw-ctx-menu` 样式（贴近 `.pw-sel-pop` 风格）。

## 任务
- [x] 新建 FileContextMenu 组件（含定位、关闭、二次确认删除）
- [x] sendContext.ts 增加 shellQuotePath + 单测
- [x] FilesView 接入右键（全部文件 + 最近变更两种模式）
- [x] CSS 样式
- [x] FileContextMenu 单测（菜单项行为：打开/插入/删除确认流）
- [x] 跑测试 + lint

## 执行结果
- 新增 [FileContextMenu.tsx](../packages/views/cortex-desktop/personal/FileContextMenu.tsx)：自绘右键菜单，fixed 定位 + 视口收敛，点击外部/Escape/右键空白处关闭；删除为菜单内二次确认（首点变「确认删除？」）。
- [sendContext.ts](../packages/views/cortex-desktop/personal/sendContext.ts) 增加 `shellQuotePath`（安全字符直传，否则 POSIX 单引号转义）。
- [FilesView.tsx](../packages/views/cortex-desktop/personal/FilesView.tsx) 两种模式（全部文件树 / 最近变更）文件行均挂 `onContextMenu`；「最近变更」里已删除（status D）的文件不出菜单。
- 删除成功后刷新列表 + toast；若被删文件正在预览则关闭预览。
- 测试：FileContextMenu.test.tsx 9 个用例 + sendContext shellQuotePath 4 个用例；views 包全套 vitest 通过（14 文件 / 98 用例），lint、tsc 均通过。
- UI 实际效果待用户手动验证（按既有分工）。
