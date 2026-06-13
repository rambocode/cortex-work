# Lessons

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
