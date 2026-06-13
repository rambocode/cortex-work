# 项目悬停菜单 + pi 兜底 Agent

计划详情见 `/Users/mike/.claude/plans/synthetic-weaving-steele.md`（已批准）。

## A. 侧边栏项目悬停菜单
- [x] A1 数据模型：ProjectMeta 加 pinnedAt/archivedAt + EditorInfo（两处 types 镜像）+ bridge/preload 契约（已由脚手架完成）
- [x] A2 Store：updateProject / archiveProject（清 pin、让焦点）/ partitionProjects 纯函数 + 单测
- [x] A3 编辑器检测：editors.ts（darwin 扫 .app + 60s 缓存 + open -a）+ IPC/bridge/preload + 单测
- [x] A4 UI：ProjectMenu.tsx（fixed 定位、二级面板、删除二次确认）+ PersonalSidebar 改造（悬停显隐、置顶排序、已归档分组）+ CSS

## B. pi 兜底 Agent
- [x] B0 实测 pi CLI 契约（--mode json 的 JSONL 事件格式）
  - Electron 39 内置 Node v22.22.1 ≥ pi 0.79.2 要求的 22.19，ELECTRON_RUN_AS_NODE 路线实测可行
  - 包 exports 不含 ./package.json 且仅有 import 条件 → 入口解析不能用 require.resolve，改用 app.getAppPath() 拼路径
  - pi 原生支持 --append-system-prompt（计划假设错误，无需 prompt 前缀拼接）；有 --no-skills/--no-extensions
  - 关键陷阱：provider 失败时进程 exit=0，错误在 message_end 的 stopReason:"error" + errorMessage/diagnostics[]
  - 流式：message_update.assistantMessageEvent {type:"text_delta",delta}；工具：tool_execution_start {toolName,args}
  - result 策略：message_end(assistant) stopReason stop|length→ok:true / error|aborted→ok:false / toolUse→忽略；agent_end 不发射
- [x] B1 内置分发：依赖 + asarUnpack + pi-locate.ts（ELECTRON_RUN_AS_NODE）
- [x] B2 pi adapter：buildArgs/parseLine + 注册 + 表驱动单测
- [x] B3 AgentKind 加 "pi" + AGENT_MODELS/DEFAULT_MODEL + PiSettings 配置（SettingsMenu）+ key 注入链路
- [x] B4 检测与兜底：agents:detect IPC + agentsAvailable store + defaultAgent + select 动态生成
- [x] B5 UI 字符串映射逐处补 pi

## 验证
- [x] pnpm typecheck + pnpm test 全绿
- [ ] 打包验证 dist:desktop:dir（app.asar.unpacked 含 pi）（deferred：未在收尾阶段执行实际打包）
- [ ] 手动验证清单（用户负责 UI 验证）

## 执行记录

### 2026-06-13 收尾提交（Ship）

各模块结果：
- A 侧边栏项目悬停菜单：Store 新增 `updateProject` / `archiveProject`（设 archivedAt、清 pinnedAt、让出 active/timeline 焦点）与纯函数 `partitionProjects`（置顶在前按 pinnedAt 降序、已归档按 archivedAt 降序），均已在 `packages/core/store/personal.test.ts` 覆盖；编辑器检测 `apps/desktop/src/main/ipc/editors.ts`（darwin 扫 .app + 60s 缓存 + `open -a`）含 `editors.test.ts` 单测；UI 新增 `ProjectMenu.tsx`（fixed 定位、二级面板、删除二次确认）并改造 `PersonalSidebar.tsx`（悬停显隐、置顶排序、已归档分组）+ CSS。
- B pi 兜底 Agent：新增 `apps/desktop/src/main/agents/pi.ts`（buildArgs/parseLine）+ `pi-locate.ts`（ELECTRON_RUN_AS_NODE 路线）+ 表驱动单测 `pi.test.ts`；在 `agents/index.ts` 注册；AgentKind 全链路补 "pi"（types 两处镜像、AGENT_MODELS/DEFAULT_MODEL、PiSettings + SettingsMenu 配置、cli.ts key 注入）；`agents:detect` IPC + `agentsAvailable` store + `defaultAgent` 兜底 + UI 字符串逐处补 pi；`electron-builder.yml` 加 asarUnpack、`package.json` 加依赖。

验证结论：
- `pnpm typecheck` 全绿（5/5 任务通过）。
- `pnpm test` 全绿：ui 1 文件 / core 10 文件 / views 16 文件(114 用例) / desktop 9 文件(81 用例)，全部通过。
- 提交前剔除了 `apps/web/tsconfig.tsbuildinfo` 的增量改动（typecheck 副产物、与本任务无关），`.gitignore` 已忽略 `dist/`、`out/`，无构建产物入库。

deferred 项：
- 实际打包验证 `dist:desktop:dir`（确认 app.asar.unpacked 含 pi）未在收尾阶段执行。
- 手动 UI 验证清单按约定由用户负责。
