# md 文档预览支持元数据(frontmatter)预览

日期: 2026-06-14
类型: feat
状态: 已实现(待 UI 手动验证)

## 目标

右栏 / tasks 文档的 `.md` 预览支持解析开头的 YAML frontmatter,渲染成元数据卡片。
默认隐藏,点击入口才展开。例:

```
---
title: "fix: 流式消息按到达顺序交替分块"
type: fix
status: completed
date: 2026-06-14
plan_id: 2026-06-14-002
---
```

## 实现

- [x] 新增 `packages/views/cortex-desktop/personal/markdownFrontmatter.ts`
  - `splitFrontmatter(content)` → `{ meta, body }`,零依赖解析平铺 `key: value`
  - 仅当 `---` 独占首行且有闭合 `---` / `...` 行时才认定,正文中的分隔线不误判
  - 剥引号、忽略空行与 `#` 注释、value 只按首个 `:` 切分、保持顺序
- [x] `MarkdownView.tsx` 新增 `Frontmatter` 子组件
  - `useState` 控制折叠,默认收起;`Icon.ChevronRight` 作 caret(展开旋转 90°)
  - 复用既有 CSS 契约 `.pw-md-fm / .pw-md-fm-toggle / .pw-md-fm-caret / .pw-md-fm-count / .pw-md-fm-body`(`cortex-desktop.css` 已有样式)
  - 正文用剥离 frontmatter 后的 `body` 交给 react-markdown,避免 frontmatter 被当 `<hr>`/标题渲染
- [x] 因 MarkdownView 为 FilesView(右栏文件预览)与 TodosView(任务详情)共用,两处自动生效

## 验证

- [x] 新增 `markdownFrontmatter.test.ts`(7 例:解析顺序/无 frontmatter/正文分隔线不误判/无闭合/`...`闭合+注释空行/全空/value 含冒号)
- [x] `pnpm --filter @cortex-work/views test` → 21 文件 149 例全过
- [x] `pnpm --filter @cortex-work/views typecheck` 通过(修正 noUncheckedIndexedAccess)
- [x] `pnpm --filter @cortex-work/desktop typecheck`(node+web)通过
- [x] `pnpm --filter @cortex-work/views lint` 无告警
- [ ] UI 手动验证(用户):打开带 frontmatter 的 plan 文档,确认默认折叠、点击展开 key-value、正文不再出现多余分隔线
