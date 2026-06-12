# Tasks 文档预览自适应 + 右栏拖拽调宽

## 需求
1. tasks 文档预览页面宽度自适应（原被 `max-width: 760px` 固定）
2. 右侧分栏可拖动调整宽度

## 实现
- [x] 预览自适应：删除 `.pw-todos.is-detail .pw-todo-md` 的 `max-width: 760px`，内容随面板宽度撑满
- [x] 右栏拖拽：PersonalRightPanel 左缘 7px 拖拽条（hover 高亮），mousedown 拖动调宽（向左增宽），clamp [280, min(960, 窗口宽-480)]；**双击拖拽条恢复自动宽度**
- [x] 宽度持久化：personal store 新增 `rightPanelWidth` + `setRightPanelWidth`，进 PersistedState（两份 types 镜像）、hydrate/toPersistedState/saveUrgency（节流档）
- [x] 自定义宽度以内联 `width + minWidth` 应用，覆盖 CSS 三档自动宽度（320px / 详情 40vw / 文件预览 3/7 屏），未设置时维持自动档位
- [x] 测试：store 持久化 roundtrip 1 例；PersonalRightPanel.test.tsx 3 例（内联样式应用/拖动 clamp 与松手停止/双击重置）
- [x] 全量 pnpm test 7 任务通过

## 二轮调整（用户反馈）
- [x] 仅「查看文件」（Tasks 详情 / 文件预览）时可拖动：拖拽条由 CSS `:has(.pw-todos.is-detail)` / `:has(.is-fileopen)` 控制显示，列表态不显示
- [x] 列表态恢复固定 320px：自定义宽度改经 `--rp-custom-width` CSS 变量注入，仅详情态档位引用该变量；返回列表自动回固定宽
- [x] 拖宽上限放宽：中间区域最少保留 125px（上限 = .pw-upper 容器宽 - 125，替代原 min(960, 窗宽-480)）
- [x] 去掉拖拽条 hover 高亮颜色（仅保留 col-resize 光标）

## 备注
- 测试驱动修复：jsdom 中 `getBoundingClientRect().width` 为 0，`??` 不兜底 0 → 改 `||`。
- UI 实际拖拽手感待用户手动验证。
