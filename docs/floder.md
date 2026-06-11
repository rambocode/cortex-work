  1. 目录职责

  - server/：Go 后端，包含 API server、CLI、daemon runtime、数据库访问、业务 service。
  - apps/web/：Next.js Web 应用，只放 Web 平台外壳和 Next 专属代码。
  - apps/desktop/：Electron 桌面端，只放桌面平台外壳、主进程、预加载、桌面适配。
  - packages/core/：共享业务核心层，放 API client、React Query hooks、Zustand stores、平台桥接。
  - packages/ui/：纯 UI 基础组件，不放业务逻辑。
  - packages/views/：共享业务页面和业务组件，供 Web/Desktop 复用。
  - packages/tsconfig/：共享 TypeScript 配置。

  2. 包边界硬规则

  - packages/core/ 不能依赖 react-dom、localStorage、process.env。
  - packages/ui/ 不能引入 @cortex-work/core，保持纯 UI。
  - packages/views/ 不能直接引入 next/* 或 react-router-dom，路由通过 NavigationAdapter。
  - Zustand store 只能放在 packages/core/，不要放进 packages/views/ 或 app 目录。
  - Web 平台相关 Next API 只放在 apps/web/platform/。

  3. 状态管理

  - 服务端状态归 React Query：issues、members、agents、inbox、workspace list 等。
  - 客户端状态归 Zustand：当前 workspace、筛选条件、草稿、modal、UI 选择。
  - WebSocket 事件只负责触发 React Query invalidation，不直接写 Zustand。
  - workspace 相关 query key 必须包含 wsId，避免切换 workspace 后数据串场。
  - 不要把 API 返回数据复制一份进 Zustand，避免双数据源漂移。
