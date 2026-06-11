# 项目时间线（日历视图 + 时间线视图）构思方案

> 状态：已完成（2026-06-11）。
> 决策：① 只做个人工作区；② 入口为主区项目级视图；③ 回填历史会话；④ AI 日报进第一版。

## 一、定位

个人工作区（桌面端）内，**每个项目一条时间线**，回答"什么时间、哪个会话、做了什么、改了哪些东西"。
两个视图共享同一份数据：

- **日历视图**：按天聚合的鸟瞰（月历 + 活跃度热力），用于快速定位"哪天干了活"。
- **时间线视图**：按天分组的明细事件流，用于回看具体做了什么。

## 二、数据层（核心：事件溯源）

### TimelineEvent 类型（packages/core/desktop/types.ts）

```ts
interface TimelineEvent {
  id: string;
  projectId: string;
  sessionId?: string;
  ts: number;
  kind: "session.created" | "run" | "git.commit" | "summary.day";
  title: string;        // run = prompt 首行摘要
  summary?: string;     // run = agent result 摘要；summary.day = 日报全文
  files?: string[];     // run 中 Edit/Write 工具触碰的文件（相对路径）
  meta?: { agent?: AgentKind; durationMs?: number; ok?: boolean; hash?: string };
}
```

### 采集点（全部插在现有管线，零额外成本）

1. `createSession`（store/personal.ts）→ 记一条 `session.created`。
2. CLI run 生命周期（personal/messages.ts 的 `handleCliEvent`/`onCliExit`）→ run 结束时落一条 `run` 事件：
   - title = 用户 prompt 首行；
   - summary = result 文本截断；
   - files = 流式 `tool` 事件中 Edit/Write/NotebookEdit 的 detail 里抽取的文件路径（**变更记录的运行级粒度**）；
   - meta = agent / 耗时 / 成败。
3. （增强，可后置）git 仓库项目：打开时间线时按需 `git log --since/--until` 拉当天 commits，合入展示（不落盘）。

### 持久化

沿用 `saveChat` 模式：主进程 userData 下 `timeline/<projectId>.json`，
bridge 新增 `loadTimeline(projectId)` / `appendTimelineEvents(projectId, events)` 两个 IPC。
追加写 + 节流，与现有消息落盘一致。

## 三、自动生成内容（两级）

- **L1 规则聚合（默认、即时、零 token）**：当天 N 个会话 / M 轮交互 / 改动 K 个文件 + run 标题列表。日历格 hover 卡片和天头部都用它。
- **L2 AI 日报（按钮触发、有缓存）**：复用已有 CLI 通道（`claude -p`），把当天事件 JSON 喂入生成一段中文日报，结果作为 `summary.day` 事件写回，不重复生成。

第一版先做 L1，L2 做成天头部的"生成日报"按钮。

## 四、视图层（packages/views/cortex-desktop/personal/）

入口（待确认）：项目行 hover 出现时间线图标 → 主区切换为项目级 `TimelineView`，顶部 segmented 切换「日历 | 时间线」。

### 日历视图
- 月历网格；每格：热力底色（run 次数）+ 角标（变更文件数）。
- hover → L1 摘要浮层；点击 → 切到时间线视图并滚动定位该天。
- 快捷操作：回到今天、上/下月、生成日报。

### 时间线视图
- 按天倒序分组；天头部 = 日期 + L1 统计 chips + 已生成的 AI 日报。
- 事件流：run 卡片（prompt 摘要 → 结果摘要 → 文件变更折叠列表）、session 创建、commit。
- 点击 run / session → 跳回对应会话。

## 五、实施阶段

- [x] P1 core：TimelineEvent 类型 + 采集插桩 + 历史回填 + React Query hooks（含 11 项单测）
- [x] P2 desktop：timeline 持久化 IPC（`timeline:load/save` → `~/.cortex-desktop/timelines/`）+ `fs:gitLog` + preload 镜像；AI 日报复用已有 `oneshotCli`
- [x] P3 views：TimelineView 时间线子视图 + 项目行 Clock 图标入口 + 主区切换
- [x] P4 views：日历子视图（周一起始、热力格、点击跳转定位）+ 两视图联动
- [x] P5 AI 日报按钮（haiku 生成，落盘为 summary.day 事件，可重新生成）

## 六、执行结果

- 全仓 `pnpm typecheck` / `pnpm test`（40 项）/ `pnpm lint` / `pnpm build` 全部通过。
- `git log` 输出格式与 `--since=@<epoch>` 写法已用临时仓库实测验证。
- 与同期 `/clear` → `hiddenHistory` 重构（store/types/messages 改动）无冲突，插桩完整保留。

### 已知限制 / 后续可做

1. **历史回填的时间粒度**：旧消息只存 `HH:MM` 无日期，回填事件统一归到 session 的 `updatedAt` 所在天（带 `meta.backfilled` 标记，UI 显示"历史"）。上线后的新事件均为真实时间戳。
2. 被主进程截断（>80 字符）的工具 file_path 不计入变更文件，宁缺毋假。
3. 日历热力分级为固定阈值（1-2/3-5/6-10/>10 轮），后续可按项目活跃度自适应。
4. 团队侧（Go server）时间线未动，事件模型可直接平移。
