---
date: 2026-06-16
topic: flash-note-deepen-brainstorm-plan-todos
focus: 闪记点击深化调用 ce-brainstorm，最终生成 ce-plan 进入 todos 列表，todos 根据 md 源数据判断是否实现
mode: repo-grounded
---

# Ideation: 闪记深化 → Brainstorm → Plan → Todos 完整流水线

## Grounding Context

**Codebase Context**

项目：cortex-work，Electron + React，monorepo（pnpm + Turbo），Go 后端。

**当前深化流程（`packages/core/personal/notes.ts`）：**

- `useDeepenNotes()`：选中闪记 → `bridge.skillGet("ce-ideate")` → 建新会话 → `buildDeepenSystemPrompt` 注入 ce-ideate 元数据 → 单次 headless send。产出：`docs/ideation/<sessionId>-deepen.md`。NoteStatus 置为 `deepening`，run 收尾（`applyDeepenFinalize`）探测文件是否存在，存在则置为 `deepened`，追加 `docPaths`。
- `useGeneratePlan()`：只有 `status === "deepened"` 的闪记才可触发，复用最近深化会话，注入 `ce-plan` 元数据，产出 `docs/plans/<sessionId>-plan.md`。**当前需要用户手动点击触发。**
- `TodoMeta`（`packages/core/desktop/types.ts:31`）：`{ id, projectId, title, status: "open" | "done", detailPath, createdAt, updatedAt }`。当前 todos 与 plan 文档无自动关联，需手动管理。
- `NoteStatus`（`types.ts:805`）：`"draft" | "deepening" | "deepened"`——三态，plan 生成后 status 不变（仍 `deepened`），只追加 `docPaths`。

**痛点与空缺：**

1. 深化调用的是 `ce-ideate`（发散候选方向），但深化的实际目标是把闪记发展成可执行需求——`ce-brainstorm` 更符合（其定义：「what exactly should one chosen idea mean?」）。
2. Brainstorm → Plan 之间需要用户手动点击「生成 plan」，打断了思路流。
3. Plan 文档里已有 markdown checkbox（`- [ ]`），但 todos 列表与这些 checkbox 完全脱钩，用户需手动同步。
4. Todo 的实现状态（open/done）没有自动机制——用户在项目中实现了 todo 后，系统无法感知。
5. NoteStatus 三态不够细：plan 生成完成后与"仅 brainstorm 完成"无法区分，都是 `deepened`。

**Available Skills：** `ce-brainstorm`、`ce-ideate`、`ce-plan`、`ce-work`、`ce-doc-review`、`ce-frontend-design`。

**关键函数定位：**

- `buildDeepenSystemPrompt`（notes.ts:136）— 注入 skill 元数据给 headless agent
- `buildPlanSystemPrompt`（notes.ts:165）— 注入 ce-plan 元数据
- `applyDeepenFinalize`（notes.ts:248）— run 收尾状态机，基于 `fs.exists` 推进 NoteStatus
- `deepenStateTransition`（notes.ts:216）— 纯函数状态迁移，可测
- `deepenDocPath` / `planDocPath`（notes.ts:121/127）— 确定产出路径

---

## Topic Axes

1. **Skill 调用链** — 深化 session 应调用哪个 skill，按什么顺序，产出路径如何命名
2. **Todos 数据来源** — todos 从何处派生，如何表达与 plan.md checkbox 的同步关系
3. **实现状态检测** — 系统如何感知 todo 是否已在项目中实现（文件变更 / checkbox 变化）
4. **状态机扩展** — NoteStatus 需要增加哪些节点才能支撑多阶段流水线，且不破坏现有逻辑

---

## Ranked Ideas

### 1. 将 `ce-brainstorm` 替换 `ce-ideate` 作为深化核心 skill

**Description:** 修改 `useDeepenNotes()` 里的 `bridge.skillGet?.("ce-ideate")` 为 `bridge.skillGet?.("ce-brainstorm")`，并更新 `buildDeepenSystemPrompt` 使用 brainstorm 的元数据和 SKILL.md 路径。产出文件从 `docs/ideation/<id>-deepen.md` 改名为 `docs/brainstorm/<id>-brainstorm.md`（或保留路径命名为 `-brainstorm.md`），路径函数 `deepenDocPath` 对应改名为 `brainstormDocPath`。

**Axis:** Skill 调用链

**Basis:** `direct:` notes.ts:428–434 当前调用 `bridge.skillGet?.("ce-ideate")`，并在 notes.ts:14 引用 `SkillMeta`；`ce-brainstorm` SKILL.md 文档定义其输出为「what exactly should one chosen idea mean?」，正是把闪记（idea seed）发展成有明确需求方向的目标，而 `ce-ideate` 的输出是「候选方向列表」。

**Rationale:** 当前深化产出的是发散候选方向（ce-ideate），但用户期待的是「把想法种子变成可执行方向」——这恰好是 ce-brainstorm 的定位。调用错 skill 意味着产出结构不匹配后续 `ce-plan` 的输入预期（plan 期望 brainstorm 文档作为输入）。

**Downsides:** 需要同步更新 `deepenDocPath` 函数名和 `applyDeepenFinalize` 里的路径探测；现有的 `deepening → deepened` 状态机和测试需要更新路径字符串；历史产出（旧 ideation 文件）不会被自动迁移。

**Confidence:** 85%

**Complexity:** Low

---

### 2. Plan 产出后自动解析 checkbox 并批量注入 Todos

**Description:** 在 `applyDeepenFinalize` 的 `deepened` 分流中（notes.ts:233–238），当 `produced === true`（planDocPath 存在）时，额外调用 `bridge.readFile(planDocPath)`，用正则 `/^- \[ \] (.+)/gm` 提取所有未完成 checkbox 的标题，批量调用 `bridge.todosAdd` 写入 `TodoMeta`（关联 `projectId`，`detailPath` 指向 plan 文件，`status: "open"`）。去重：对比已有 todos 的 `title` 避免重复注入。

**Axis:** Todos 数据来源

**Basis:** `direct:` types.ts:31–39 TodoMeta 结构已支持 `{ projectId, title, status, detailPath }`；types.ts:392 PersistedState.todos 是可写数组；`applyDeepenFinalize` 已有 `bridge.notesUpdate` 调用模式可复用。`external:` GitHub Issues 的自动从 PR/commit 生成 issue 的做法验证了「从文档内容派生 tracking item」的可行性。

**Rationale:** Plan.md 本身已经是结构化的 todo 列表（markdown checkboxes），手动把 plan 内容录入 todos 是纯粹的重复劳动。自动提取消除了这层摩擦，且保证 todos 与 plan 文档语义一致。

**Downsides:** Plan 文档格式由 agent 自由生成，checkbox 语法不一定统一（如用 `- [x]` vs `- [ ]`，或嵌套 checkbox）；需要鲁棒的 parse 逻辑；若用户手动编辑了 todos 后 plan 又被重新生成，会出现重复或冲突。

**Confidence:** 80%

**Complexity:** Medium

---

### 3. 基于文件 Watcher 自动将 `- [x]` 变更同步为 Todo Done

**Description:** 在主进程的 `watch` IPC handler 里，对 `docs/plans/*.md` 文件增加监听。文件变更时，读取文件内容，对比已注入的 todos（通过 `title` 匹配），将 `- [x] <title>` 对应的 TodoMeta 状态置为 `done`，将 `- [ ] <title>` 对应的重置为 `open`。触发 `todos:changed` 事件通知渲染进程 invalidate queries。

**Axis:** 实现状态检测

**Basis:** `direct:` desktop/src/main/ipc/register.ts 已注册 `watch` handler；types.ts:805 NoteStatus 模式表明系统已有基于文件探测的状态推进逻辑（`applyDeepenFinalize` 用 `bridge.fileExists` 探测）；`external:` VSCode 的 Tasks extension 和 GitHub Copilot 的 todo 追踪均采用「parse 文件变更 → 同步状态」模式。

**Rationale:** 用户在编辑器里把 plan.md 的 `- [ ]` 改成 `- [x]`（或 agent 在 coding session 里修改 plan）时，这个变更应该自动反映到 todos 列表，而不需要任何手动操作。Watcher 已经存在，只需增加 plan 文件的监听逻辑。

**Downsides:** 文件路径匹配需要精确（只监听 `docs/plans/*.md`，不能误伤其他 md 文件）；title 匹配可能因换行/空格差异失配；watcher 在大量 plan 文件时性能开销需评估。

**Confidence:** 75%

**Complexity:** Medium

---

### 4. 单 Session 链式注入：Brainstorm + Plan 在同一 Headless Session 内串行完成

**Description:** 修改 `buildDeepenSystemPrompt` 同时注入 `ce-brainstorm` 和 `ce-plan` 两个 skill 的元数据和 SKILL.md 路径，在 extraSystemPrompt 里明确指示 headless agent：「第一步执行 ce-brainstorm，产出写到 `brainstormPath`；第二步基于 brainstorm 产出执行 ce-plan，产出写到 `planPath`」。两个 `outPath` 在 `useDeepenNotes` 里提前构造（`brainstormDocPath(cwd, sess.id)` 和 `planDocPath(cwd, sess.id)`），都在同一会话目录下。

**Axis:** Skill 调用链

**Basis:** `direct:` notes.ts:136–161 `buildDeepenSystemPrompt` 已有「降格执行」约束注入模式，当前只注入单个 skill；notes.ts:165–179 `buildPlanSystemPrompt` 是单独的 plan 注入，两者可合并；`reasoned:` headless session 里 agent 可以依次读取两个 SKILL.md 并分两阶段产出——这个模式与当前「先 ideate 再手动触发 plan」等价，只是把手动触发自动化到同一 session 内。

**Rationale:** 消除了用户在 brainstorm 完成后还需手动点击「生成 plan」的操作。同一 session 保证了 brainstorm doc 的上下文对 plan 生成是可见的（agent 可以直接 read brainstormPath）。

**Downsides:** 单 session 里链式执行两个 skill 增加了 session 时长和 token 消耗；若 brainstorm 中途失败，plan 也无法执行（但目前两步分离时同样如此）；extraSystemPrompt 变复杂，降格执行约束需要更精确地描述先后顺序。

**Confidence:** 78%

**Complexity:** Medium

---

### 5. 扩展 NoteStatus 四态：`draft → deepening → deepened → planned`

**Description:** 在 `types.ts:805` 增加 `"planned"` 状态（`NoteStatus = "draft" | "deepening" | "deepened" | "planned"`）。`applyDeepenFinalize` 里在 `deepened` 分流检测到 planDocPath 存在时，状态从 `deepened` → `planned`，同时触发 todos 注入（与 idea #2 联动）。`deepenStateTransition` 增加对 `deepened` 状态的 plan 产出检测分支（目前该分支只追加 `docPaths`，不改 status）。

**Axis:** 状态机扩展

**Basis:** `direct:` notes.ts:216–241 `deepenStateTransition` 当前 `deepened` 分支明确注释「只追加 docPath，不改 status」——说明这是当前刻意不区分的设计，但用注释形式承认了两态存在；types.ts:805 NoteStatus 现有三态；`reasoned:` 「brainstorm 完成但 plan 未生成」与「plan 已生成且 todos 已注入」是两种本质不同的状态，UI 需要区分它们才能给用户正确的下一步操作提示（「生成 Plan」按钮 vs「查看 Todos」入口）。

**Rationale:** 目前 `deepened` 语义含糊：它既可以是「brainstorm/ideate 完成，plan 未生成」，也可以是「plan 也生成了」，两种场景下 docPaths 数组长度不同，但没有明确状态区分。增加 `planned` 使状态机意图清晰，UI 可以精确渲染操作按钮，测试也能更准确覆盖各分支。

**Downsides:** 需要同步更新 `deepenStateTransition` 纯函数、`applyDeepenFinalize`、UI 条件渲染（所有判断 `status === "deepened"` 的地方需评估是否也包含 `planned`）；现有 `deepened` 态的闪记在迁移后可能需要补偿逻辑。

**Confidence:** 82%

**Complexity:** Low

---

### 6. 闪记卡片 Pipeline 进度徽标：Brainstorm → Plan → Todos 状态可见

**Description:** 在闪记卡片上替换当前单一的「深化中/已深化」标签，改为 pipeline 进度条组件：`💡 草稿 → 📋 Brainstorm（中/完）→ 📐 Plan（中/完）→ ✅ N/M Todos`。每个节点可点击：点击「Brainstorm」打开对应 md 文件；点击「Plan」打开 plan.md；点击「Todos」跳转到 todos 视图并过滤该闪记关联的 todos。状态从 `NoteStatus` 和 `docPaths` 计算派生，无新数据源。

**Axis:** 状态机扩展（UI 侧）

**Basis:** `direct:` types.ts:808–825 `NoteMeta` 已包含 `status`、`docPaths`、`conversationIds` 字段，信息完备可计算进度；`external:` Linear 的 issue-to-project 追踪、GitHub Actions 的 pipeline 可视化均验证了「多阶段状态可视化降低用户认知负担」的模式。

**Rationale:** 当前闪记卡片只显示「深化中」badge，用户无法区分流水线处于哪个阶段，也无法从卡片直接跳转到产出文件。Pipeline 徽标让流程对用户透明，且把「查看 brainstorm」「查看 plan」「查看 todos」三个操作收拢到同一入口。

**Downsides:** UI 组件实现需要处理各种中间状态（deepening 时 plan 节点灰显）；移动或小屏场景下 pipeline 徽标可能过宽；todos 的 N/M 数量需要实时查询，增加渲染依赖。

**Confidence:** 72%

**Complexity:** Medium

---

### 7. Todos 列表智能判断：基于 Git Diff 检测 Todo 对应代码是否落地

**Description:** 在 `applyDeepenFinalize` 或独立的 todo-sync 逻辑里，对 `status: "planned"` 的闪记关联项目调用 `bridge.gitChanges(projectPath)`，比对 plan.md 生成后的 git diff。通过简单的关键词匹配（todo title 的关键词是否出现在 diff 的新增行里），给 todo 一个「可能已实现」的信号，在 UI 里显示为「待确认」状态，让用户一键确认 done。

**Axis:** 实现状态检测

**Basis:** `direct:` types.ts:416–421 `ChangedFile / GitChangesResult` 结构已存在，`bridge.gitChanges` 是现有能力；`external:` GitHub Copilot 的 issue-to-PR 自动关联、Linear 的 branch→issue 自动关闭均基于「从代码变更推断任务完成」的模式。`reasoned:` checkbox 变更（idea #3）只追踪 plan.md 本身被修改，但真正的实现判断需要看项目代码是否有对应变更——两者结合才能给出可信信号。

**Rationale:** Checkbox 方法（idea #3）监听 plan.md 自身的改动，但很多情况下开发者直接在代码里实现了 todo，并不会回头改 plan.md。Git diff 方法作为补充信号，能捕获「代码已写但 plan 未更新」的场景。两种方法并用，召回率更高。

**Downsides:** 关键词匹配的精确率低（todo title 可能与 diff 不匹配，或误匹配无关变更）；git 仓库不存在时降级（isr epo=false）；每次 run 结束都调用 gitChanges 有性能成本；「待确认」状态需要新的 UI 元素和确认交互。

**Confidence:** 60%

**Complexity:** High

---

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| R1 | 完全移除 TodoMeta，todos 只从 plan.md 动态 parse | 破坏现有 `PersistedState.todos` 持久化结构，影响范围过大；plan.md 格式由 agent 自由生成，parse 不稳定；与已有 bridge.todosAdd 等接口不兼容——保留 TodoMeta 作为规范化存储，从 plan.md 注入（idea #2）更安全 |
| R2 | Zettelkasten 类比（fleeting/literature/permanent notes）| 提供的是概念框架类比而非具体实现方向；洞察已被 idea #1 的「brainstorm vs ideate 语义」吸收，作为独立 idea 不够可执行 |
| R3 | CI/CD pipeline 类比（每次深化触发一条 pipeline） | 架构概念有价值，但已被 idea #4（单 session 链式执行）和 idea #5（状态机扩展）具体化；单独作为 idea 缺乏实现锚点 |
| R4 | 自动化全链路（brainstorm → plan → todos 零手动触发）| 与 idea #4 高度重叠；完全自动化风险高（brainstorm 产出可能不符合用户期望，直接触发 plan 会浪费 token 并产出低质量 plan）——分阶段可选触发（idea #4）比全自动更务实 |
