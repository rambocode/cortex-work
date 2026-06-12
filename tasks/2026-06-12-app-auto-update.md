# 应用自动更新（标题栏「更新」按钮）

参考 fanbox 的更新交互（标题栏入口 + 主进程检测 + IPC 推送），按用户选择采用
**GitHub Releases + electron-updater 应用内下载自动安装** 方案。

## 决策记录
- 更新源：GitHub Releases（gh 未登录，owner 用占位 `OWNER_PLACEHOLDER`，集中在 electron-builder.yml 一处）
- 更新方式：electron-updater 应用内下载 + quitAndInstall（macOS 正式分发需 Developer ID 签名）
- UI 位置：TitleBar `.tb-right` 最左（截图红框处），available 显示「更新」→ 点击下载（进度%）→ 完成变「重启更新」；下载失败显示「重试更新」，纯检查失败静默
- 检查节奏与 fanbox 一致：启动 6s 首查 + 每 2h 复查；dev（未打包）不检查

## 计划
- [x] 1. apps/desktop 添加依赖：electron-updater（dep）、electron-builder（devDep）
- [x] 2. 新建 electron-builder.yml（appId ai.cortex.work / mac zip+dmg arm64 / publish github / node-pty asarUnpack）+ `pnpm dist` script
- [x] 3. 主进程 `src/main/ipc/update.ts`（autoUpdater 封装 + 定时检测 + 广播 update:state）+ `update-state.ts`（纯函数状态机）
- [x] 4. register.ts 注册 registerUpdateHandlers
- [x] 5. preload 暴露 updateGetState / updateDownload / updateInstall / onUpdateState
- [x] 6. core/desktop types.ts + bridge.ts（可选方法）+ core/index.ts 导出 UpdateState
- [x] 7. 渲染层 UpdateButton.tsx（含纯映射 updateButtonUi）+ TitleBar 接入 + `.tb-update` CSS
- [x] 8. 单测：update-state.test.ts（6 例）+ UpdateButton.test.tsx（7 例）
- [x] 9. 全量 `pnpm test`（turbo 7 任务，含 typecheck）+ `pnpm build` 通过
- [x] 10. 文档：见下方「发布前必做」

## 执行结果
- 测试全绿：desktop 42 tests / views 含 UpdateButton 7 tests；`pnpm build` 产物正确外部化 electron-updater。
- 测试驱动修了一个真实竞态：挂载补拉 `updateGetState()` 晚返回会覆盖更早到达的推送 → 改为推送一旦到达即丢弃补拉结果。
- IPC channel：`update:state`（推送）、`update:getState` / `update:check` / `update:download` / `update:install`（invoke）。

## 发布前必做（遗留事项）
1. `apps/desktop/electron-builder.yml` 把 `publish.owner: OWNER_PLACEHOLDER` 改成真实 GitHub 用户名/组织，建好 repo。
2. macOS 自动更新要求 **Developer ID 签名**（未签名时 electron-updater 下载/校验会报错）。
3. 发版流程：bump `apps/desktop/package.json` version → `pnpm dist` → 把 `dist/` 的 dmg、zip、`latest-mac.yml` 上传到 GitHub Release（tag `v<version>`）。
4. dev 模式不触发检测；端到端验证需打包两个版本实测（或临时用 `autoUpdater.forceDevUpdateConfig` + `dev-app-update.yml`）。
