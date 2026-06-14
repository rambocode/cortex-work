# 菜单栏 Spotlight 浮动聊天框

> 计划详见 `~/.claude/plans/menu-bar-cozy-moonbeam.md`。在隔离 worktree `cortex-work-spotlight`（分支 `feat/spotlight-bar`）中实施。

## 需求
- 左键点击 macOS 菜单栏（托盘）图标 → 桌面底部弹出 Spotlight 风格浮动聊天条。
- 注入的系统提示词包含个人工作区项目信息。
- 默认采用上次用过的 agent，可选模型，项目默认「不使用项目」。
- 发送后：隐藏浮动框 → 唤起主窗口 → 个人工作区新建会话并流式回复。
- 控件收进「New Chat ▼」弹层（agent / 模型 / 项目）。

## 阶段清单
- [ ] Scaffold：core 契约 + 逻辑（types/bridge/store/persistence/messages/spotlightHandoff/index + 单测）
- [ ] Modules：A 主进程&preload&config / B 渲染层 bar / C views 挂 hook
- [ ] Build：typecheck(node+web) + electron-vite build 至通过
- [ ] Verify：契约对账 + 产物核对(out/renderer/spotlight.html) + 单测
- [ ] Review：按 Verify 修根因
- [ ] Ship：worktree 内中文 Conventional Commit

## 关键约束（写进实现，避免 Verify 兜底）
- bar 只读不写状态：仅 `loadState()` 读 + `spotlight.submit` 提交 intent；主窗口是唯一 store writer。
- handoff 拆两 hook：`useSpotlightIntentRouter`（CortexDesktopView 常挂，收意图→切个人工作区+暂存）+ `useSpotlightHandoff`（PersonalWorkspace 与 CLI 事件同挂，**hydrate 后**才消费，避免 hydrate 覆盖新会话 / cli 监听竞态）。
- `send` 新增 optional 第 5 参 `extraSystemPrompt`，主窗口现有 4 参调用零变化。
- last-used 字段全 optional，旧 json 缺键回退 `defaultAgent`。
- 托盘去掉 `setContextMenu`，左键 toggle，右键 `popUpContextMenu`。
- `app.activate` 重建判断排除 spotlight 窗口。

## 执行结果
（实施后回填：变更文件、测试、遗留问题）
