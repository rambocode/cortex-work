# Cortex Desktop 仓库规则

pnpm `10.28.2` / Turbo monorepo；前端位于 `apps/`、共享包位于 `packages/`，Go 后端位于 `server/`。

## 模块边界

- `apps/web`: Next.js App Router；`apps/desktop`: Electron + electron-vite。
- `packages/core`: 共享类型、API/hooks/store；不得依赖 `react-dom`、`localStorage` 或 `process.env`。
- `packages/ui`: 纯复用 UI，不得依赖 `core`。
- `packages/views`: 业务视图，不得导入 `next/*` 或路由专属 API。
- `server`: Go 服务、CLI、handlers、migrations 和测试。

## 常用命令

- 安装与开发：`pnpm install`、`pnpm dev:web`、`pnpm dev:desktop`。
- 前端验证：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm build`。
- 后端验证：`cd server && go test ./...`。

## 实现与验证

- 使用 ESM `import`/`export`；遵循 `@cortex-work/eslint-config` 和 React Hooks 规则。
- React 组件用 `PascalCase`，函数/变量用 `camelCase`；测试与实现同目录，命名为 `*.test.ts(x)`。
- Go 使用 `gofmt`；后端测试命名为 `*_test.go`，优先 table-driven tests。
- 先运行目标测试；跨模块改动或收尾时运行相关完整测试、`typecheck` 和 `lint`。
- 不提交 secrets、tokens、generated uploads 或环境专属配置。
- `packages/core/mock/` 数据应覆盖可见状态；替换 mock API 时保持 query keys 和组件 contract 稳定。

## 交付

提交信息使用 Conventional Commit。PR 写明摘要、关联 issue、准确验证命令；UI 改动附截图，涉及迁移时补 migration notes。
