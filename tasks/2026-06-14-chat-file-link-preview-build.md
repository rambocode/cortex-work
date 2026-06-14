# feat: 会话消息文件链接点击 → 右栏复用预览（执行记录）

计划：`docs/plans/2026-06-14-003-feat-chat-file-link-preview-plan.md`
分支/工作树：`feat/chat-file-link-preview` @ `.worktrees/feat/chat-file-link-preview`

## 单元清单

- [x] U1 纯函数：`packages/core/personal/filePaths.ts`（`isLikelyFilePath` / `resolveProjectFileRef`）+ 单测；core `exports` + index 再导出
- [x] U2 Store：`personal.ts` 新增 `filePreviewRequest` + `requestFilePreview` / `consumeFilePreviewRequest`（消费即清，不持久化）+ 单测
- [x] U3 views：`personal/chatMarkdown.tsx` 自定义 react-markdown `components`（code + a 可点击）+ 单测
- [x] U4 views：`ChatArea.tsx` 穿透 `onOpenFile`/`projectPath`；`PersonalChatArea.tsx` 组装 `handleOpenFile` 并接 diff 行 + 组件测试
- [x] U5 views：`FilesView.tsx` 消费 `filePreviewRequest` → `openFile()` + 单测
- [x] U6 样式：`cortex-desktop.css` `.md-body code.file-link` + className↔CSS 双向对账

## 验证（均在 worktree 内执行）

- [x] `pnpm --filter @cortex-work/core test` → 13 文件 / 148 测试全绿（较基线 +1 文件 +11 测试）
- [x] `pnpm --filter @cortex-work/views test` → 20 文件 / 142 测试全绿（较基线 +2 文件 +13 测试）
- [x] desktop typecheck（node + web）通过；core/views `tsc --noEmit` 我的文件零错误
- [x] `pnpm lint`（core + views，eslint）通过
- [x] grep 对账 `.file-link`：组件 `code.file-link` ↔ CSS `.md-body code.file-link`，token 精确，无悬挂
- [ ] 用户手动验证 hover/点击/焦点 + 团队侧无回归（待用户）

## 执行结果

实现完全照计划 KTD1–KTD5：
- 复用「请求 + 消费即清」范式新增 `filePreviewRequest`，未引入全局「当前预览文件」态。
- 路径可点判定纯静态（`isLikelyFilePath` + `resolveProjectFileRef.within`），项目外/解析失败退化纯文本。
- `onOpenFile`/`projectPath` 经 `MessageStream` 可选穿透，团队侧不传 → 零回归。
- diff 卡片文件行 `onSelectFile` 由空函数改接 `handleOpenFile`。
- `FilesView` 新增消费 effect，100% 复用 `openFile()`（Monaco/Markdown/二进制/截断/读错均沿用）。

### 遗留问题（非本次引入）

- **基线 typecheck 失败**：`packages/core/personal/messages.test.ts`(223–250) 在 `master`（`fc55a9a`）上即报 `Message | undefined` 不可赋值（`noUncheckedIndexedAccess` 下 `messages[i]` 取值未判空）。已 `git stash` 验证基线同样失败，与本次改动无关。故 `pnpm typecheck` 全仓会卡在 core；本次改动自身 `tsc` 零错误。建议另起小修：给这些 `messages[i]` 加非空断言。
