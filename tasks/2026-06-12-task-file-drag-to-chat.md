# tasks/ 目录 md 文档支持拖入聊天框

## 背景
右侧边栏 Tasks 列表里有两类行:登记过的 todo(`TodoRow`)和 tasks/ 目录里未登记的纯 md 文件 + 归档文件(`FileRow`)。目前只有 `TodoRow` 可拖入聊天框作为附件,`FileRow` 不行。

## 方案
复用现有 `TODO_DRAG_MIME` 拖拽管线:`FileRow` 增加 `draggable` + `onDragStart`,payload 用 `{ id: file.path, title: 去掉 .md 的文件名, projectId, projectName, detailPath: file.path }`。composer 端 drop 处理(读 `detailPath`、按 `id` 去重)无需改动。

## 清单
- [x] `FileRow` 增加 `project` prop,加 `draggable` + `onDragStart`(gated by `editable`,与 `TodoRow` 一致)
- [x] 两处 `FileRow` 调用点(主列表 + 归档区)传入 `project`
- [x] `appendTodoInstruction` 文案「Todo」改为「Task」(对两类拖入都成立,UI 本身就叫 Tasks)
- [x] 跑测试 + typecheck(全仓 114+1 测试通过,typecheck 通过)
- [ ] 用户手动验证 UI(按约定 Claude 不做 UI 验证)

## 结果
- 新增测试:`TodosView.test.tsx`「未登记文件行可拖拽」,断言 dragstart 写入 `TODO_DRAG_MIME` payload 且 `detailPath` 指向文件。
- composer 端零改动:复用 todo 拖拽管线(按 `detailPath` 读文件、按 `id` 去重),归档区文件同样可拖。
