---
title: "feat: 重做自动化详情页(对标设计稿)"
type: feat
date: 2026-06-24
status: ready
origin: "claude_design 项目 cortex desktop / Automation Detail.html (https://claude.ai/design/p/436be05f-4337-4e91-9b60-8dc55ce80670)"
depth: standard
---

# feat: 重做自动化详情页(对标设计稿)

## Summary

依据 claude_design 设计稿 `Automation Detail.html`,重做个人工作区的「自动化详情页」。
当前页面是「左栏提示词 `<pre>` + 右栏状态卡/配置卡/运行历史」的两列布局;设计稿把信息架构
重排为:**顶部操作栏**(状态徽章 + 启用开关 + 立即运行主按钮 + 编辑 + 更多菜单)、**主滚动区**
(状态 meta 行 → 最新结果 hero 卡片 → 可搜索/可展开的运行历史)、**右侧配置栏**(定时/Agent/
模型/推理强度/项目 + 删除)。提示词从主区降级,编辑仍走现有 `AutomationDialog` 弹窗。

这是一次**纯前端 UI 重做**:数据层(React Query hooks、`AutomationMeta`/`AutomationRun` 类型、
automation IPC)已全部就位,无需新增后端/IPC。改动集中在 `packages/views/cortex-desktop/personal/`
的组件层与 `cortex-desktop.css` 样式层,外加两个净新增的客户端动作(创建副本、导出运行历史)。

---

## Problem Frame

**现状**(`packages/views/cortex-desktop/personal/AutomationDetail.tsx`,286 行):
- 提示词占据主区左栏(大块 `<pre>`),挤压了「运行结果」这一用户真正关心的内容。
- 操作分散:启用开关埋在右栏卡片里,立即运行/编辑是不起眼的图标按钮。
- 运行历史点击后**整页切换**到运行详情;最新一次结果没有突出展示,要多点一次才能看到输出。
- 缺少复制/导出/创建副本等便捷操作。

**目标**:按设计稿重排信息层级,让「最新结果」成为视觉主角,操作集中到顶部操作栏,
配置收敛到右侧配置栏,提示词降级但仍可查看/编辑。在不动数据层与 IPC 的前提下完成。

**非目标**:不改自动化的创建/编辑表单逻辑(`AutomationDialog` 原样复用);不改调度/执行
后端;不引入新的 `AutomationMeta` 字段;不做深链(deeplink)机制。

---

## Requirements

源为设计稿(无 R/AE 编号),据设计稿与用户决策归纳为以下需求:

- **R1 顶部操作栏**:返回 + 标题 + 状态徽章(已启用/已停用)+ 启用开关 + 立即运行(主按钮)
  + 编辑 + 更多菜单。状态徽章与开关均反映 `meta.enabled`。
- **R2 状态 meta 行**:单行展示「上次结果状态 · 上次时间·耗时 · 下次运行 · 定时摘要」。
- **R3 最新结果 hero 卡片**:突出展示最近一次运行(`runs[0]`):成功/失败徽章、时间、耗时、
  操作按钮(复制、重新运行),正文用 `MarkdownView` 渲染 `output`/`error`;无运行时显示空态。
- **R4 运行历史(行内展开 + 整页详情)**:区头含运行计数 + 搜索框;每行可**就地展开**显示
  标题/摘要预览;点击「查看完整」进入**保留的整页运行详情**看完整 Markdown 输出;行尾删除;
  客户端分页「加载更多」。搜索按日期/标题/类型过滤。
- **R5 右侧配置栏**:定时 / Agent / 模型 / 推理强度 / 项目 五项摘要 + 「编辑」(打开
  `AutomationDialog`)+ 「删除自动化」(二次确认)。
- **R6 更多菜单**:复制提示词、导出运行历史、创建副本、删除自动化。**不含**复制链接。
- **R7 提示词降级**:提示词不再占主区,降级为只读折叠区(可复制、可点「编辑」打开弹窗)。
- **R8 视觉对齐**:沿用现有 CSS 变量体系与 `pw-auto-` 命名前缀;品牌主色统一用 `#7c5cff`
  (不引入设计稿的 `#5b50e6`)。

---

## Key Technical Decisions

- **KTD1 — 编辑全部复用 `AutomationDialog`,不引入抽屉**(用户决策)。设计稿画了「提示词抽屉」,
  但现有 `AutomationDialog` 已覆盖改名/agent/模型/定时/推理强度/提示词全字段且含 agent↔model
  联动校验,重建抽屉风险高、收益低。顶部「编辑」与配置栏「编辑」都打开现有弹窗
  (`onEdit(meta)` → `AutomationView` 的 `{ mode: "edit" }`)。提示词降级为主区底部只读折叠区。

- **KTD2 — 运行历史「行内展开预览 + 保留整页详情」**(用户决策)。行内展开只渲染标题 + 摘要
  (取 `output` 首段);完整输出仍走现有 `selectedRunId` 整页 `MarkdownView` 视图。两套视图职责
  分明:行内是「扫一眼」,整页是「读全文」。

- **KTD3 — 更多菜单去掉「复制链接」**(用户决策)。应用内无深链机制,复制链接无落点;其余四项
  (复制提示词 / 导出运行历史 / 创建副本 / 删除)均有数据支撑,全部真实实现。

- **KTD4 — 按职责拆分子组件,规避 1200 行上限**。当前 `AutomationDetail.tsx` 286 行,重做后
  节点大幅增加。拆为 `AutomationDetailHeader` / `AutomationConfigRail` / `AutomationHeroCard` /
  `AutomationRunHistory` 四个子组件,`AutomationDetail` 收敛为编排器 + 整页运行详情。每个文件远
  低于上限。所有子组件无模态/全局状态,状态(选中 run、分页、搜索、菜单开合)集中在编排器或组件
  本地(对齐现有「仿 TodosView,选中态不进全局 store」约定)。

- **KTD5 — 不动数据层**。`AutomationMeta`/`AutomationRun` 字段、`automation.ts` 全部 hooks
  (`useAutomationRuns`/`useRunAutomationNow`/`useSetAutomationEnabled`/`useDeleteAutomation`/
  `useCreateAutomation`/`useDeleteAutomationRun`)、automation IPC 已满足全部需求,本计划零 IPC 改动,
  规避「IPC 镜像三处同步」与「create 逐字段构造」两类历史坑。

- **KTD6 — 导出走渲染端 Blob 下载;删除沿用菜单内二次确认**。bridge 仅有 `writeFile(path)` 无保存
  对话框,导出用渲染端 `Blob` + `<a download>` + object URL 下载(JSON 全量,文件名含自动化名 +
  日期)。删除复用 `AutomationList` 已验证的「`confirming` state、按钮文案切『确认删除？』」模式
  (仿 `ProjectMenu`),不新建确认弹窗。

- **KTD7 — 「在会话中打开」本期延后**。设计稿 hero 有第三个动作「在会话中打开」,依赖把 chat UI
  导航到 `run.agentSessionId` 对应会话——当前 `DesktopBridge` 无此能力(仅有 `loadChat`/`saveChat`
  持久化,无 UI 选中/聚焦会话的入口)。本期 hero 动作只做「复制」「重新运行」,「在会话中打开」列入
  Open Questions 单独立项。

---

## High-Level Technical Design

重做后的详情页布局与数据来源:

```mermaid
flowchart TB
  subgraph Detail["AutomationDetail (编排器)"]
    direction TB
    Header["AutomationDetailHeader<br/>状态徽章·启用开关·立即运行·编辑·更多菜单"]
    subgraph Body["dt-body (两列)"]
      direction LR
      subgraph Scroll["主滚动区"]
        Meta["状态 meta 行"]
        Hero["AutomationHeroCard<br/>(runs[0] 最新结果)"]
        Prompt["提示词折叠区(只读·降级)"]
        Runs["AutomationRunHistory<br/>搜索·行内展开·分页"]
      end
      Rail["AutomationConfigRail<br/>定时/Agent/模型/强度/项目·编辑·删除"]
    end
  end
  RunPage["整页运行详情<br/>(selectedRunId · MarkdownView)"]

  Header -.->|onEdit| Dialog["AutomationDialog (复用)"]
  Rail -.->|onEdit| Dialog
  Runs -.->|onOpenRun(id)| RunPage
  Hero -. 复制/重新运行 .-> Hooks
  Header -. 启用/运行/副本/删除/导出 .-> Hooks["automation hooks<br/>(React Query)"]
```

数据流向(不变):所有读经 `useAutomationRuns(meta.id)` / `meta` prop;所有写经既有 mutation
hooks → automation IPC → 主进程 store/scheduler/runner,事件回灌触发 React Query 失效。

---

## Output Structure

```
packages/views/cortex-desktop/personal/
├── AutomationDetail.tsx            # 改:收敛为编排器 + 整页运行详情
├── AutomationDetailHeader.tsx      # 新:顶部操作栏 + 更多菜单
├── AutomationConfigRail.tsx        # 新:右侧配置栏 + 删除
├── AutomationHeroCard.tsx          # 新:最新结果 hero
├── AutomationRunHistory.tsx        # 新:搜索 + 行内展开 + 分页
├── automationFormat.ts             # 改:并入 AGENT_LABEL/EFFORT_LABEL、新增 fmtDuration
├── automationActions.ts            # 新:buildDuplicateInput / serializeRunsForExport
└── *.test.tsx                      # 各组件就近单测
packages/views/cortex-desktop/cortex-desktop.css   # 改:pw-auto-* 重做样式
```

---

## Implementation Units

### U1. 共享纯函数收敛与新增

**Goal**:把分散的展示标签与新动作逻辑收敛为可测纯函数,供各子组件复用。
**Requirements**:R2, R3, R5, R6。
**Dependencies**:无。
**Files**:
- `packages/views/cortex-desktop/personal/automationFormat.ts`(改)
- `packages/views/cortex-desktop/personal/automationActions.ts`(新)
- `packages/views/cortex-desktop/personal/automationFormat.test.ts`(新或扩充)
- `packages/views/cortex-desktop/personal/automationActions.test.ts`(新)

**Approach**:
- `automationFormat.ts`:把现散落在 `AutomationDetail.tsx`/`AutomationDialog.tsx` 的
  `AGENT_LABEL`、`EFFORT_LABEL` 迁入此处统一导出(消除漂移);把 `fmtDuration(run)` 从
  `AutomationDetail` 提到此处(纯函数)。
- `automationActions.ts`:
  - `buildDuplicateInput(meta: AutomationMeta): AutomationInput` — 从 meta 剥离服务端生成字段
    (`id`/`createdAt`/`updatedAt`/`lastRunAt`/`lastStatus`/`nextRunAt`),`name` 改为
    `${meta.name} 副本`,其余字段透传,供「创建副本」调用 `useCreateAutomation`。
  - `serializeRunsForExport(meta, runs): { filename: string; content: string }` — 序列化运行历史
    为 JSON 字符串,`filename` 形如 `${meta.name}-运行历史-YYYYMMDD.json`(去非法文件名字符)。

**Patterns to follow**:`automationFormat.ts` 现有纯函数风格(`scheduleSummary`/`fmtDateTime`/
`STATUS_LABEL`/`STATUS_CLASS`);`AutomationInput` 字段定义见 `packages/core/desktop/types.ts`。
**Test scenarios**:
- `buildDuplicateInput`:输入完整 meta → 返回对象**不含** `id/createdAt/updatedAt/lastRunAt/
  lastStatus/nextRunAt`;`name` 为「原名 副本」;`prompt/schedule/agent/model/effort/projectId` 等
  原样保留。
- `serializeRunsForExport`:空 runs → content 为合法 JSON(空数组);含特殊字符的自动化名 →
  filename 不含 `/ \ : * ? " < > |` 等非法字符;content 可被 `JSON.parse` 还原。
- `fmtDuration`:无 `endedAt` → 空串;<60s → `Ns`;≥60s → `Nm Ss`。
- `AGENT_LABEL`/`EFFORT_LABEL`:覆盖 claude/codex/pi、low/medium/high 全枚举。

### U2. 详情页重做样式(CSS)

**Goal**:为重做后的 DOM 提供全部样式,对齐设计稿视觉。
**Requirements**:R1–R8。
**Dependencies**:无(可与 U1 并行;先行落地便于其余单元联调)。
**Files**:`packages/views/cortex-desktop/personal/cortex-desktop.css`
(实际路径 `packages/views/cortex-desktop/cortex-desktop.css`,改)。
**Approach**:在现有 `pw-auto-*` 区块后成块新增,带注释分隔。新增类(沿用设计稿语义、`pw-auto-`
前缀):顶部操作栏(`pw-auto-dt-head`、状态 pill `pw-auto-status-pill[.off]`、主按钮 `.btn.primary`
复用)、状态 meta 行(`pw-auto-meta-line`)、hero 卡片(`pw-auto-output-card`/`-top`/`-body`)、
运行历史区头 + 搜索框(`pw-auto-runs-head`、`pw-auto-search`)、行内展开(`pw-auto-run[.open]`、
`pw-auto-run-detail`)、右侧配置栏(`pw-auto-config`、`pw-auto-cfg-item`)、提示词折叠区
(`pw-auto-prompt-acc`,设计稿已提供 `.prompt-acc` 参考)、更多菜单(复用现有 `pw-ctx-menu` +
`pw-tb-menu-item`)。深色模式经现有 `[data-theme="dark"]` token 自动覆盖,品牌色处硬编码 `#7c5cff`
(hover `#6a48f0`),对齐 `.pw-auto-tpl-btn` 既有写法。
**Patterns to follow**:现有 `pw-auto-detail-*`/`pw-auto-card-*`/`pw-auto-run-*` 样式块;
品牌色字面量见 `.pw-auto-tpl-btn:hover`;菜单见 `.pw-ctx-menu`。
**Test expectation**:none —— 纯样式,行为由各组件单测覆盖。

### U3. 顶部操作栏 `AutomationDetailHeader`

**Goal**:抽出并重做顶部操作栏:状态徽章 + 启用开关 + 立即运行 + 编辑 + 更多菜单。
**Requirements**:R1, R6。
**Dependencies**:U1。
**Files**:
- `packages/views/cortex-desktop/personal/AutomationDetailHeader.tsx`(新)
- `packages/views/cortex-desktop/personal/AutomationDetailHeader.test.tsx`(新)

**Approach**:props 接收 `meta`、`onBack`、`onEdit`、`onRun`、`onToast`、`onDuplicate`、
`onExport`、`onDelete`、`enablePending`。渲染:返回、标题(`meta.name || "未命名自动化"`)、
状态 pill(`meta.enabled` → 「已启用/已停用」+ off 样式)、启用开关(`twk-toggle`,
`useSetAutomationEnabled`,失败 toast)、立即运行主按钮(`onRun`,运行中态)、编辑按钮
(`onEdit(meta)`)、更多菜单(仿 `ProjectMenu`/现有更多菜单:fixed 定位、点外/ESC 关闭):复制提示词
(`navigator.clipboard` + toast)、导出运行历史(`onExport`)、创建副本(`onDuplicate`)、删除自动化
(`onDelete`,菜单内二次确认)。
**Patterns to follow**:更多菜单与二次确认仿 `AutomationList.tsx`(`confirming` state)/`ProjectMenu.tsx`;
开关仿现有 `twk-toggle[data-on]`;复制仿 `AutomationDetail` 现有 `CopyButton`。
**Test scenarios**:
- 启用态:`enabled=true` → pill 文案「已启用」无 off 类、开关 `data-on="1"`;`false` → 反之。
- 点开关 → 调 `useSetAutomationEnabled.mutate({id, enabled:!})`;mutate 报错 → `onToast` 收到失败文案。
- 点立即运行 → `onRun` 被调用一次。
- 点编辑 → `onEdit(meta)` 被调用。
- 更多菜单:点开后含「复制提示词/导出运行历史/创建副本/删除自动化」四项,**不含**复制链接;
  点复制提示词 → 写入剪贴板(mock `navigator.clipboard.writeText`)+ toast;点导出/创建副本 →
  对应回调各调一次;点删除第一次 → 文案变「确认删除？」,第二次 → `onDelete` 被调用;点菜单外/ESC → 菜单关闭。

### U4. 右侧配置栏 `AutomationConfigRail`

**Goal**:重做右侧配置摘要栏 + 编辑/删除入口。
**Requirements**:R5。
**Dependencies**:U1。
**Files**:
- `packages/views/cortex-desktop/personal/AutomationConfigRail.tsx`(新)
- `packages/views/cortex-desktop/personal/AutomationConfigRail.test.tsx`(新)

**Approach**:props 接收 `meta`、`projectName`、`onEdit`、`onDelete`。渲染配置标题 + 「编辑」
(`onEdit(meta)` → 打开 `AutomationDialog`)、五行配置项(定时 `scheduleSummary(meta.schedule)`、
Agent `AGENT_LABEL[meta.agent]`、模型 `meta.model || "默认"`、推理强度 `meta.effort ?
EFFORT_LABEL : "默认"`、项目 `projectName ?? "无(主目录)"`)、底部「删除自动化」(二次确认 →
`onDelete`)。`projectName` 由编排器从 `usePersonalStore` 解析后下传(保持组件纯展示)。
**Patterns to follow**:配置项展示沿用现有 `pw-auto-card-row` 语义;删除二次确认同 U3。
**Test scenarios**:
- 五项配置按 `meta` 正确渲染:含 model/effort 时显示标签,缺省显示「默认」;`projectId` 为空 →
  「无(主目录)」。
- 点编辑 → `onEdit(meta)`;点删除二次确认 → `onDelete`。
- 定时摘要对各 `schedule.kind`(daily/weekly/cron/once…)显示正确文案(经 `scheduleSummary`)。

### U5. 最新结果 hero 卡片 `AutomationHeroCard`

**Goal**:把最近一次运行结果做成视觉主角。
**Requirements**:R3。
**Dependencies**:U1。
**Files**:
- `packages/views/cortex-desktop/personal/AutomationHeroCard.tsx`(新)
- `packages/views/cortex-desktop/personal/AutomationHeroCard.test.tsx`(新)

**Approach**:props 接收 `latestRun?: AutomationRun`、`onRerun`、`onToast`。无 `latestRun` → 空态
(「暂无运行结果」+ 引导)。有则渲染:状态徽章(`STATUS_CLASS`/`STATUS_LABEL`)、时间
(`fmtDateTime(startedAt)`)、耗时(`fmtDuration`)、动作(复制 `output||error` → 仿 `CopyButton`;
重新运行 → `onRerun`),正文 `MarkdownView` 渲染 `error || output`(error 套 `is-err` 样式)。
**「在会话中打开」按 KTD7 本期不渲染**(留注释说明延后原因)。
**Patterns to follow**:`MarkdownView` 用法与 error 态样式见现有整页运行详情;复制仿 `CopyButton`。
**Test scenarios**:
- 无 `latestRun` → 渲染空态文案,不渲染动作区。
- 成功 run → 徽章「成功」、显示时间/耗时、正文为 `output`。
- 失败 run(有 `error`)→ 徽章「失败」、正文为 `error`、套 `is-err`。
- 点复制 → 写入剪贴板(mock)。
- 点重新运行 → `onRerun` 调用一次。
- 断言**不存在**「在会话中打开」按钮(防回归引入未支撑能力)。

### U6. 运行历史 `AutomationRunHistory`(搜索 + 行内展开 + 分页)

**Goal**:重做运行历史:区头计数 + 搜索 + 行内展开预览 + 加载更多;点「查看完整」回调整页。
**Requirements**:R4。
**Dependencies**:U1。
**Files**:
- `packages/views/cortex-desktop/personal/AutomationRunHistory.tsx`(新)
- `packages/views/cortex-desktop/personal/AutomationRunHistory.test.tsx`(新)

**Approach**:props 接收 `runs`、`onOpenRun(id)`、`onDeleteRun(id)`。本地 state:`query`(搜索)、
`visibleCount`(分页,初值 `RUNS_PAGE_SIZE=10`)、`openId`(行内展开的 run id,单开)。区头:标题 +
计数(搜索时显示「命中/总数」)+ 搜索框。列表:`runs` 经搜索过滤(按 `fmtDateTime`/标题摘要/trigger
文案小写包含匹配)后 `slice(0, visibleCount)`;每行:状态徽章、时间、类型标签(手动/定时)、耗时、
展开 chevron;点行 → 切 `openId`,展开区渲染标题 +摘要(`output` 首段截断)+「查看完整」按钮
(`onOpenRun(run.id)`)+ 删除;末尾「加载更多(剩 N 条)」。空态/无命中态文案。
**Patterns to follow**:分页 `visibleCount` 与删除 `stopPropagation` 仿现有 `RunItem`/
`AutomationDetail`;搜索过滤仿设计稿 `runSearch` 逻辑(`textContent.toLowerCase().includes`)。
**Test scenarios**:
- 渲染:`runs.length>visibleCount` → 显示「加载更多」,点击后多渲染一页。
- 行内展开:点某行 → 该行展开显示摘要预览;再点别行 → 前一行收起(单开)。
- 「查看完整」→ `onOpenRun(id)` 调用;行尾删除 → `onDeleteRun(id)` 调用且不触发展开。
- 搜索:输入命中关键字 → 仅命中行显示、计数变「命中/总数」;输入无命中 → 显示无命中态。
- 空 runs → 显示「暂无运行记录」。
- Covers 设计稿运行历史搜索:输入「手动」过滤出 trigger=manual 的行。

### U7. 编排器重组 `AutomationDetail`(整合 + 整页运行详情 + 动作接线)

**Goal**:把 `AutomationDetail` 收敛为编排器,组装新布局,保留整页运行详情,接线全部动作。
**Requirements**:R1–R8(整合)。
**Dependencies**:U1, U2, U3, U4, U5, U6。
**Files**:
- `packages/views/cortex-desktop/personal/AutomationDetail.tsx`(改,大幅瘦身)
- `packages/views/cortex-desktop/personal/AutomationDetail.test.tsx`(新)

**Approach**:
- 数据:`useAutomationRuns(meta.id)`、`useRunAutomationNow`、`useDeleteAutomation`、
  `useCreateAutomation`、`useDeleteAutomationRun`、`usePersonalStore`(解析 projectName)。
- 状态(本地,不进全局 store):`selectedRunId`(整页运行详情)。切换 `meta.id` 时重置(沿用现有
  useEffect);选中 run 失效自动退出(沿用)。
- 布局:`pw-auto-detail` → `AutomationDetailHeader` + `dt-body`(主滚动区:状态 meta 行 +
  `AutomationHeroCard latestRun={runs[0]}` + 提示词只读折叠区 + `AutomationRunHistory`)+
  `AutomationConfigRail`。
- 整页运行详情:`selectedRun` 存在时整页切换渲染(沿用现有 `MarkdownView` + 复制 + 删除),
  由 `AutomationRunHistory` 的 `onOpenRun` 设置 `selectedRunId`。
- 动作接线:立即运行(`runNow`,skipped/成功/失败 toast,沿用现有文案)、创建副本
  (`buildDuplicateInput` → `useCreateAutomation`,成功 toast「已创建副本」)、导出
  (`serializeRunsForExport` → Blob + `<a download>` 下载 + toast)、删除自动化
  (`useDeleteAutomation`,成功后 `onBack` 回列表;`AutomationView` 也会因选中项消失自动回退)、
  编辑(`onEdit(meta)` 透传)、删除单条 run(沿用 `removeRun`)。
- 提示词降级:主区底部 `pw-auto-prompt-acc` 只读折叠(默认收起),含复制 + 「编辑」(`onEdit`)。
**Execution note**:先为「选 run → 整页详情 → 返回」「创建副本」「导出」三条主链路写集成测试,再接线。
**Patterns to follow**:整页运行详情/选中态重置/`removeRun` 均沿用当前 `AutomationDetail.tsx` 实现;
toast 经 `onToast` prop 链路(勿直连 `pushToast`)。
**Test scenarios**:
- 布局:渲染含 header、meta 行、hero、运行历史、配置栏五大区(按 testid/文案断言)。
- 整页详情:经运行历史 `onOpenRun` 进入整页 → 显示完整 `MarkdownView` 输出;返回 → 回到列表态。
- 创建副本:触发后调 `useCreateAutomation`,入参为 `buildDuplicateInput(meta)`,成功 toast。
- 导出:触发后生成 Blob 下载(mock `URL.createObjectURL`/anchor click),toast「运行历史已导出」;
  无运行记录时导出空数组 JSON 不报错。
- 删除自动化:确认后调 `useDeleteAutomation` 并 `onBack`。
- 切换 `meta.id`:`selectedRunId` 重置,不串场。
- 提示词折叠:默认收起,展开后显示 `meta.prompt`,点编辑 → `onEdit(meta)`。

---

## System-Wide Impact

- **`AutomationView.tsx`**:仅作为父级透传 `onEdit`/`onToast`,无需改动(编辑仍走
  `{ mode: "edit" }` → `AutomationDialog`)。删除后选中项消失的自动回退逻辑已存在,与本计划的
  「删除后 onBack」叠加无副作用(幂等)。
- **`AutomationDialog.tsx`**:零改动(复用)。
- **`automationFormat.ts` 的标签迁移**:`AutomationDialog.tsx`/`AutomationList.tsx` 若也局部定义了
  `AGENT_LABEL`/`EFFORT_LABEL`,迁移后应改为从 `automationFormat` 导入,避免重复定义(`pnpm typecheck`
  兜底)。
- **CSS**:`cortex-desktop.css` 体量增长(现 8090 行);新增成块、加注释,沿用 `pw-auto-` 前缀,
  不影响其他面板。
- **数据层/IPC**:零改动。

---

## Risks & Dependencies

- **R-风险1 单文件行数**:重做易触 1200 行上限——已用 KTD4 拆分四子组件缓解,`AutomationDetail`
  瘦身后应明显低于上限。实现期每个文件落地后核对行数。
- **R-风险2 标签迁移漂移**:迁移 `AGENT_LABEL`/`EFFORT_LABEL` 时若漏改某个引用点,会留下重复定义。
  实现期 `rg "AGENT_LABEL|EFFORT_LABEL"` 全仓核对,统一指向 `automationFormat`。
- **R-风险3 导出下载在 Electron 渲染端**:`Blob` + `<a download>` 在 Electron renderer 通常可用,
  但若被 CSP/沙箱拦截需回退到 bridge `writeFile`(无对话框,落固定下载目录)。实现期实测一次下载。
- **依赖**:无外部依赖;全部基于既有 hooks 与组件。

---

## Open Questions

- **OQ1 「在会话中打开」hero 动作(延后)**:需要新增「把 chat UI 导航/聚焦到 `run.agentSessionId`
  对应会话」的桥接与 UI 选中能力(当前 `DesktopBridge` 仅有 `loadChat`/`saveChat` 持久化)。建议本期
  不做,后续单独立项(涉及 chat 列表选中 + 可能的跨视图导航)。
- **OQ2 导出格式**:本期定 JSON 全量导出;是否需要额外的 Markdown 拼接导出(便于直接阅读)留待
  实现期/后续按反馈决定。

---

## Sources & Research

- 设计稿:claude_design 项目「cortex desktop」/ `Automation Detail.html`
  (`https://claude.ai/design/p/436be05f-4337-4e91-9b60-8dc55ce80670`)。
- 现有实现:`packages/views/cortex-desktop/personal/AutomationDetail.tsx`(286 行)、
  `AutomationView.tsx`、`AutomationList.tsx`、`AutomationDialog.tsx`、`automationFormat.ts`。
- 数据层:`packages/core/personal/automation.ts`(hooks)、`packages/core/desktop/types.ts`
  (`AutomationMeta`/`AutomationRun`/`AutomationInput`)。
- IPC:`apps/desktop/src/main/automation/ipc.ts`。
- 样式:`packages/views/cortex-desktop/cortex-desktop.css`(`pw-auto-*` 区,品牌色 `#7c5cff`)。
- 历史经验:`docs/plans/2026-06-21-001`(全局 toast 富样式,`pushToast` 已升级)、
  `docs/plans/2026-06-21-002`(automation IPC 镜像/逐字段构造坑)、
  `docs/plans/2026-06-20-003`(automation 模板 `pw-auto-tpl-*` 命名)。
- 记忆:品牌主色 `#7c5cff`(hover `#6a48f0`)。
