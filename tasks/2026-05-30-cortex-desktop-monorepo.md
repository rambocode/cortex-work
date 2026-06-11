# Cortex Desktop monorepo 实现（Web + Electron）

参考设计稿 `cortex-desktop`，照搬 `~/source/ai/multica` 工具链，按 `docs/floder.md` 分层。

## 阶段 0 — Monorepo 骨架
- [x] 根 package.json / .npmrc / pnpm-workspace.yaml(catalog) / turbo.json / .gitignore
- [x] packages/tsconfig（base + react-library）
- [x] packages/eslint-config（base/react/next）

## 阶段 1 — packages/ui
- [x] icons（移植全部 Icon.*，TS 化、props 正确解构）
- [x] controls（SegmentedRadio / Toggle / PaletteChips，去宿主协议）
- [x] lib/utils（cn）

## 阶段 2 — packages/core
- [x] types（含 RichText / Message 联合 / CodeToken）
- [x] mock/data（CONTACTS/CONVOS/FILE_DIFFS 全量移植）+ mock/api（异步）
- [x] cortex/queries（key 含 wsId）+ mutations（纯转换 + hook）+ time
- [x] store/ui（Zustand 单例）
- [x] query-client + provider(CoreProvider)

## 阶段 3 — packages/views
- [x] cortex-desktop.css（逐行移植 styles.css + Tweaks 面板样式）
- [x] CortexDesktopView + TitleBar + Sidebar + ChatArea + RightPanel + ToastStack + TweaksPanel + rich

## 阶段 4 — apps/desktop（Electron）
- [x] electron-vite 脚手架 + main/preload/renderer（hiddenInset 露出设计稿 titlebar）

## 阶段 5 — apps/web（Next.js）
- [x] App Router 薄壳（page "use client" 挂 CoreProvider + view）

## 阶段 6 — 测试与验收
- [x] vitest 单测：ui 图标(3) + core mutations(3) + views ContactRow(3) + 集成(4)
- [x] pnpm install / typecheck(5/5) / test(13 通过) / lint(8/8) 全绿
- [x] pnpm build：web 预渲染 `/` 成功 + desktop renderer 打包(43kB CSS) 成功
- [x] web dev server HTTP 200，SSR 含 fit-root/app-frame/titlebar/traffic/搜索/Tweaks 等设计标记
- [~] dev:desktop 需 GUI 会话手动核对（Electron 无法 headless 截图）

## 执行结果
- 全新搭建 pnpm 10.28.2 + Turborepo + electron-vite + Next 16 monorepo，照搬 multica 约定。
- 按 floder.md 严格分层：ui(图标/控件) / core(类型·mock·RQ·Zustand) / views(全部业务组件+移植CSS) / apps(双薄壳)。
- 服务端态(联系人/会话/文件diff)走 React Query(key 含 wsId)；客户端态(选中/搜索/右栏/tweaks/toast)走 Zustand；send/approve 为 mutation 改 RQ 缓存 + setTimeout 模拟 Agent 回复；标记已读为 setQueryData 乐观更新，未复制进 Zustand。
- 集成测试证明完整数据流：RQ mock → 视图渲染联系人+会话+diff/approve 卡 + composer；搜索过滤(单命中/空态)；批准后 diff 卡变「已应用」+ toast。
- Chrome 扩展未连接，未能浏览器截图；以 Next 预渲染 + SSR 标记 + jsdom 集成测试三重佐证渲染正确。

### 遗留 / 后续
- `apps/web` 仍含 Next 自动改写的 tsconfig（jsx→react-jsx、追加 .next/dev/types）。
- desktop 仅最小主进程（窗口+app:get-info），未做打包(electron-builder)、自动更新、深链接。
- 数据为 mock；接真实 Go 接口时只需替换 `packages/core/mock/api.ts` 实现，查询/组件层不动。
