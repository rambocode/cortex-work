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
- [x] 打包验证 dist:desktop:dir（app.asar.unpacked 含 pi）
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
- ~~实际打包验证 `dist:desktop:dir`~~（已在补充验证完成）。
- 手动 UI 验证清单按约定由用户负责。

### 2026-06-13 补充验证（workflow 验证阶段 4 路被 API 限流跳过，事后补跑）

- V1 测试质量：三个新测试文件断言真实锁契约；补了 `stopReason:"aborted"` 用例（pi.test.ts 13/13）。
- V2 pi 实物对账：用 buildArgs 同款参数真跑内置 pi（Electron 内置 Node），把捕获的真实 JSONL 喂给真实 piAdapter.parseLine——错误路径（exit 0 + stopReason:"error" + errorMessage 透出）与 `--session` 续会话（两轮 session id 完全一致）均通过。本机 codex 订阅 `deactivated_workspace`，成功路径的 text_delta 形状以 pi-agent-core 源码 + 单测锁定。
- V3 契约审计：两处 types 镜像逐字段一致；IPC 通道名三方对齐；Record<AgentKind> 各处含 pi；无残留写死 "claude" 的新建会话；pi key 注入只对 agent==="pi" 生效。
- V4 打包验证：dist:desktop:dir 产物 app.asar.unpacked 含 pi 入口与四个 @earendil-works 包；**用打包产物完整跑通 agent 回路**（session→provider 调用，与开发态行为一致）。重要发现：electron-builder 打包时拍平 node_modules（无 .pnpm 目录），yml 里三条 `.pnpm/...` glob 是死配置已清理；asar 内依赖经 Electron Node 模式的 asar 感知加载器可正常解析，无需全量 unpack。
- V5 UI 陷阱：workflow 内已跑（修复 partitionProjects 排序稳定性）；补查 CSS/JSX class 匹配与 .pw-ctx-menu position:fixed ✓。

## 手动验证清单（待用户执行）
1. 悬停项目行 → ⋯ 与 + 淡入；移开淡出；菜单打开时按钮不消失
2. Open in → 列出本机已装编辑器；点击用对应编辑器打开项目；「在访达中显示」正常
3. 删除 → 首点变「确认删除？」红色；二点移出列表；重启 app 后仍移除且磁盘目录还在
4. 置顶 → 跳到最前 + pin 常驻标识；再点取消回原位；重启保持
5. 归档 → 移入底部「已归档 (n)」折叠分组；取消归档回主列表；归档当前正在查看的项目时主区让出焦点
6. 时间线菜单项 → 行为同原时钟按钮
7. 设置 → Agent Tab：配置 Pi 的 provider/模型/API Key 后，会话切到 Pi 发消息可流式回复
8. 模拟无 claude/codex（改 PATH 或新机器）→ 新建会话默认落 Pi；agent 下拉中未安装项显示「（未安装）」且禁用
