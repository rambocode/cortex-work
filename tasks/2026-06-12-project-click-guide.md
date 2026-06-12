# 左栏点击项目：无 session 时进入引导态

## 需求
左侧项目列表点击项目时，若项目下没有 session：
1. 右侧面板切换到该项目的 Tasks 视图并展开（仍可经标题栏菜单切到文件视图）
2. 中间区域显示引导用户创建新聊天的空状态

## 实现
- [x] store 新增 `activateProject(projectId)`：设 activeProjectId、清 activeSessionId/timelineProjectId、homeOpen=false（[personal.ts](../packages/core/store/personal.ts)）
- [x] PersonalSidebar：项目头拆分——chevron 独立按钮负责折叠;项目名点击 `openProject`：有 session 选最近一条（setActiveSession），无 session 则 activateProject + setRightView("todos") + setRightOpen(true)；引导态项目高亮（data-active）
- [x] PersonalChatArea：新增「已激活项目但无选中 session」分支——显示项目名 + 引导文案 + 「新建聊天」按钮（createSession(projectId, "claude")）；区分「项目无聊天」与「有 session 未选中」两种文案
- [x] CSS：.pw-project-chev / .pw-project-h[data-active] / .pw-center-cta
- [x] 测试：store activateProject 1 例；PersonalChatArea.test.tsx 4 例（引导显示/点击创建/有 session 未选中/未激活项目回退原空状态）
- [x] 全量 pnpm test 7 任务通过

## 行为变更说明
- 点击项目名不再触发折叠（折叠移到左侧 chevron 箭头）;有 session 的项目点击名称会直接打开最近会话。

## 遗留
- UI 交互效果待用户手动验证。
