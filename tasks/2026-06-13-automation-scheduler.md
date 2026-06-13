# 自动化工具（定时任务） — 实施记录

日期：2026-06-13　计划：`~/.claude/plans/swift-bouncing-barto.md`

## 需求
左侧菜单「项目」上方新增「自动化」：创建定时任务（标题/提示词/默认 agent/项目/定时器/模型/推理强度），列表（快速执行/编辑/暂停/删除），详情（左标题+内容，右状态+运行历史），定时器支持每小时/每天/工作日/每周/自定义 cron。到点自动调用 agent 执行并生成记录。

## 已确认范围
- 后台执行 = 加系统托盘常驻（关窗驻留后台、定时仍触发）
- 完成通知 = 应用内 toast
- 推理强度 = 统一低/中/高，执行时翻译各 agent CLI 参数，pi 忽略

## 完成项（全部 ✅）
- [x] 阶段1 契约：两处 `types.ts` 镜像新增 automation 类型 + `CliStartRequest.effort` + 主进程 `PiSettings`/`PersistedState.piSettings`；`bridge.ts` 加可选方法+事件；`croner@10.0.1`；`automation/schedule-cron.ts`(+19 单测)
- [x] 阶段2 主引擎：`automation/{store,runner,scheduler,events,ipc}.ts`；`paths.ts`；adapter effort 翻译（claude `--effort`、codex `-c model_reasoning_effort=`、pi 忽略，各加单测）；`register.ts` 注册
- [x] 阶段3 生命周期：`index.ts` 单实例锁 + 托盘 + close→hide + window-all-closed 不退出 + before-quit 才 killAllAutomations + powerMonitor.resume 补漏；`automation/tray.ts`
- [x] 阶段4 数据层：`core/personal/automation.ts`（React Query hooks + 乐观更新 + 事件订阅）；`store/personal.ts` 加 `automationOpen` + 5 处互斥；`preload/index.ts` 桥
- [x] 阶段5 UI：`PersonalSidebar` 入口、`PersonalWorkspace` 分支、`AutomationView/List/Detail/Dialog/ScheduleEditor`、`automationFormat.ts`、CSS
- [x] 阶段6 验证：见下

## 关键设计
- **数据 owner 在主进程**（独立于 personal-workspace.json），仿 update.ts 广播模式
- **无头执行器独立注册表** `runningAutomations`（+ 同步 `pending` 占位防并发），与 cli.ts 的 `running` 隔离 → killAllCli 不误杀定时任务
- **pi 通道**：runner 用 `getPersistedState()` 从 piSettings 解析（含 apiKey），关窗后可用
- **croner** 调度；并发去重靠 runner 层（croner protect 对同步回调无效，已注释说明）

## 验证结果
- 自动化测试：desktop 128 passed、views 116 passed、core/web typecheck 全绿、electron-vite build 成功（croner 正确打包）
- 三路对抗审查（子 agent）：
  - 契约一致性：两份 types 镜像/bridge/preload/ipc/事件三方逐字段对齐 ✅
  - cron/effort/数据层/视图：cron 映射经 croner 实测（含 weekday=0 周日、after 严格语义）、effort flag 经官方文档查证属实、乐观更新幂等、5 处视图互斥齐全 ✅
  - 生命周期/并发：关窗驻留链路、注册表隔离、catch-up、settle 幂等均正确；**修复 2 项**：
    - [HIGH] `writePiExtension` 异常逃逸导致 `pending` 永久泄漏 → 已纳入 try/finalize
    - [LOW] scheduler 误导性 `protect:true`（对同步回调无效）→ 已移除 + 注释

## 待办 / 已知限制（交用户验证或后续）
- 托盘图标暂用 `cortex-neuron-icon.png` 占位（非 macOS template image，深浅色菜单栏不自适应）；后续加 `assets/tray-iconTemplate.png`
- 窗口关闭期间完成的任务，重开**不补播 toast**（详情运行历史/列表 lastStatus 仍可见结果）——有意简化
- 打包态（dist）真机端到端（关窗后定时触发、pi asar.unpacked 路径、托盘显隐）需手动验证

## 人工 UI 验证清单
见计划文件「验证方案 - 人工 UI 验证清单」9 条。
