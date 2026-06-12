# Tasks 面板：自动扫描 tasks/ 目录 + 压缩归档清理

## 需求（用户原话拆解）
1. Todos 功能自动提取项目 `tasks/` 目录下的 md 文档（不再只显示手动登记的 todo）
2. 文案 Todos → Tasks
3. 右侧 Tasks 面板支持单个文件删除
4. 「压缩清理」：按周/月/年为单位，把该周期内 tasks/ 下的文件整理成一个按周期命名的归档文件（手动触发）
5. 归档总结使用后台已配置的「总结模型」（TimelineSettings.summaryModel，即日报那套 agent/OpenAI 端点）

## 决策记录（已与用户确认）
- 压缩时**跳过未完成（open）的任务文件**，只归档 done 任务 + 未登记的普通 md
- 归档文件放 **tasks/archive/** 子目录，命名 `2026-W24.md` / `2026-06.md` / `2026.md`；面板加「归档」折叠分组查看
- 周期归属：文件名 `YYYY-MM-DD` 前缀优先，无前缀用文件 mtime；ISO 周（周一起始）
- AI 总结失败/返回空则**中止且不删任何文件**；同名归档已存在时**追加**而非覆盖
- 内部 key `rightView: "todos"` 与组件名 TodosView 保留不改，只改用户可见文案（降低风险）

## 计划
- [x] 1. 主进程 fs.ts：新增 `fs:listTaskFiles`（列 tasks/ 与 tasks/archive/ 顶层 .md，带 mtime）；writeFile 已自动建父目录
- [x] 2. 类型镜像：TaskFileInfo / TaskFilesResult（main types + core types + core/index 导出）
- [x] 3. preload + bridge：listTaskFiles?（可选方法，旧壳降级为只显示登记 todo）
- [x] 4. core/personal/timeline.ts：export completeWithSummaryModel（日报与归档共用）
- [x] 5. core/personal/taskArchive.ts：纯函数（taskFileTime/isoWeek/periodKey/groupTaskFiles/isArchiveFileName/unregisteredTaskFiles/buildArchivePrompt）+ archiveTaskFiles 完整流程
- [x] 6. TodosView 改造：当前项目扫描合并文件列表（watchDir 自动刷新）、FileRow（打开/编辑/删除）、TodoDetail 泛化为 MarkdownDetail、「归档」折叠分组、ArchiveMenu 清理菜单（粒度 → 分组 → 执行）
- [x] 7. 文案改名 Tasks（TodosView 标题/空提示/新建、TitleBar 菜单、HomeView 两处）
- [x] 8. 单测：taskArchive.test.ts 14 例 + TodosView.test.tsx 新增 4 例（自动提取/单删/归档流程/归档分组）
- [x] 9. 全量 pnpm test（turbo 7 任务，含 typecheck）+ desktop build 通过

## 执行结果
- 测试全绿：core 含 taskArchive 14 例；views TodosView 10 例（6 旧 + 4 新）；desktop build 正常。
- IPC：`fs:listTaskFiles`（invoke）。归档文件名模式 `^\d{4}(-W\d{2}|-\d{2})?\.md$` 不参与再次压缩、不在普通列表重复出现。
- 压缩入口：Tasks 面板项目分组标题行右侧时钟图标 →「按周/月/年压缩」→ 选周期分组 → 执行；toast 报告归档数与跳过数。
- 总结模型即设置里「时间线 · 日报生成模型」的配置（agent → oneshotCli / 自定义 → openaiComplete），无新增配置项。

## 遗留
- UI 实际效果待用户手动验证（dev 跑起来看面板交互）。
- 归档为顺序执行（读→总结→写→删），大量文件的周期首次归档可能需要等模型十几秒，期间菜单显示「归档中…」。
