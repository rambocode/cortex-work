# 个人工作区首页：热力图 + 项目检索 + 全局一日总结

计划详情见 `/Users/mike/.claude/plans/ancient-kindling-blossom.md`（已批准）。

## 待办

- [x] store：`homeOpen` 状态 + `openHome`，离开入口清标志（store/personal.ts）
- [x] timeline.ts 重构：提取 `loadTimelineData` / `completeWithSummaryModel`（行为不变）
- [x] timeline.ts 新增：`GLOBAL_TIMELINE_ID` / `useGenerateGlobalSummary` / `useGlobalSummaries` / `buildGlobalSummaryPrompt`
- [x] TDD：home.test.ts（buildHeatmapWeeks / homeHeatLevel）+ timeline.test.ts（buildGlobalSummaryPrompt）
- [x] home.ts：纯函数 + `useAllProjectsTimeline`
- [x] core/index.ts 导出
- [x] HomeView.tsx（热力图 / 项目检索 / 全局总结三区块）+ HomeView.test.tsx 渲染测试
- [x] PersonalWorkspace 接线（homeOpen > timeline > chat）
- [x] PersonalSidebar 首页按钮
- [x] cortex-desktop.css 样式
- [x] pnpm test + typecheck + lint 全绿
- [x] 任务文件回填执行结果

## 执行结果

- **测试**：99 个测试全过（core 49 / ui 3 / views 21 / desktop 26），lint、typecheck 通过。新增 10 个测试（home.test.ts 6 + timeline.test.ts 2 + HomeView.test.tsx 4，其中渲染测试用 fake bridge 覆盖三区块聚合、检索过滤、点击跳转、空态）。
- **设计偏差（已论证）**：`buildGlobalSummaryPrompt` 从计划的 home.ts 移到 timeline.ts —— `useGenerateGlobalSummary`（需复用 timeline.ts 私有的 `mutateTimeline`）依赖它，放 home.ts 会造成循环依赖。
- **Electron 验证**：`pnpm dev` 启动成功、渲染无报错；截图验证因 macOS 屏幕录制权限未授予未做，渲染层验证由 HomeView.test.tsx 覆盖。

## 遗留事项

- 全局日报推送（企微/钉钉/邮件）按用户决策本期不做，后续可复用 `usePushDailyReport` 管线。
- 热力图档位 score 用 `runs + sessions`（不聚合各项目 git log，避免首屏 N 次 `git log` 开销）；如需 commits 维度，可加后台懒加载。
- 手动 UI 走查建议：启动落地首页 → 点热力图某天联动总结 → 生成全局日报（落盘 `~/.cortex-desktop/timeline/global-summary.json`）→ 重启确认日报仍在。
