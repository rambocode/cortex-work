# 文件窗口 .md 渲染对齐 tasks 文档

需求：右侧面板「文件」窗口预览 .md 时，渲染方式与 tasks 文档（TodosView）保持一致。

## 背景
- 之前文件窗口预览 .md 走 Monaco，只做语法高亮、显示源码。
- tasks 文档用 react-markdown + remark-gfm + remarkCallouts，套 `.pw-todo-md` 排版渲染成 HTML。

## 实施
- [x] 抽共享组件 `personal/MarkdownView.tsx`：把原写死在 TodosView 的 `MdLink`/`MdPre`/`MD_PLUGINS`/`MD_COMPONENTS` 迁出，两边引用，保证渲染完全一致。
- [x] TodosView 改用 `<MarkdownView content={content} />`，删除本地重复定义与相关导入。
- [x] FilesView：预览 `.md/.markdown/.mdx` 且非编辑态时，用 `<div class="pw-file-md"><div class="pw-todo-md"><MarkdownView/></div></div>` 渲染；点「编辑」仍切回 Monaco 源码编辑。
- [x] CSS 新增 `.pw-file-md`：放开 `.pw-todo-md` 默认 260px 高度限制，填满面板自管滚动。

## 验证
- [x] `tsc --noEmit`（views）通过
- [x] ESLint 三个改动文件 exit 0
- [x] TodosView.test.tsx 16/16 通过（重构未改变 tasks 渲染）
- [ ] 用户手动验证 UI：文件窗口打开 .md 看渲染效果 + 点编辑回到 Monaco

## 备注
- 编辑/保存/重载/复制按钮逻辑不变；选区发送终端/Chat 仅在 Monaco（编辑态或非 md）下可用，md 只读态不再有该浮窗——与 tasks 文档行为一致，属预期取舍。
