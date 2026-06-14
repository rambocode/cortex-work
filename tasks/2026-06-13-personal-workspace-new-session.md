# 个人工作区改造：新会话 / 项目选择器 / Git 分支 / 首页

> 计划：`~/.claude/plans/1-generic-pelican.md`
> 实现方式：主程契约层 + Workflow 编排（Scaffold→Modules→Build→Verify→Review）+ 收尾验证 + 用户反馈修复。

## 任务清单（全部完成）

### §7 首页：删 Agent 项目 + 热力图统计侧边栏项目
- [x] 删除 HomeView 的 ProjectSearch 与「Agent 项目」section + 清理 import
- [x] 热力图改用 `partitionProjects(projects).visible`

### §3 共享 ProjectPicker 组件
- [x] 新建 `ProjectPicker.tsx`（搜索/勾选列表/添加项目/不使用项目）

### §4 数据层：不使用项目的会话
- [x] `paths.documentsCortexDir()` + `noProjectSessionDir()`
- [x] `fs:ensureNoProjectDir` + `assertAllowed` 白名单
- [x] IPC 四层镜像（fs/preload/types×2/bridge/index）
- [x] `SessionMeta.projectId?` + `noProjectDir?`
- [x] `createSession` 支持 undefined + noProjectDir
- [x] `messages` timeline 守卫
- [x] `PersonalChatArea` 无项目合成项目渲染
- [x] tsc 收敛 projectId fan-out

### §1 侧边栏
- [x] 「首页」→「新会话」按钮
- [x] 「无项目」会话分组

### §2 新会话落地页
- [x] HomeBoard 抽取 + `latestActiveProjectId`
- [x] `NewSessionLanding`（项目条 + 看板 + 输入框）+ PersonalWorkspace 渲染切换 + 提交流程

### §5 会话页项目选择器（见反馈修复①：最终落在 GitBar）
- [x] GitBar 内置 ProjectPicker（in-place updateSession）

### §6 Git 分支
- [x] runGit stderr / 3 IPC / 四层镜像 / git hooks / GitBar 分支下拉 + dirty 禁止切换

### §8 跨项目 Tasks 聚合
- [x] `useAllProjectsTasks` + HomeTodos 改写

### 附带（workflow agent 越界、用户确认保留）
- [x] `staleTodoIds`：外部删 task 文件后自动清理悬空 todo（详见 `2026-06-13-fix-stale-task-todos.md`）

## 反馈修复（用户截图反馈三处）
- [x] ① 项目选择器从 chat-head 移到 GitBar「项目·分支」条；GitBar 改为始终显示（无项目会话也显示选择器，分支段仅 git 仓库出现）。chat-head 恢复只读项目名。
- [x] ② 落地页输入框样式坏：原 `.pw-landing-input/.pw-landing-send` 无 CSS 定义。改用现有 `.composer` 类体系（圆角卡片 + 右下发送按钮 + textarea 自适应高度），与会话页一致，零新增 CSS。
- [x] ③ 首页点 task：新增 `store.taskDetailRequest`（仿 gitDiffRequest），HomeTodos 点击发请求（不 activateProject、不切走首页），TodosView 消费后在右栏打开该文件 markdown 详情（首页只读）。

## 验证结果
- typecheck：全仓 5/5 通过
- 单测：views 117/117、core 118/118、desktop 128/128 全绿（重写 `HomeView.test`、`GitBar.test` 适配新实现）
- lint：8/8 通过
- 手动 UI：待用户验证（见下）

## 待用户手动验证
1. 侧边栏「新会话」→ 落地页（看板 + 顶部项目条 + **底部输入框样式正常**）
2. 选项目 / 不使用项目 + 输入 → 创建会话跳转；不使用项目落 `~/Documents/cortex/<日期>`
3. 会话页聊天框**上方「项目·分支」条**：项目选择器可切项目；建/切分支，dirty 时禁止切换并提示
4. 首页点 task → **右栏显示该 task 的 md 详情**
5. 首页无「Agent 项目」；热力图随侧边栏项目变化；Tasks 最近 10 条按 mtime、项目名弱化
