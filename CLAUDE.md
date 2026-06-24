# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

`cortex-work` 是「Cortex Desktop」团队 Agent 应用的前端 monorepo：pnpm + Turbo 管理的 Web + Electron 两端。核心层（业务逻辑、类型、状态、数据）在 `packages/` 中跨 Web/Desktop 复用，两个 `apps/`（`desktop`、`web`）只放各自的平台外壳。

> **目录变更（重要）**：Go 后端 `server/` 与营销站 `site/` 已从本仓库移出，现位于上级目录 `../server`、`../site`，各自独立维护。本仓库只剩前端两端 + 共享包。若 `pnpm-workspace.yaml`、根 `package.json` 仍残留 `site`（`dev:site` / `build:site` / `start:site`）或 `server` 引用，应视为待清理的悬空配置。

包管理器固定为 `pnpm@10.28.2`，根 `package.json` 为 `"type": "module"`（用 ESM，不要 `require()`）。

阶段执行规范：
 - [ ] 阶段 1: 实现 `@cortex-work/apps/desktop` 的功能完善，在你不明确工作任务时，可以先实现 desktop 的功能完善。
 
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
```

测试就近放在被测代码旁，命名 `*.test.ts(x)`（Vitest + Testing Library + jsdom）。Go 后端测试在 `../server`（`go test ./...`），不在本仓库范围。

## 架构

### 包分层与硬边界（务必遵守，详见 `docs/floder.md`）

- `packages/core/` — 共享业务核心：类型、API client、React Query hooks、Zustand stores、平台桥接。**不得依赖 `react-dom`、`localStorage`、`process.env`。**
- `packages/ui/` — 纯 UI 基础组件 / 图标 / Tweaks 控件。**不得引入 `@cortex-work/core`。**
- `packages/views/` — 共享业务视图（`CortexDesktopView` 及全部子组件），Web/Desktop 复用。**不得引入 `next/*` 或 `react-router-dom`**（路由通过 NavigationAdapter）。
- `apps/web/` — Next.js App Router 外壳，Next 专属代码只放这里（`apps/web/platform/`）。
- `apps/desktop/` — Electron 外壳：主进程 / 预加载 / 桌面适配。
- `packages/tsconfig/`、`packages/eslint-config/` — 共享 TS / ESLint 配置。
- _(Go 后端 `server/`、营销站 `site/` 已移至上级目录 `../server`、`../site`，不在本仓库。)_

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


## 代码质量约束（务必遵守）

- **单文件行数上限 1200 行**：任何 `.ts` / `.tsx` 源文件不得超过 1200 行（不含自动生成文件、快照、锁文件）。逼近上限时优先按职责拆分组件 / hook / 工具函数，而非堆叠。
- **关键代码必须注释**：以下场景必须写注释，且优先用 `zh-Hans`——
  - 非显而易见的业务规则、边界条件与取舍（解释「为什么」而非复述「做了什么」）。
  - 跨进程 / 跨包契约（IPC、`DesktopBridge`、`exports` 子路径、query key 约定等）。
  - 并发、时序、缓存失效、WebSocket 触发 invalidation 等隐式依赖。
  - 临时绕过 / TODO / 已知限制，注明原因与后续计划。
- **简洁优先**：改动只触及必要代码，避免顺手重构无关逻辑；能复用现有抽象就不要新造。

## 提交规范

使用 Conventional Commits（中文描述），如 `feat(automation): 新增定时任务自动化`、`fix(ui): 修复设置弹窗尺寸`。提交信息与代码注释优先用 `zh-Hans`。

## 发版规范（务必遵守）

发版（bump `apps/desktop/package.json` 的 `version` → commit → 打 `v<version>` tag → push）前，**必须**在 `apps/desktop/CHANGELOG.md` 顶部新增对应版本段，否则正式发布会失败。

- 版本段标题须匹配格式契约 `^## \[?<version>\]?`（`<version>` 为裸版本号、无 `v` 前缀），如 `## [0.1.9]`、`## 0.1.9`、`## [0.1.9] - 2026-07-01`。
- **版本段正文必须按「上一个 tag → HEAD」的全部提交汇总**，而非只依据最近一次提交。生成前先用 `git log <上一个 tag>..HEAD --oneline`（如 `git log v0.1.12..HEAD --oneline`）取出区间内所有 commit，再归纳成更新说明，避免漏掉本次发版包含的其它改动。
- **版本段正文面向用户，只写有感知的更新（新功能、可见的改进与修复），不展示无意义的细节**：跳过纯内部改动（重构、依赖 bump、CI / 构建脚本、版本号 bump 本身、格式化、注释、测试）；多条同类提交归并成一条用户视角的说明，不要逐条罗列 commit。
- 该段正文是应用内「更新内容」与 GitHub Release body 的唯一来源：打包时 `scripts/extract-release-notes.mjs` 按 `version` 提取它 → 写入 `latest-mac.yml` 的 `releaseNotes`，运行时更新弹窗展示。
- 缺段时：本地/非正式构建写安全占位、不阻断；CI `publish-release`（`CORTEX_NOTES_STRICT=1`）则**非零退出使发布失败**，刻意防止「忘写版本段 → 静默丢更新说明」。tag 仍须与 `package.json` 的 `version` 一致（CI 有强校验）。
