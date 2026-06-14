# 菜单栏 Spotlight 浮动聊天框

> 计划详见 `~/.claude/plans/menu-bar-cozy-moonbeam.md`。在隔离 worktree `cortex-work-spotlight`（分支 `feat/spotlight-bar`）中实施。

## 需求
- 左键点击 macOS 菜单栏（托盘）图标 → 桌面底部弹出 Spotlight 风格浮动聊天条。
- 注入的系统提示词包含个人工作区项目信息。
- 默认采用上次用过的 agent，可选模型，项目默认「不使用项目」。
- 发送后：隐藏浮动框 → 唤起主窗口 → 个人工作区新建会话并流式回复。
- 控件收进「New Chat ▼」弹层（agent / 模型 / 项目）。

## 阶段清单
- [x] Scaffold：core 契约 + 逻辑（types/bridge/store/persistence/messages/spotlightHandoff/index + 单测）
- [x] Modules：A 主进程&preload&config / B 渲染层 bar / C views 挂 hook
- [x] Build：typecheck(node+web) + electron-vite build 至通过
- [x] Verify：契约对账 + 产物核对(out/renderer/spotlight.html) + 单测
- [x] Review：跳过（Build 与 Verify 均通过）
- [x] Ship：commit `30c0a08` feat(desktop): 菜单栏 Spotlight 浮动聊天框

## 关键约束（写进实现，避免 Verify 兜底）
- bar 只读不写状态：仅 `loadState()` 读 + `spotlight.submit` 提交 intent；主窗口是唯一 store writer。
- handoff 拆两 hook：`useSpotlightIntentRouter`（CortexDesktopView 常挂，收意图→切个人工作区+暂存）+ `useSpotlightHandoff`（PersonalWorkspace 与 CLI 事件同挂，**hydrate 后**才消费，避免 hydrate 覆盖新会话 / cli 监听竞态）。
- `send` 新增 optional 第 5 参 `extraSystemPrompt`，主窗口现有 4 参调用零变化。
- last-used 字段全 optional，旧 json 缺键回退 `defaultAgent`。
- 托盘去掉 `setContextMenu`，左键 toggle，右键 `popUpContextMenu`。
- `app.activate` 重建判断排除 spotlight 窗口。

## 执行结果

实施于 worktree `cortex-work-spotlight`（分支 `feat/spotlight-bar`），用分阶段 Workflow（9 agents）完成，主提交 `30c0a08`。

**变更文件**（23 个源码 + 2 文档）：
- 主进程：新增 `main/spotlight.ts`、`main/ipc/spotlight.ts`；改 `main/index.ts`、`main/automation/tray.ts`、`electron.vite.config.ts`、`preload/index.ts`、`main/ipc/types.ts`。
- core：改 `desktop/types.ts`、`desktop/bridge.ts`、`store/personal.ts`、`desktop/usePersonalPersistence.ts`、`personal/messages.ts`、`index.ts`；新增 `personal/spotlightHandoff.ts` + 2 测试。
- 渲染层：新增 `renderer/spotlight.html`、`renderer/src/spotlight.tsx`、`SpotlightBar.tsx`、`spotlight.css`。
- views：改 `CortexDesktopView.tsx`、`personal/PersonalWorkspace.tsx`。

**验证（自动）**：typecheck(node+web) ✓、`electron-vite build` ✓（产出 `out/renderer/spotlight.html`）、lint ✓、全量 `pnpm test` ✓（7 包；core 128 含新增 10，views 124）。

**Build 阶段自修 2 处**：① `ipc/types.ts` 的 PersistedState 镜像补 `lastAgent/lastModel/lastPiChannelId`（preload `loadState()` 解析到该镜像，bar 要读）；② `SpotlightBar` 返回类型 `JSX.Element`→`React.ReactElement`（React 19 无全局 JSX 命名空间）。

**待用户手动验证（UI）**：左键托盘弹框 / New Chat 弹层选 agent·模型·项目 / 回车转主窗口流式回复 / 系统提示词含 `<personal_workspace_projects>` / 失焦·Esc 隐藏 / 关主窗口后冷投递。

**运行期 watch points**（自动化测不到，手验时留意）：
- 透明 panel 窗口在 macOS 可能 show 后立即 blur 自隐——若闪退，调 `spotlight.ts` 的 blur 处理或 `showInactive/focus` 时序。
- `type:"panel"` + `screen-saver` 置顶在不同 macOS 版本盖全屏应用表现可能有差异。
- 再次唤起靠 `window 'focus'` 事件刷新 last-used；若某次未刷新，看该事件是否触发。
