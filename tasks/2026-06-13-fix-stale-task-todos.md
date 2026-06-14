# 修复:右侧 Tasks 列表残留已删(外部删除)的 task,点击报 ENOENT

> 来源:本修复由「个人工作区新会话改造」workflow 的某个 agent 在探索代码时
> 自主发现并实现,**并非原始需求项**。经用户事后确认,保留并随该批改造一并交付。
> （原始记录曾误称「已与用户确认」——实为 agent 动手前未经确认,此处更正为如实记录。）

## 问题
外部 `rm tasks/todo-xxx.md` 后,右侧 Tasks 列表仍显示该 todo;点击触发
`fs:readFile` → `fsp.stat` 抛 `ENOENT: ... tasks/todo-xxx.md`。

## 根因
todo 元数据(Zustand store → 持久化到 `personal-workspace.json`)与磁盘
`tasks/*.md` 是两套独立数据源。`listTaskFiles`/watch 只刷新文件扫描结果
(`taskFiles` state),**从不回收 todo 元数据**,`detailPath` 成悬空指针。
现有失效清理 effect 只处理 `kind:"file"`,对 `kind:"todo"` 只查 store 不查磁盘,
管不到外部删除。

## 方案
扫描后对账:当前项目里 `detailPath` 已不在磁盘(不在 `files ∪ archived`)的
todo,连同元数据一并 `removeTodo`。
- 安全条件:仅在扫描成功(then 分支)、仅当前项目、`detailPath` 非空时判定。
- 竞态:新建 todo 在 `detailPath` 设值前为空串,不被判定;设值时文件已落盘。
- 边缘假设:仅识别 `tasks/` 顶层与 `tasks/archive/` 的 md(`listTaskFiles` 不递归
  子目录);`detailPath` 由 `createTaskFile` 生成必为 `tasks/<id>.md`,与扫描结果同格式。

## 步骤
- [x] `packages/core/personal/taskArchive.ts` 新增纯函数 `staleTodoIds(scan, todos, projectId)`
- [x] `packages/core/index.ts` 导出 `staleTodoIds`
- [x] `packages/core/personal/taskArchive.test.ts` 补单测(4 例:清理/保留/跨项目隔离/空 detailPath 跳过)
- [x] `TodosView.tsx` 的 `refreshFiles` then 分支接入对账清理
- [x] `pnpm --filter @cortex-work/core test` + 全仓 typecheck/lint 通过

## 验证
- 自动化:staleTodoIds 单测覆盖(已通过,随全仓 test 全绿)
- 手动(用户):外部删除 task 文件后,列表自动移除该项,点击不再报错
