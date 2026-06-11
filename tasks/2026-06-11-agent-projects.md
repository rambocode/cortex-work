# 首页「Agent 项目」统计：扫描系统所有 agent 会话日志

计划见 `/Users/mike/.claude/plans/ancient-kindling-blossom.md`（已批准）。参考 fanbox `agentProjects()` 移植。

## 待办

- [x] 类型：`AgentProjectInfo`（core/desktop/types.ts + ipc/types.ts 镜像 + core/index.ts 导出）
- [x] 主进程：agent-projects.ts（扫描聚合 + 60s 缓存 + IPC `agents:scanProjects`）+ agent-projects-parse.ts（`extractCwd` 纯函数，独立文件避免 electron 进测试链）
- [x] TDD：agent-projects-parse.test.ts（extractCwd 5 用例）
- [x] bridge.ts + preload/index.ts 接线
- [x] core/home.ts：`useAgentProjects` + `mergeProjectRows` 纯函数 + home.test.ts 补 3 用例
- [x] HomeView：合并列表（agent 圆点 / 未添加徽标 / 点击添加）+ HomeView.test.tsx 补 3 用例
- [x] cortex-desktop.css：`.pw-agent-dot`（claude `#d97757` / codex `var(--green)`）+ `.pw-home-proj-badge`
- [x] pnpm test + typecheck + lint 全绿
- [x] 任务文件回填

## 执行结果

- **测试**：113 个全过（core 56 / ui 3 / views 23 / desktop 31），typecheck、lint 通过。新增 11 个测试。
- **行为**：首页「Agent 项目」区块 = 工作区项目 ∪ 系统扫描项目（按 path 去重、忽略尾部斜杠），按最后活跃倒序；扫描范围 `~/.claude/projects`（每项目最新 jsonl）+ `~/.codex/sessions`（近 30 天 rollout 最新 40 个），读文件头反解 cwd；主进程 60s 缓存 + renderer react-query staleTime 60s。点击未添加项目 → `addProject` 加入工作区。
- **附带调整**：工作区无项目时首页不再整页空态（扫描结果可供一键添加）。
- **与并行任务共存**：本次实现期间另有 Todos 功能并行落地（store/types/HomeView 均有其改动），已确认互不冲突、全量回归通过。

## Bug 修复：点击添加后 fs:scanDirTree 报「路径不在允许范围内」

- **根因**：主进程 fs 白名单（`assertAllowed`）以**落盘的** persisted state 为准，而 renderer 持久化有 500ms 节流——`addProject` 后右栏立即 `fs:scanDirTree`，主进程还没看到新项目。
- **修复**（双保险）：
  1. `apps/desktop/src/main/ipc/store.ts`：加内存镜像，`store:save` 到达即同步更新，`getPersistedState` 优先读镜像（顺带省去每次白名单校验的磁盘读）。
  2. `packages/core/desktop/usePersonalPersistence.ts`：抽出纯函数 `saveUrgency`——`projects`/`promptRoot`（白名单数据源）变更**立即**保存，其余切片维持节流；同源 IPC 按序处理，保证 save 先于后续 fs 调用。
- 新增 `usePersonalPersistence.test.ts` 5 用例；全量 118 测试 + typecheck + lint 绿。

## 手动验证清单（用户执行）

1. 启动应用 → 首页「Agent 项目」列出本机项目（对照 `ls ~/.claude/projects` / `~/.codex/sessions`）。
2. 圆点：橙=Claude Code、绿=Codex；两家都用过的项目应有两个点；时间为相对格式（刚刚/N 分/N 时/N 天）。
3. 检索框可过滤全集（含未添加项目）。
4. 点击带「未添加」徽标的行 → 项目加入左侧工作区列表。
