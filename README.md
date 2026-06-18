# cortex-work

团队 Agent 桌面应用 "Cortex Desktop" 的 monorepo（Web + Electron），参考 Claude Design 设计稿实现。

## 结构（见 `docs/floder.md`）

```
apps/
  desktop/   Electron 桌面端（electron-vite）
  web/       Next.js Web 端（App Router）
packages/
  core/      类型、mock 数据源、React Query hooks、Zustand store、CoreProvider
  ui/        纯 UI：图标、Tweaks 控件
  views/     业务视图：CortexDesktopView 及全部子组件 + 设计稿样式
  tsconfig/  共享 TS 配置
  eslint-config/  共享 ESLint 配置
```

> Go 后端 `server/` 与营销站 `site/` 已移出本仓库，现位于上级目录 `../server`、`../site`，各自独立维护。

边界硬规则：`core` 不碰 react-dom/localStorage/process.env；`ui` 不依赖 `core`；`views` 不引 next/* 或 react-router-dom；Zustand 只在 `core`；服务端态走 React Query（query key 含 wsId），客户端态走 Zustand。

## 常用命令（pnpm 10.28.2）

```bash
pnpm install        # 安装
pnpm dev:desktop    # 启动 Electron 桌面端
pnpm dev:web        # 启动 Web（默认 http://localhost:3000，FRONTEND_PORT 可改）
pnpm typecheck      # 全仓类型检查
pnpm test           # 全仓单测（vitest）
pnpm lint           # 全仓 lint
pnpm build          # 构建 web 与 desktop
```

## 数据

当前为 mock 数据（`packages/core/mock/`），经 React Query 分层供给。接入真实后端时只需替换 `packages/core/mock/api.ts` 的实现，查询键/组件层无需改动。
