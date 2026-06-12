# Composer 上方 Git 信息条（GitBar）

计划详情见 `~/.claude/plans/encapsulated-purring-toucan.md`（已批准）。

## 需求
- 聊天输入框上方显示「项目名 · 分支 +N −M [Commit changes]」
- 点击 ± 徽章 → 右栏显示整仓 diff（含未跟踪文件）
- 点击 Commit changes → 向当前 session 发送 "Commit the working tree changes with a sensible message."
- 非 git 仓库隐藏整条；干净时只显示分支

## 任务清单
- [x] 1. 主进程纯逻辑 `git-info.ts(+test 17 例)`：parseNumstat / parseUntracked / countAddedLines / sumStats / synthUntrackedDiff
- [x] 2. fs.ts 新增 `fs:gitInfo` / `fs:gitDiffAll` handler（assertAllowed + 5s timeout + untracked 上限 200 + diff 1.5MB 软截断）
- [x] 3. IPC 四层类型镜像（main types / core types / preload / bridge 可选方法 gitInfo?/gitDiffAll? / core barrel）
- [x] 4. core：`useProjectGitInfo` hook（5s 轮询 + run 结束边沿 invalidate）+ store `gitDiffRequest` 信号（requestGitDiff/consumeGitDiffRequest,+2 store test）
- [x] 5. views：GitBar.tsx(+test 8 例) + PersonalChatArea 接入 + FilesView 消费信号打开「全部变更」diff 预览 + `.pw-gitbar` CSS + Icon.GitBranch
- [x] 6. 验证：pnpm test 7 任务全绿 / typecheck / lint / web+desktop build 通过

## 执行结果
- **测试**：desktop 59（含 git-info 17）/ views 85（含 GitBar 8）/ core 含 store 12 全部通过；typecheck + lint 通过；web build + desktop build 通过。
- **真值对账**：当前脏工作区 shell 独立重算 tracked +249 −2（numstat 求和）、untracked +408（逐文件 wc -l），口径与实现一致（实现对末行无换行文件比 wc 多记 1 行——与 git 口径一致，更准确）。
- **统计口径**：untracked 整文件计 additions、二进制计 0（对齐 `git show --stat`）；`-uall` 展开未跟踪目录；`dirty` 按 porcelain 是否有条目判定（纯重命名 ± 为 0 也算脏）。
- **diff 渲染**：整仓 diff = 真实 `git diff HEAD` + untracked 纯合成片段（含 no-newline 标记），复用 FilesView DiffText / is-fileopen 3/7 布局 / 拖拽条 / 截断只读提示。
- **信号设计**：gitDiffRequest 消费即清（FilesView 未挂载时请求保留到挂载后消费；项目不匹配不消费）。

## 实现要点 / 决策
- 刷新：5s 轮询 + refetchOnWindowFocus + GitBar 监听 running true→false 边沿 invalidate（agent commit 完成后徽章尽快消失）；不复用 watchDir（被文件视图独占且对 .git 变化不可靠）。
- Commit 按钮 running 时禁用；统计截断时徽章尾部显示 `≈`。
- 新增 `Icon.GitBranch`（packages/ui/icons）。

## 遗留
- 待用户手动验证 UI（按约定分工）：脏仓库显示统计 → 点徽章右栏整仓 diff → 点 Commit 发送指令、完成后徽章消失 → 非 git 项目信息条隐藏。
- 无 commit 的全新仓库（无 HEAD）按 isRepo:false 隐藏处理（rev-parse 失败），可接受。
