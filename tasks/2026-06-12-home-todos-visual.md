# 首页右侧 Todos 显示优化

## 背景
个人工作区首页右侧面板的 Todos 为只读模式,但每行仍渲染一个禁用的勾选框(看起来可点却点不了),整体视觉偏杂乱。

## 计划
- [x] 只读模式下不渲染勾选按钮,改为小状态点(open=主题色,done=绿色),done 标题加删除线
- [x] 视觉微调:行去掉逐行分隔线改用 hover 背景,间距/对齐收紧,降低噪点
- [x] 跑相关测试 / 类型检查

## 结果
- `TodosView.tsx`:`TodoStatusButton` 仅在项目模式渲染(去掉 disabled 分支);只读模式改为 7px 状态点 `.pw-todo-dot`。
- `cortex-desktop.css`:列表行去掉逐行 border,改 hover 背景 + 圆角;done 行降不透明度至 0.6 并加删除线;新增 `.pw-todo-dot` 样式。
- 测试:新增 2 条用例(只读模式无勾选按钮 / 项目模式勾选可切换状态),views 包 29 条全部通过;全仓 typecheck 通过。
- 待用户手动验证首页 UI 效果。
