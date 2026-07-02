---
date: 2026-07-01
topic: personal-tasks-agent-native
---

# 个人工作区真任务系统（OmniFocus 内核 · Agent 原生 · 不重）

## Summary

用一个真正的个人任务系统替换现在文档聚合式的「Tasks」面板：一行自然语言捕获，后台模型替你补上日期 / 标签 / 归类，让你几乎不用手动整理；结构（项目分组、多状态、「今日」视图）按需显形、闲置即藏；任何一条任务可一键交给 agent 执行并把结果回写。个人 + 本地，复用仓库里现成但被弃用的任务持久化通道。

## Problem Frame

当前「个人工作区」里有两样东西都叫 task，但没有一样是真正的任务管理：

- 线上那个右栏「Tasks」面板（`TasksDocsView`）其实是 **CE 文档流水线聚合器**——它只读地扫 `docs/{ideation,brainstorms,plans}/*.md`，按状态和血缘展示 skill 产物，卡片上的「继续」只是起一个新 agent 会话去跑下一阶段，**不回写任何状态**。它是「我的产物看板」，不是任务系统。
- 更早的复选框待办（`TodoMeta`，open/done）连同它的增删改、`createTaskFile`、`taskArchive` 都还在，但唯一的 UI `TodosView` 在被 `TasksDocsView` 顶替后**未挂载在任何地方**（仅测试引用），等于一套沉睡的地基。

于是「task」在这个产品里不承载任何个人任务管理的含义——这就是「没有太多实际意义」的由来。用户以 OmniFocus 为「真任务」的参照，但 OmniFocus 的强大与它的**重**不可分：defer/due、context、perspective、review、sequential project 全靠人手工维护。真正的痛点是——想要那份能力，不想要那份维护负担；而这个 App 的内核恰恰是能替人扛维护负担的 AI agent。

## Key Decisions

- **让 agent 扛整理负担。** OmniFocus 的重来自「结构全靠手工维护」；这里由后台模型来提议结构，于是时间 / 结构 / 组织 / 捕获四个维度能与「不重」共存。推断永远是建议层，覆在一个手动也能用的模型之上。
- **建议可信是价值前提，故建议出错与离线并列为一等降级路径。** 光处理「模型不可用」不够——「模型在线但建议差」更高频。忽略建议必须零惩罚、不打断捕获，否则用户会关掉建议、退回纯手动，「不重」承诺落空。
- **建议覆盖手动，而非取代手动。** 手动任务系统是底座，AI 结构化是可选层，可优雅降级为纯手动——核心循环保持确定、离线可用。
- **task 的「项目」是独立一等实体，与工作区代码工程解耦。** 旧 `TodoMeta.projectId` 指本地代码仓库、正文强绑 `项目/tasks/<id>.md`；新模型的 project 是可无路径、纯分组的任务容器。二者不是同一实体。
- **复用是「持久化通道 + 壳」，不是原样扩 TodoMeta——这是带迁移的模型重写。** 复用 JSON store、原子写、归档管线；但 schema 需重写、`project` 变可选、正文存储与项目文件系统解耦。别把它当纯复用来估工。
- **替换，不共存。** 新系统接管「Tasks」名字与右栏位置；CE 文档流水线下沉为等价可发现的次要视图。「task」只保留一个主含义。
- **只做内置固定视图，v1 不做自定义 Perspectives。** 自定义视角是 OmniFocus 单点最重的功能；v1 出 今日 / 收件箱 / 项目 / 标签，把用户自定义保存视角延后。
- **完成默认「需确认」。** 任务系统要做可信来源；agent 说「完成」也只是建议 done，由用户一键确认，宁可多一步也不静默把任务移出可信视野。自动 done 作为设置延后。
- **个人 + 本地。** 无团队、无跨设备同步——与现有个人工作区边界一致。

## Actors

- A1. 用户 — 捕获、分诊(triage)、编辑、委派、确认。
- A2. 后台结构化模型 — 解析自然语言、提议字段（复用与日报 / 归档共用的后台补全模型）。非阻塞、可选、可出错。
- A3. 执行 agent（claude / codex / pi）— headless 跑被委派的任务，把结果或错误回写。

## Key Flows

- F1. 捕获 → 结构化 → 分诊
  - **Trigger:** 用户在全局热键或 Tasks 界面里敲一行自然语言。
  - **Steps:** 立即建一条 Inbox 任务（零必填、立即可用）；后台模型异步解析标题，解析中给非侵入 pending 提示；建议就地到达（不抢焦点、不覆盖用户已填值）；用户逐字段或整体 接受 / 编辑 / 忽略。
  - **Outcome:** 任务被结构化并归好类，或保持一行纯文本——两种都完全可用。
  - **Covered by:** R1–R6, R11

- F2. 「今日」查看
  - **Trigger:** 用户打开 Today 视图。
  - **Steps:** 聚合「可执行(R9) 且 今天到期/逾期」「defer 到今天或更早」「已 flag」的任务；空态区分「今日无事」与「今天做完了」。
  - **Outcome:** 一屏「今天该做什么」，只含任务本身、不含日历事件。
  - **Covered by:** R9, R13–R15

- F3. 交给 agent → 回写（成功 / 失败）
  - **Trigger:** 用户在某条任务上点「交给 agent」。
  - **Steps:** 以任务标题 + 备注为上下文起 headless 会话（无项目任务按 R17 定 cwd）；任务转 进行中/等待并标记「已委派」；成功→回写结果摘要、建议 done（默认需确认）；失败/超时/崩溃/取消→按 R19 回退状态、写错误摘要、留会话链接、给「重试」。
  - **Outcome:** agent 跑的任务成为双向闭环，成功与失败都落在任务上、不静默丢失。
  - **Covered by:** R16–R20

- F4. 下沉的产物流水线（次要）
  - **Trigger:** 用户切到次要「Pipeline / 产物」视图。
  - **Steps:** 沿用现有 skill 文档聚合与「继续」阶段路由（ideation→brainstorm→plan→work），保持原样，且保留等价可发现性。
  - **Outcome:** CE 工作流不受影响，只是不再占据主「Tasks」位置。
  - **Covered by:** R22

- F5. 迁移（一次性）
  - **Trigger:** 新版本首次加载旧 personal-workspace.json（store version 1）。
  - **Steps:** 按 R24 把旧 open/done 映射到新状态、旧 `projectId` 保留为分组归属、接管已有 `tasks/<id>.md` 正文，写为 version 2。
  - **Outcome:** 老数据无损进入新模型，旧文件仍可读。
  - **Covered by:** R23, R24

## Requirements

**捕获与收件箱**

- R1. 快速捕获来自全局热键和 Tasks 界面内：一行输入即建任务，零必填字段，立即可用。
- R2. 收件箱(Inbox)是「未分诊任务」的**计算视图**（无项目且未被排期/执行），**不是**一个状态枚举值；分配项目或排期/执行即离开 Inbox。

**Agent 辅助结构化（「不重」引擎）**

- R3. 捕获时后台模型异步解析标题并提议字段（从日期短语推 due/defer、标签、匹配已有任务项目），以非破坏性就地建议呈现；任务立即可用，绝不被解析阻塞，解析中给非侵入 pending 指示。
- R4. 建议可**逐字段**接受/编辑/忽略，也可整体「全部接受/全部忽略」；忽略后保持一行纯文本。若某建议的目标字段已被用户手动赋值、或任务已离开 Inbox，则该「迟到建议」降级为可忽略提示，**绝不覆盖用户已填值**。
- R5. 结构化可选且优雅降级：后台模型不可用或离线时，捕获与全部手动编辑照常工作（系统表现为手动任务管理器）。
- R6. 模型在线但建议错误时，忽略是一步操作、零惩罚、不打断捕获；建议质量有可接受基准（日期/标签/项目匹配的正确率目标；确切度量与 spike 留 planning）。

**任务模型与结构**

- R7. 一条任务包含：标题、可选备注正文、状态、可选 defer 日期、可选 due 日期、可选标签、可选项目、可选 flag、来源(source)。
- R8. 状态枚举：active（可执行）、in-progress、waiting（阻塞或已委派）、done、dropped。（inbox 按 R2 是计算态，不入枚举。）
- R9. 「available(可执行)」是**派生属性** = 状态 ∈ {active, in-progress} 且（无 defer 或 defer ≤ 今天）；defer 到未来只把任务移出 Today/可执行列表，不改状态。
- R10. project 是独立于工作区代码工程的一等**任务分组**实体（可无路径、可纯分组）；v1 仅支持**单层** project 分组，**子任务嵌套下沉为 fast-follow**；R3「匹配已有项目」指向这些任务项目。
- R11. 结构渐进披露：无日期/标签/项目的任务渲染为一行，空字段隐藏，需要时才显形。
- R12. 标签为即输即建的自由文本；Tags 视图列出标签并按标签过滤任务；删除标签只从已打标任务移除该标签，不删任务。

**视图（内置、固定）**

- R13. 只做内置视图：Today、Inbox、Projects、Tags——v1 无用户自定义 Perspectives。
- R14. Today 聚合「可执行(R9) 且 今天到期或逾期」「defer 到今天或更早」「已 flag」的任务；只含任务，不含日历事件。
- R15. Today 与 Inbox 定义空态：Today 区分「今日无事可做」与「今天已做完」的正向反馈；Inbox 空态给「已清空」确认或首次使用的捕获引导。

**Agent 集成（混合委派）**

- R16. 任何任务都有「交给 agent」动作，以任务标题 + 备注为上下文起一个 headless agent 会话（复用现有会话派发范式）。
- R17. 委派**无项目**任务时定义 cwd 归属策略（如落默认工作区根，或提示选择项目），并把无项目任务正文存于 cortexHome 下统一任务目录、不走项目作用域的 `createTaskFile`（避免崩在 `projectRoot`）。
- R18. 与现在只读的文档「继续」不同，agent 委派是双向的：运行把结果摘要回写任务正文并驱动状态（运行中→进行中/等待；成功→建议 done）；完成默认**需用户确认**，自动 done 为延后设置。
- R19. 委派定义失败/取消终态：超时/崩溃/无产出/用户中断时，任务回退到 waiting（附失败原因）、把错误摘要写入正文、保留到 agent 会话的链接、并提供「重试委派」。
- R20. 被委派的任务进入 waiting 状态（原因=已委派）、有明显标记、并链接到它的 agent 会话。

**信息架构与迁移**

- R21. 新任务系统成为主「Tasks」界面（右栏标题为「Tasks」的位置）。
- R22. CE 产物流水线保留为**等价可发现**的次要视图（如常驻次级 tab，而非埋进过滤/来源标签），不删除。因现「Tasks」是默认常驻主界面（rightView 默认 todos，sidebar/openHome 都回到它），替换会改变每个现有用户的默认主界面——「CE 工作流不受影响」应作为**待验证风险**而非既定假设。
- R23. 复用范围收敛为「持久化通道 + 壳」（JSON store、原子写、归档），而非原样沿用 `TodoMeta` schema：`TodoMeta` 扩成新 schema、`addTodo/createTaskFile` 让 project 变可选并把正文存储与项目文件系统解耦。这是带迁移的模型重写，不是 drop-in 唤醒。
- R24. 迁移：bump store 版本（1→2）并定义 migrate——旧 open/done→新状态映射、旧 `projectId` 保留为分组归属、接管已有 `tasks/<id>.md` 正文；加载时一次性迁移，旧磁盘任务文件仍可读。

**持久化**

- R25. 任务持久化进现有个人工作区 JSON store（全量原子写）；不引入新数据库；仅个人 + 本地（无团队/wsId，无跨设备同步）。
- R26. 并发写安全：后台 agent 回写(R18)与用户前台编辑并发写同一 `personal-workspace.json` 时，走字段级 patch/合并或串行化写入队列，而非整表覆盖；内存 `cached` 镜像在多写入者下正确失效（近期已暴露过同步写阻塞，须显式处理）。
- R27. 完成任务保留「按摘要压缩归档」；并定义 dropped/删除生命周期：软标记 vs 物理删除、dropped 是否归档、done/dropped 可否恢复。
- R28. 声明各内置视图默认排序；v1 不做手动拖拽 reorder（列入延后）。

## Acceptance Examples

- AE1. **Covers R3.** 捕获「周五前给张伟回邮件」→ 模型提议 due=本周五、标签=@email；用户接受 → 任务被排期。
- AE2. **Covers R5.** 后台模型关闭/离线时，同样捕获 → 生成一条无任何建议的纯文本任务，手动编辑照常可用。
- AE3. **Covers R6.** 模型在线但把「跟进设计稿」误标 due=今天；用户一步忽略 → 任务保持无 due，捕获流不被打断，无额外确认弹窗。
- AE4. **Covers R4.** due 建议异步返回时用户已手动填了 due → 迟到的 due 建议不覆盖、降级为可忽略提示；标签建议仍可独立接受。
- AE5. **Covers R9, R14.** 一条 defer 到明天的 active 任务今天不出现在 Today 且不算 available；到明天自动浮现；一条逾期任务持续留在 Today。
- AE6. **Covers R18.** 把任务交给 agent → 状态转进行中；成功完成时任务正文追加结果摘要、状态建议 done，用户一键确认后才置 done。
- AE7. **Covers R19.** 委派的 agent 会话崩溃 → 任务回到 waiting、正文写入错误摘要、保留会话链接、出现「重试委派」入口，任务不消失、不静默置 done。
- AE8. **Covers R24.** 旧 version 1 数据里一条 done 的 `TodoMeta`（带 projectId + `tasks/<id>.md`）→ 迁移为新模型 done 状态、projectId 转为分组归属、正文接管，加载后可见。
- AE9. **Covers R4, R11.** 忽略某条捕获任务的全部建议 → 它渲染为一行纯文本任务，不显示任何日期/标签/项目字段。

## Scope Boundaries

**延后（以后做，但非 v1）**

- 子任务嵌套（v1 只做单层 project 分组）。
- 用户自定义 Perspectives（自己保存的过滤视角）。
- Agent 完成「自动 done」设置开关（v1 一律需确认）。
- 手动拖拽 reorder。
- 重复/循环任务（每天/每周）。
- 每周 Review 工作流。
- Sequential vs parallel 项目语义。

**产品身份之外（定位决定，不做）**

- 团队/共享任务、多人指派、跨设备同步——保持个人 + 本地。
- 日历/事件集成与真正的时间块——Today 只看任务。
- 通用项目管理（Gantt、依赖图）——这不是要做的东西。

## Dependencies / Assumptions

- 复用四项已核实存在的现成能力：全量 JSON 个人 store（原子写）、全局热键、headless agent 会话派发、后台补全模型桥（`openaiComplete`，即日报/归档共用的 summary 模型）。
- 复用是「通道 + 壳」，模型层是带迁移的重写（见 R23/R24）——估工时按重写算，别按 drop-in 扩 TodoMeta 算。
- 假设该后台 summary 模型可复用于自然语言解析；若未配置或质量不达标，结构化按 R5/R6 降级，任务系统仍可用。
- 单文件 JSON + 内存 cached 镜像在「前台编辑 + 后台回写」并发下需显式并发处理（R26），不能假设 last-write-wins 安全。
- 「替换主界面不影响 CE 工作流」是待验证风险（R22），非既定假设。

## Outstanding Questions

**Planning 前需解决**

- 无——以下均可在 planning 内解决，各带推荐默认，用户可随时覆盖。

**留给 Planning（带推荐默认）**

- flag 建模：默认作为独立可选属性（与状态正交，Today 可用），planning 可改为状态。
- 委派无项目任务的 cwd：默认「委派时提示选择项目/目录，未选则落默认工作区根」（R17 备选：禁用直到分配），planning 定稿。
- 建议质量基准：planning 阶段用真实样本 spike 校准日期/标签/项目解析准确率后再定阈值与降级触发（R6）。
- 任务正文继续存松散 `.md` 文件，还是并入 JSON（持久化形状）。
- 建议在 UI 上如何呈现（就地 chips vs 一个 review 步骤）与逐字段接受的具体交互。
- 下沉的 Pipeline 视图落在哪个次级 tab（须满足 R22 等价可发现性）。
- 后台结构化调用的防抖/时机与成本控制。
- 迁移是纯一次性还是保留惰性兼容读旧文件。
- 各内置视图默认排序的具体规则。

## Sources / Research

关键现状锚点（repo 相对路径）：

- 现「Tasks」右栏 = 文档聚合器，且是默认常驻主界面：`packages/views/cortex-desktop/personal/PersonalRightPanel.tsx:22,116`；`packages/core/store/personal.ts:60`（`RightView` 含 `"todos"`）、`:400`（默认 `rightView: "todos"`）、`:927`（openHome 回到它）；`PersonalSidebar.tsx:155`（开项目强制回到它）。
- 文档「继续」只读、不回写：`packages/core/personal/docTasks.ts:8,161,195,211`。
- 沉睡的任务地基（复用通道 + 需重写的 schema）：`packages/core/desktop/types.ts:49-59`（`TodoMeta`，projectId 必填、open/done）；`packages/core/store/personal.ts:242-244,762,778,783`；`packages/core/desktop/bridge.ts:113`、`apps/desktop/src/main/ipc/fs.ts:510`（`createTaskFile` 依赖 `projectRoot`）；`packages/core/personal/taskArchive.ts`。
- `TodosView` 已成孤儿（仅测试引用）：`packages/views/cortex-desktop/personal/TodosView.tsx:664`；`TodosView.test.tsx:23,271`。
- 持久化 = 单文件 JSON 原子写 + 内存 cached 镜像，全仓无 SQLite：`apps/desktop/src/main/ipc/store.ts:1,13,24,55-57,61-62`。
- 全局热键能力：`apps/desktop/src/main/hotkey.ts:1,5,92-111`。
- 后台补全模型桥：`packages/core/personal/timeline.ts:574`（`completeWithSummaryModel`）→ `packages/core/desktop/bridge.ts:199`（`openaiComplete`）。
