# Lessons

## 2026-06-14 新增/改组件后必须核对 className 与 CSS 选择器是否对得上

**事故**：新会话页 UI 连续报 3 次「错乱/不显示」——项目名图标文字堆叠、下拉面板透明穿透。根因同一个：新建的 `ProjectPicker` 组件 className 用 `.pw-proj-picker-trigger` / `.pw-proj-picker-panel`，而 CSS 写的是 `.pw-proj-picker`（无后缀）/ `.pw-proj-picker-menu`——**类名整体对不上**，那套布局/背景/阴影规则全是死代码，从未生效；组件靠 button 默认样式凑合，简单场景（带 chevron 多元素）勉强能看，只读/纯面板场景就暴露成堆叠/透明。还连带一批死 CSS（`.pw-proj-picker-item/-sep/-empty`、整个 `.pw-branch-*`）。

**规则**：写完或改完任一组件的 className 后，**立即 grep 反查每个 class 在 CSS 里有无对应定义**（`grep -rn "类名" *.css`），别假设"看起来有样式就对"。CSS 类是完整 token 匹配，`pw-x-trigger` ≠ `pw-x`。两条独立验证：(1) 组件每个 className → CSS 有定义或确认复用已有类；(2) 反向：一段 CSS 选择器 → grep 组件确认真有人用，没有就是死代码该删。尤其新组件复用「设想中的」CSS 命名时，最易出现整片静默失效。纯 CSS 视觉问题自动化测试覆盖不到，靠 grep 对账 + 用户手动验证。

## 2026-06-12 CSS 点击热区/布局 bug：先量再改，别先动 padding

**事故**：用户报「列表项 hover 高亮整行却点不动 / 行间有点不到的空隙」。我凭读 CSS 直接断定是 `row-main` 垂直 padding 并改之——方向对但论证靠猜，且第一版改法（缩短 row-main padding）会改变行高。被用户纠正：先搞清楚多余垂直空间到底来自哪。

**真因**（实测才确认）：`.pw-todo-row` 与 `.pw-todo-row-main` 同高 36px（行并不比 row-main 高）；真正问题是唯一点击目标 `.pw-todo-title` 只有 18px 且被居中，上下各 ~9px 是「能 hover 却非点击目标」的死区。

**规则**：排查「视觉区 ≠ 命中区」类布局 bug，**先用真实 CSS + 真实 DOM 量 `getBoundingClientRect`，再改样式**。可行手段：把目标 DOM + `<link>` 真实 CSS 写成 HTML，**用本地 http 服务**（`python3 -m http.server`，浏览器禁 `file://`）打开，用 chrome-devtools MCP `evaluate_script` 测各层 top/height/gap，先在浏览器里注入候选修复验证几何，再落到源码并复测。不要从读 CSS 直接跳到改 padding；不要在没量过的情况下断言「row 比 row-main 高」。

## 2026-06-11 跨进程状态时序：renderer store ≠ 主进程视角

**事故**：首页「点击添加扫描项目」后，右栏立即 `fs:scanDirTree` 被主进程路径白名单拒绝——白名单读的是**落盘的** persisted state，而 renderer 持久化有 500ms 节流。

**规则**：在 renderer 新增任何「写 store 后立刻触发主进程 IPC」的入口时，先问一句：**主进程此刻看到的状态和 renderer 一致吗？** 凡主进程决策（白名单、配置、路由）依赖 persisted state 的：

1. 主进程应持有内存镜像，`store:save` 一到同步更新（不等磁盘）；
2. 影响主进程决策的 store 切片（如 `projects`/`promptRoot`）变更要**立即**落盘，绕过节流；同源 IPC 按序处理可保证先 save 后用。

排查入口：`apps/desktop/src/main/ipc/fs.ts` 的 `assertAllowed`、`packages/core/desktop/usePersonalPersistence.ts` 的 `saveUrgency`。

## 2026-06-14 worktree 里改代码，必须在 worktree 里跑验证（别在主仓跑）

**事故**：用 `git worktree` 在 `.worktrees/<branch>/` 写完整个 feature 后，习惯性 `cd <主仓根>` 跑 `pnpm test/typecheck`。主仓在 `master`、不含我的改动，于是「全绿」其实是**基线**结果，我的新文件根本没被验证。直到 typecheck 报错路径前缀是主仓而非 worktree 才发觉。

**规则**：
1. **改在哪、验在哪**：所有 `pnpm test/typecheck/lint` 必须 `cd` 进 `.worktrees/<branch>/` 执行；用输出里的绝对路径前缀核对是不是 worktree。
2. **worktree 不自带 `node_modules`**：`git worktree add` 只建工作树，pnpm 依赖要在 worktree 内先 `pnpm install`（命中全局 store，很快）；否则 `tsc/eslint: command not found`。
3. 验证某报错是否自己引入：`git stash && tsc --noEmit; git stash pop` 比对基线——基线已有的错别背锅，也别去“修”。
