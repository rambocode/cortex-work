# Tasks 压缩菜单：鼠标移出自动隐藏

## 背景
项目 tasks 标题旁的时钟「压缩清理」下拉（`ArchiveMenu`，`packages/views/cortex-desktop/personal/TodosView.tsx`）。
现状：点击时钟展开、点击菜单外部（`mousedown`）关闭。
需求：**鼠标移出整个菜单区域时自动收起**（mouseleave），重新移入则取消；归档执行中保持打开。

## 方案
- 保留现有 `mousedown` 点击外部关闭（不破坏既有测试）。
- 新增 `onMouseLeave`/`onMouseEnter`：移出后短延迟（250ms）收起，移入取消；`busyKey` 非空时不收起。
- 组件卸载清理 timer。

## 步骤
- [x] 探索定位 `ArchiveMenu` 与现有展开/隐藏逻辑
- [x] 与用户确认交互：鼠标移出即隐藏（mouseleave）
- [x] 实现 mouseleave 延迟收起 + mouseenter 取消
- [x] 补测试：移出后自动收起、移入后取消收起
- [x] 运行 TodosView 测试通过

## 结果
- `TodosView.tsx` `ArchiveMenu`：新增 `closeTimer` ref + `onMouseLeave`/`onMouseEnter`，移出 250ms 后收起，移入取消；`busyKey`（归档中）不收起；卸载清理 timer。保留原 `mousedown` 点击外部关闭。
- 测试：新增「鼠标移出区域自动收起,移入则取消收起」，`packages/views` 内 `vitest run TodosView.test.tsx` → 16/16 通过；eslint 干净。
- 运行测试须在 `packages/views/` 包内执行（仓库根目录跑会缺 jsdom 环境报 `document is not defined`）。
- 待用户手动验证真实 UI 交互手感（250ms 延迟是否合适）。
