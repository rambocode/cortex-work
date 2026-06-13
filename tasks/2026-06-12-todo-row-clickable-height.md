# Tasks 列表项点击热区与行高不一致

## 现象
鼠标放到文件/任务行上（hover 高亮整行），但上下边缘点不动；相邻两行之间还有一段点不到的「空隙」。

## 根因（实测，非猜测）
用真实 CSS + 真实 DOM 在 headless Chrome 里测量 `getBoundingClientRect`：
- `.pw-todo-row` 与 `.pw-todo-row-main` 高度都是 **36px**（两者相等，行并不比 row-main 高）。
- 但唯一的点击目标 `.pw-todo-title`（`onClick=onOpen` 的 button）只有 **18px**，被 `row-main` 的 `align-items:center` + `padding:6px` 垂直居中。
- 于是每行标题上下各留 ~9px「能 hover（`row-main:hover` 高亮 36px）却不是点击目标」的死区；相邻两行死区 + 1px 列间隙 ≈ **19px 连续点不动区域** → 即用户说的「行之间点不到」。

TodoRow 与 FileRow 共用 `.pw-todo-row-main` / `.pw-todo-title`，问题一致。

## 修复（packages/views/cortex-desktop/cortex-desktop.css）
把行的垂直 padding 从容器下放到点击目标，让点击热区铺满整行：
- `.pw-todo-row-main`: `padding: 6px 7px` → `padding: 0 7px`
- `.pw-todo-title`: 新增 `align-self: stretch; padding: 9px 0; align-content: center;`

行高保持 36px 不变（18px 文字 + 9px×2 padding = 36px），文字仍垂直居中。

## 验证
- headless Chrome 实测修复后：title 点击区 = **36px**（= 整行），相邻 title 点击区垂直间隙 1.0px（仅列 gap），文字中心 43.0 vs 行中心 42.1。
- `packages/views` 内 `vitest run TodosView.test.tsx` → 16/16 通过（点击行为无回归）。
- 待用户手动确认真实 Electron 下手感。

## 步骤
- [x] 实测定位根因（行高 vs 点击区，而非 row 比 row-main 高）
- [x] CSS 下放垂直 padding，title 撑满行高
- [x] headless Chrome 实测修复 + 行高不变
- [x] 回归测试通过

## 备注
- 仅修了垂直方向。左侧文件图标列（~13px）仍非 onOpen 目标；属次要，未改 JSX。
