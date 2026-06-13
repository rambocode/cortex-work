# 个人工作区：会话归档与删除

计划：`~/.claude/plans/functional-enchanting-key.md`

## 执行清单

- [x] 1. 类型：`SessionMeta` 加 `archivedAt?`（core + main 两份镜像）
- [x] 2. Store：`archiveSession`/`unarchiveSession` action + 接口签名（`packages/core/store/personal.ts`）
- [x] 3. 物理删文件：`deleteChat` 三层链路（bridge / preload / main `chat:delete`）
- [x] 4. 会话行操作改为悬停直接显示「归档/取消归档 + 删除」两个图标（新增 `Icon.Archive`/`Icon.Trash`），删除就地二次确认
- [x] 5. `SessionRow` 重构 + `ProjectBlock` 分区与「显示归档」图标（`PersonalSidebar.tsx`）
- [x] 6. CSS：会话行 hover 操作 + 归档淡化样式
- [x] 7. Store 单测（archiveSession/unarchiveSession/removeSession）
- [x] 8. typecheck / lint / test 全绿

## 执行结果

实现完成，自动化验证全部通过：

- **测试**：`pnpm --filter @cortex-work/core test` → 111 passed（新增 6 个会话归档/删除断言）。
- **typecheck**：`pnpm typecheck` → 5/5 successful（含 desktop node + web 两套）。
- **lint**：`pnpm lint` → 8/8 successful。

改动文件：
- 类型：`packages/core/desktop/types.ts`、`apps/desktop/src/main/ipc/types.ts`（`SessionMeta.archivedAt?`）
- bridge：`packages/core/desktop/bridge.ts`（`deleteChat`）
- store：`packages/core/store/personal.ts`（`archiveSession`/`unarchiveSession`）+ `personal.test.ts`
- IPC：`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ipc/chat.ts`（`chat:delete`）
- UI：新建 `packages/views/cortex-desktop/personal/SessionMenu.tsx`；改 `PersonalSidebar.tsx`、`cortex-desktop.css`

实现要点 / 决策落实：
- 删除走物理删文件，`chat:delete` 排进与 `chat:save` 同一写队列避免交错，`fsp.rm(..., {force:true})` 不存在不报错。
- 归档默认隐藏；项目行仅当存在归档会话时浮现「显示归档」图标（`Icon.File`，`is-active` 表展开）。
- `archiveSession`/`unarchiveSession` 不刷新 `updatedAt`（避免改变列表排序），归档当前会话时让出 `activeSessionId`。

## 待人工验证（UI）

参考验证分工，以下由用户手动验证：会话行 hover 出 ⋯ 菜单、归档/取消归档、二次确认删除后磁盘 `chats/<id>.json` 已删、归档/删除当前会话后中间区让出焦点。
