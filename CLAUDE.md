# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

`cortex-work` 是「Cortex Desktop」团队 Agent 应用的 monorepo：pnpm + Turbo 管理的前端（Web + Electron），加一个既有的 Go 后端（`server/`）。前端核心层（业务逻辑、类型、状态、数据）在 `packages/` 中跨 Web/Desktop 复用，两个 `apps/` 只放各自的平台外壳。

包管理器固定为 `pnpm@10.28.2`，根 `package.json` 为 `"type": "module"`（用 ESM，不要 `require()`）。

## 常用命令

```bash
pnpm install          # 安装工作区依赖
pnpm dev:desktop      # 启动 Electron 桌面端（electron-vite dev）
pnpm dev:web          # 启动 Web（FRONTEND_PORT 或 3000）
pnpm typecheck        # 全仓类型检查（turbo）
pnpm test             # 全仓单测（vitest）
pnpm lint             # 全仓 lint（依赖 typecheck）
pnpm build            # 构建 web + desktop
pnpm dist:desktop     # 打包 macOS（electron-builder，另有 :dir/:zip/:dmg）
```

按包/单测运行：

```bash
pnpm --filter @cortex-work/core test          # 单个包全部单测
pnpm --filter @cortex-work/core test -- run packages/core/personal/messages.test.ts  # 单个文件
pnpm --filter @cortex-work/desktop typecheck  # desktop 同时跑 node + web 两套 tsconfig
cd server && go test ./...                     # Go 后端测试
```

测试就近放在被测代码旁，命名 `*.test.ts(x)`（前端，Vitest + Testing Library + jsdom）或 `*_test.go`（后端，优先表驱动）。Go 代码用 `gofmt` 格式化。

## 架构

### 包分层与硬边界（务必遵守，详见 `docs/floder.md`）

- `packages/core/` — 共享业务核心：类型、API client、React Query hooks、Zustand stores、平台桥接。**不得依赖 `react-dom`、`localStorage`、`process.env`。**
- `packages/ui/` — 纯 UI 基础组件 / 图标 / Tweaks 控件。**不得引入 `@cortex-work/core`。**
- `packages/views/` — 共享业务视图（`CortexDesktopView` 及全部子组件），Web/Desktop 复用。**不得引入 `next/*` 或 `react-router-dom`**（路由通过 NavigationAdapter）。
- `apps/web/` — Next.js App Router 外壳，Next 专属代码只放这里（`apps/web/platform/`）。
- `apps/desktop/` — Electron 外壳：主进程 / 预加载 / 桌面适配。
- `server/` — Go：API server、CLI、daemon runtime、DB、业务 service。

包之间通过 `exports` 字段（见各 `package.json`）做子路径导入，例如 `@cortex-work/core/store/ui`、`@cortex-work/views/cortex-desktop`。新增对外模块要同步更新 `exports`。

### 状态管理（关键约定）

- **服务端态走 React Query**：issues、members、agents、inbox、conversations、dashboard 等。Zustand 里**不要复制一份** API 数据，避免双数据源漂移。
- **客户端态走 Zustand**（只放在 `core/store/`）：当前 workspace、筛选条件、草稿、modal、UI 选择。
- workspace 相关的 query key **必须含 `wsId`**，否则切换 workspace 会数据串场。
- WebSocket 事件只负责触发 React Query invalidation，**不直接写 Zustand**。

### 数据层的三套来源

`packages/core` 同时存在三套数据通道，按需选用：
- `mock/*` — 本地 mock 数据（`mock/data.ts`、`mock/api.ts`）。
- `live/queries.ts` — 走真实后端的 issues/agents/dashboard（经 `api/client.ts` 的 `ApiClient`）。
- `cortex/queries.ts` + `cortex/mutations.ts` — contacts/conversations/file-diffs/orgs。

`CoreProvider`（`core/provider.tsx`）是唯一初始化入口：宿主壳注入 `wsId`、`identity`、`apiConfig`（决定是否启用 `ApiClient`）和 `desktopBridge`，并经 context 暴露 `wsId` 供 hooks 给 query key 命名空间。

### Desktop 主进程 ↔ 渲染进程

- **`DesktopBridge`**（`core/desktop/bridge.ts`）是「个人工作区」桌面能力的接口契约。`core`/`views` **永不直接触碰** `window.desktopAPI` 或 Node API——只通过注入的 `desktopBridge` 调用（Web 端为 `null`）。
- 预加载（`apps/desktop/src/preload/index.ts`）用 `contextBridge` 把 IPC 暴露为 `window.desktopAPI.personal`，其形状与 `DesktopBridge` 一致；`App.tsx` 把它注入 `CoreProvider`。
- 主进程 IPC handler 统一在 `apps/desktop/src/main/ipc/register.ts` 注册（fs / store / cli / chat / timeline / push / llm / pty / usage / agent-projects / watch / update / editors / automation）。类型契约集中在 `main/ipc/types.ts`，并被 preload 与 `core/desktop/types.ts` 共用。

### Agent CLI 适配器

`apps/desktop/src/main/agents/` 是多 agent（`claude` / `codex` / `pi`）适配注册表。每个 adapter 提供两个纯函数：`buildArgs`（构造命令行）和 `parseLine`（解析一行 stdout 为归一化 `CliStreamEvent`）。`ipc/cli.ts` 的 spawn / 流式管线对所有 agent 通用。`pi` 经 `@earendil-works/pi-coding-agent` 用 `utilityProcess.fork` 启动（避免 macOS Dock 闪现）。

### 定时自动化（托盘常驻 + 无头执行）

`apps/desktop/src/main/automation/` 实现定时任务：`scheduler.ts` 用 **croner** 在主进程常驻调度，`runner.ts` 无头执行 agent，`tray.ts` 提供托盘入口。关键行为（见 `main/index.ts`）：
- 关窗（X）= 隐藏到后台，托盘常驻、定时任务继续触发；**真正退出**只走托盘「退出」/ `before-quit`（置 `isQuitting`）。
- 单实例锁防止多开导致调度器重复触发。
- `powerMonitor.resume` 后 `rescheduleAll()` 补漏并重建定时器（休眠期间内存定时器会漂移/错过，croner 不自动补触发）。
- 并发去重靠 runner 的 `pending` + `runningAutomations`，**不能**靠 croner 的 `protect`（fire-and-forget 同步返回使其失效）。

## 提交规范

使用 Conventional Commits（中文描述），如 `feat(automation): 新增定时任务自动化`、`fix(ui): 修复设置弹窗尺寸`。提交信息与代码注释优先用 `zh-Hans`。
