# 新会话输入框复用 PersonalComposer（方案 A：解耦内核 ComposerShell）

> 计划：`~/.claude/plans/linked-juggling-lemon.md`
> 起因：新会话落地页手写退化版输入框，丢了 model/语音/Skills/slash/拖入等全部能力。

## 任务清单

- [x] 新建 `ComposerShell.tsx`：从 PersonalComposer 抽出不依赖 session 的纯输入内核
- [x] `PersonalComposer.tsx` 改薄封装：摊平 session 字段转交 ComposerShell（对外签名不变）
- [x] `NewSessionLanding.tsx` 改用 ComposerShell + 草稿态（agent/model/skills），发送落进 createSession
- [x] 新建 `NewSessionLanding.test.tsx`：选模型发送 / 未选项目拦截 / 不使用项目
- [x] 验证：views 单测全绿 + typecheck + lint

## 执行结果

- 新增 `ComposerShell.tsx`(内核)。Props 把 session 派生量显式化:`agent/model/piChannelId/
  useOwnSkills/running/editing`,并新增三个开关:`slashCommands`(默认 [])、`acceptComposerInsert`
  (默认 false,门控全局 composerInsert 订阅)、`className`(注入根 `.composer-wrap`)。顺带在
  Enter 判断补 `!isComposing`,修了中文输入法组合期回车误发的潜在 bug。
- `PersonalComposer.tsx` 缩到 ~60 行薄封装,对外签名零变化 → `PersonalChatArea` 调用处未动。
- `NewSessionLanding.tsx` 删除手写 textarea,改用 `ComposerShell` + 本地 `draft` 草稿态
  (agent=defaultAgent、model/通道默认值、useOwnSkills)。发送时 `createSession(_, agent, model)`
  落 model,再 `updateSession` 补 `piChannelId/useOwnSkills`(createSession 不收这两个字段),
  附件由 `[]` 改为内核收集的真实附件。
- 新增 `NewSessionLanding.test.tsx` 5 个用例:控件就位/无双层 wrap、默认 model 落地、改 model
  下拉落地、有项目未选拦截、空工作区走 ensureNoProjectDir。

## 验证

- views 单测:122/122 全绿(原 117 + 新增 5)。
- typecheck:5/5;lint:8/8。
- 手动 UI(待用户验证):落地页底部出现 model/Skills/语音控件 + Prompt/Todo 可拖入;选模型
  发送后会话沿用所选 model;会话页 composer 行为不变(编辑重发、/clear、文件预览插入)。

## 已知取舍

- 落地页暂不加 agent 切换(保持改前范围),用户进会话页后仍可在 chat-head 换 agent。

## 反馈修复:项目切换语义收敛(会话页只读 / 新会话可切)

用户反馈:项目会话(已有 session)输入框上方不该能切换项目;切换项目是「新会话」的功能。

调研结论:
- #2「新会话可切项目」已实现(NewSessionLanding header 的 ProjectPicker)。
- #3「默认进新会话 + 默认最近项目」已满足:`homeOpen` 初始 `true`(store:152)且
  **不在 `toPersistedState` 持久化切片内**(store:412)→ 每次启动都回到新会话页;默认项目走
  `latestActiveProjectId(sessions)`。
- 故实际只需改 #1:会话页 GitBar 的项目选择器去掉切换能力(反转上一轮「反馈修复①」)。

改动(形态:只读显示项目名,分支切换/统计/Commit 保留):
- `ProjectPicker.tsx` 加 `readOnly?` prop:渲染不可点的 trigger(同 button 结构保视觉一致,
  `aria-disabled` + `tabIndex=-1`,无 chevron/无面板),无具体项目显示「无项目」。
- `GitBar.tsx` 移除 `onChangeProject` prop,ProjectPicker 传 `readOnly`。
- `PersonalChatArea.tsx` 删除传给 GitBar 的 in-place 切项目逻辑(updateSession projectId/
  noProjectDir),并清掉因此未使用的 `dayKey` import。
- `cortex-desktop.css` 加 `.pw-proj-picker-trigger.is-readonly { cursor: default; }`。
- `GitBar.test.tsx` 更新 renderBar(去 onChangeProject)+ 新增只读断言(点击不弹切换菜单)。

验证:views 123/123、typecheck 5/5、lint 8/8 全绿。换项目路径 = 侧边栏「新会话」。

## 反馈修复:trigger 布局 + 新会话项目条下移

### a) 项目名 UI 错乱(图标/文字垂直堆叠)
根因:CSS 那套 `.pw-proj-picker { display:inline-flex … }` 类名**无后缀**,而组件用的是
`.pw-proj-picker-trigger`(带后缀)——类名对不上,布局规则一直是死代码,trigger 从无
`display:flex`。把死规则改名到组件真实使用的 `.pw-proj-picker-trigger`(含 `:hover`/
`:disabled`/`[data-open]`/`.is-placeholder`/`.chev` + 给 svg 加 `flex-shrink:0`),复活原设计、
零重复。同时修好了新会话页 header 的同类 trigger。

### b) 新会话项目条从顶部移到输入框上方(可切项目 + 分支)
GitBar 做成双用:
- 传 `onChangeProject` → 项目可切(新会话页);不传 → 只读(会话页)。
- 传 `onSend` → 显示 ± 统计 + Commit(会话页有 session);不传 → 不显示(新会话页)。
- 分支段对 git 仓库始终显示,两页都能切分支。

`NewSessionLanding`:顶部 `.pw-landing-bar` 去掉 ProjectPicker(只留「新会话」标签),
`ComposerShell` 上方插入可切换 GitBar(`project=selectedProject`、`onChangeProject` 更新
selectedProjectId+hasChosen);`selectedProject` 提到 onSubmit 前,两处共用。`PersonalChatArea`
调用不变(只读 + Commit)。

验证:views 124/124、typecheck 5/5、lint 8/8。GitBar.test 新增「新会话页用法」用例
(可切 + 分支 + 无 Commit)。

### c) 下拉面板透明(穿透显示底下看板)+ 死 CSS 清理
同源问题:ProjectPicker / GitBar 分支面板的 className 是 `.pw-proj-picker-panel`,但 CSS 写的是
`.pw-proj-picker-menu`(对不上)→ 面板无 bg/border/shadow/z-index → 透明穿透。把 `.pw-proj-picker-menu`
改名到组件真实使用的 `.pw-proj-picker-panel`(顺带修好会话页分支下拉——它也用这个类、之前也透明)。

顺手清理确认无人使用的死 CSS(grep 验证组件零引用):`.pw-proj-picker-item/-sep/-empty`
(组件用通用 `.pw-tb-menu-item/-sep`、`.pw-empty-hint`)+ 整个 `.pw-branch-*` 块(约 80 行,
组件分支面板复用 proj-picker/sb-/tb-menu 体系)。

至此 ProjectPicker 的 className 与 CSS 全部对齐(trigger / panel / list / label),三次同源 bug
根除。验证:views 124/124。
