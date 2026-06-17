---
date: 2026-06-17
topic: tasks-panel-doc-status-tags
focus: 右边栏 tasks 面板统一展示并继续 ce-ideate/ce-brainstorm/ce-plan 生成的文档，做标签分类，用文档 frontmatter 源数据解析状态
mode: repo-grounded
status: ready
type: feat
origin: docs/ideation/sess-mqfx56ne-1-rvwvl4-deepen.md（同主题，角度互补：旧文档聚焦闪记深化流水线，本篇聚焦面板/分类/跨类型状态解析）
---

# Ideation：右边栏 Tasks 面板 — 文档聚合 / 标签分类 / 源数据状态解析

## Grounding Context

**Codebase Context**

cortex-work：Electron + React，monorepo（pnpm + Turbo），Go 后端。三类 skill 产物全部落在 `docs/` 下并按目录分流：

- `docs/ideation/*.md` — ce-ideate 产物（候选方向）
- `docs/brainstorms/*.md` — ce-brainstorm 产物（可执行需求）
- `docs/plans/*.md` — ce-plan 产物（实现计划，含 markdown checkbox）

**关键事实：元数据存在两套编码 + 多语种自由文本状态值**（实测 19 个 plan + 1 ideation + 2 brainstorm）：

1. **YAML frontmatter 编码**（多数 06-14/15/16 文件）：

   ```yaml
   ---
   title: "feat: ..."
   type: feat            # 或 fix
   status: completed     # 实测值域：completed / active / ready；部分文件无此字段
   date: 2026-06-14
   deepened: 2026-06-14  # 可选
   origin: docs/brainstorms/...  # 或 null，或缺省
   ---
   ```

2. **Inline 列表编码**（pi-rpc 系列、askquestion 等 06-16/17 文件，无 `---` 包裹，紧跟 `# 标题` 之下）：

   ```
   # feat: pi RPC 会话——阶段 4（健壮性...）
   - 类型：feat
   - origin：docs/plans/2026-06-16-003-...-plan.md §6/§7
   - 状态：待执行（U0 spike 已完成，见 §2）
   - 深度：Deep（跨 4 层、恢复/资源/代际多维）
   ```

   状态实测值域（自由中文文本）：`待执行`、`待评审`、`待执行（U0 spike 已完成）`……带括号补注，非枚举。

3. **文件名本身就是结构化元数据**，可作无 frontmatter 时的兜底：
   `2026-06-14-001-feat-personal-landing-fixed-width-right-panel-plan.md`
   → `日期 | 序号 | 类型(feat) | slug | 文档种类(plan)`。

**当前数据结构（`packages/core/desktop/types.ts`）：**

- `TodoMeta`（:31）：`{ id, projectId, title, status: "open"|"done", detailPath, createdAt, updatedAt }`
- `NoteStatus`（:991）：`"draft" | "deepening" | "deepened"`；`NoteMeta.docPaths`（:1002）累加深化产出路径
- **既有右栏 = 本主题载体**：`PersonalRightPanel`（`packages/views/cortex-desktop/personal/PersonalRightPanel.tsx`）已存在，`rightView: "todos"` 渲染的标签就叫 **"Tasks"**（:21 `todos: "Tasks"`），当前是「跨项目 Tasks 列表」。**列表态固定 320px**（左缘拖拽仅在详情/预览态生效，双击恢复自动宽度）。本主题是**增强这个既有 Tasks 视图**去聚合 skill 文档，而非全新面板。

**痛点与空缺：**

1. 三类产物各居一目录、各有元数据约定，但**无统一浏览面**——用户要在文件树里逐个翻。
2. 状态值是**双编码 + 多语种自由文本**，没有规范枚举，无法直接驱动看板/筛选。
3. 缺 `status` 字段的文件（如 flash-notes-plan）无法判断进度。
4. `origin` 把 ideation→brainstorm→plan 串成血缘，但**无任何 UI 把同一条流水线聚合呈现**。
5. 「继续这些文档」的动作（如 plan → 执行、brainstorm → 生成 plan）目前散落在闪记卡片逻辑里，未抽象为面板级操作。

## Topic Axes

1. **源数据解析** — 如何统一抽取两套编码 + 文件名兜底，产出归一化记录
2. **状态归一化** — 多语种自由文本状态 → 规范生命周期枚举的映射策略
3. **标签分类体系** — 从元数据派生哪些维度的标签，如何呈现与筛选
4. **血缘聚合** — origin 链如何把跨类型文档聚合成一条可视流水线
5. **面板交互与「继续」动作** — 卡片如何驱动下一步 skill 调用

---

## Ranked Ideas

### 1. 统一 frontmatter 解析器：双编码 + 文件名兜底，产出归一化 `DocMeta`

**Description:** 在 `packages/core/personal/` 新增纯函数 `parseDocMeta(path, raw): DocMeta`。三级抽取，优先级递降：(a) 若文件以 `---` 开头，解析 YAML frontmatter；(b) 否则扫描 `# 标题` 之后、首个空行之前的 `- 字段：值` / `- 字段: 值` inline 块（同时兼容中英文冒号 `：:`）；(c) 两者都缺的字段从**文件名**正则兜底：`/^(\d{4}-\d{2}-\d{2})-(\d{3})-(feat|fix|chore|docs|style)-(.+)-(plan|deepen|brainstorm)\.md$/`。产出 `DocMeta = { path, kind, type, status, title, date, origin, depth, raw所属目录 }`。`kind` 由所在目录决定（ideation/brainstorm/plan），最权威。

**Axis:** 源数据解析

**Basis:** `direct:` 实测三种编码并存（YAML：`2026-06-14-001-...-plan.md` 头 6 行；inline：`2026-06-17-002-...-robustness-plan.md` 头部 `- 类型/origin/状态/深度`；文件名规律：全部 19 个 plan 均匹配 `日期-序号-类型-slug-种类` 命名）。`reasoned:` 纯函数 + 路径入参符合 `core` 不依赖 `process.env`/`localStorage` 的硬边界，且就近可写 `*.test.ts`，用本仓真实文件做表驱动夹具。

**Rationale:** 一切下游（状态、标签、血缘）都依赖一个稳定的归一化记录。把"脏"的多编码现实收敛到一个 `DocMeta` 是整个面板的地基。

**Downsides:** inline 块的括号补注（`待执行（U0 spike 已完成）`）需要先剥离再归一；YAML `origin: null` 字符串与缺省需区分；未来新增编码格式要回头扩解析器。

**Confidence:** 88% · **Complexity:** Medium

---

### 2. 状态归一化词表：自由文本 → 规范生命周期枚举

**Description:** 定义 `TaskStatus = "idea" | "todo" | "review" | "active" | "done"` 五态规范枚举，配一张**可扩展同义词表**（中英混合）做映射：

| 规范态 | 命中词（小写化 / 去括号补注后） |
|---|---|
| `done` | completed, done, 已完成, 已落地 |
| `active` | active, in-progress, 进行中, 实现中 |
| `review` | 待评审, review, in-review |
| `todo` | ready, 待执行, planned, todo, **plan 类且无 status 字段** |
| `idea` | ideation/brainstorm 类默认（未进入 plan） |

归一前先 `status.replace(/（.*?）|\(.*?\)/g, "").trim().toLowerCase()` 剥离补注。命中失败 → 按 `kind` 落默认（plan→todo，brainstorm/ideation→idea）并标 `unknownStatusRaw` 保留原文供 UI tooltip。

**Axis:** 状态归一化

**Basis:** `direct:` 实测状态值域 = {completed, active, ready, 待执行, 待评审, ∅}（见 Grounding，跨 YAML 与 inline 两编码）；`reasoned:` 自由文本不可能穷举，词表 + 兜底 + 保留原文是「鲁棒解析」标准做法，比硬枚举更耐未来格式漂移。

**Rationale:** 看板列、筛选、进度统计都要求规范枚举；多语种自由文本不能直接驱动 UI。词表把"翻译"集中到一处，新值只改表不改逻辑。

**Downsides:** 词表需随团队书写习惯维护；`done` 误判风险（如标题含"已完成"但状态非 done）——只读 status 字段不读正文可控；ideation/brainstorm 缺生命周期语义，统一塞进同一枚举略勉强（见 idea #3 用独立"阶段"维度缓解）。

**Confidence:** 84% · **Complexity:** Low

---

### 3. 多维标签体系：阶段 / 类型 / 主题域 / 深度，元数据全派生

**Description:** 标签不是单一维度，而是从 `DocMeta` 派生的四组正交标签，面板顶部可按任一维筛选：

- **阶段**（kind 派生，最稳）：`💡 构思`(ideation) / `📋 需求`(brainstorm) / `📐 计划`(plan)
- **类型**（type 派生）：`feat` / `fix` / `chore` …，配色区分
- **主题域**（topic 或 slug 聚类）：`pi` / `个人工作区` / `闪记` / `发布` / `设置`——按 slug/topic 前缀归并
- **深度**（仅 plan 的 inline `深度`）：`Deep` / `Standard`

状态（idea #2）作为看板列或独立筛选维，不混进标签。

**Axis:** 标签分类体系

**Basis:** `direct:` `kind` 来自目录（100% 可得）；`type` 实测全部文件可得（YAML 或 inline 或文件名）；`topic` 见 ideation/brainstorm frontmatter，plan 经 slug 聚类（如 `pi-rpc-*`、`personal-*`、`flash-note-*` 明显成簇）；`深度` 见 inline `- 深度：Deep|Standard`。

**Rationale:** 单一标签维度会让 20+ 文档很快糊成一团。正交多维 + 颜色让用户按"我现在关心 pi 相关的待执行计划"这种组合意图快速过滤。

**Downsides:** 主题域聚类无显式字段，需启发式（slug 公共前缀）易误并/漏并；标签维度多了 UI 易拥挤，需克制默认只显阶段+状态，其余折叠。

**Confidence:** 80% · **Complexity:** Medium

---

### 4. origin 血缘聚合：把 ideation→brainstorm→plan 串成一条流水线卡

**Description:** 解析 `origin` 字段（YAML `origin:` 或 inline `- origin：`，取其中的 `docs/...md` 路径，忽略 `null`/`无 brainstorm` 等文本），构建有向边 `child.origin → parent.path`。面板提供"血缘视图"：把同一条链（如 `shanji-notes-requirements.md → flash-notes-plan.md`，或 `pi-rpc-session-plan → pi-rpc-renderer-plan → ...`）折叠成一张可展开的流水线卡，节点状态用 idea #2 的规范态着色。孤儿文档（无 origin 入边出边）平铺。

**Axis:** 血缘聚合

**Basis:** `direct:` 实测 origin 链真实存在且跨类型：`2026-06-16-002-...-plan.md` origin 指向 `docs/brainstorms/2026-06-16-...requirements.md`；`pi-rpc-renderer/extension/robustness` 三个 plan 的 origin 均指回 `2026-06-16-003-feat-pi-rpc-session-plan.md`，天然构成一棵树；`sess-...-plan.md` origin 指向 `docs/ideation/sess-...-deepen.md`。

**Rationale:** 这些文档不是孤立任务，而是同一意图的不同成熟阶段。把血缘可视化让用户一眼看到"这条线走到哪了"，也复用了既有 `NoteMeta.docPaths` 的累加血缘思想。

**Downsides:** origin 文本不规范（路径 + § 章节 + 自由说明混写），需鲁棒抽路径；一个 plan 可有多 origin（如 askquestion 引"understand 简报"非文件路径）；跨目录路径匹配要容忍相对/绝对差异。

**Confidence:** 76% · **Complexity:** Medium

---

### 5. Tasks 视图布局：320px 窄轨用「纵向状态分组列表」，看板留给中心区可选大视图

**Description:** 增强既有 `rightView: "todos"`（"Tasks"）视图，数据源从「跨项目 todos」扩为「`docs/{ideation,brainstorms,plans}/*.md` → `parseDocMeta` 归一记录」。布局**定论为纵向分组列表**：以规范状态（idea #2）为可折叠分组头（`▾ 待执行 (4)` / `▾ 进行中 (1)` …），组内为纵向排列的文档卡（阶段标签 + 类型标签 + 标题 + 相对日期）。顶部一行标签筛选 chip（阶段/类型/主题域多选）。点击卡 → 切右栏详情态（拖宽生效）复用既有 Markdown 预览。数据经 React Query 缓存，文件 watcher 触发 invalidation。**横向看板不进窄轨**；若未来需要看板，作为「在中心区打开 Tasks 全景」的可选大视图（独立、更大 scope），不占用 320px 右栏。

**Axis:** 面板交互与「继续」动作

**Basis:** `direct:` `PersonalRightPanel.tsx:6` 明确列表态**固定 320px**——5 列横向看板（每列需 ≥220px）在 320px 内物理放不下，纵向分组是唯一稳态；`PersonalRightPanel.tsx:21` `todos:"Tasks"` 证明承载视图已存在，详情态拖宽（:5）可复用做预览；`register.ts` 已注册 `watch` IPC 可监听 docs；服务端态走 React Query 为项目硬约定（CLAUDE.md）。`reasoned:` 文档总量约 20+，纵向分组 + 折叠头比空列偏多的看板信息密度更高；看板的"列即状态"心智可由分组头无损保留。

**Rationale:** "统一展示并继续这些文档"落在这个既有 320px Tasks 视图上。窄轨决定布局：纵向分组列表把 idea #2 状态、#3 标签、#4 血缘三者在有限横向空间内收口，又不牺牲"按状态分列"的心智模型。

**Downsides:** 分组全展开时纵向滚动较长，需默认折叠已完成组；标签 chip 在 320px 内一行放不下需换行或横滚；详情态拖宽与列表态固定宽切换的交互连续性要打磨。

**Confidence:** 84% · **Complexity:** Medium

---

### 6. 卡片级「继续」动作：按文档种类路由到下一步 skill

**Description:** 每张文档卡的状态决定可用动作，复用既有 `bridge.skillGet` + headless session 注入模式（`notes.ts` 已验证）：

- ideation 卡 → 「生成 Brainstorm」（注入 ce-brainstorm，origin 指向本 ideation）
- brainstorm 卡 → 「生成 Plan」（注入 ce-plan）
- plan 卡（待执行）→ 「开始实现」（注入 ce-work，或解析 checkbox 注入 TodoMeta，与旧 ideation 文档 idea #2 联动）
- 任意卡 → 「打开文档」「在编辑器打开」

**Axis:** 面板交互与「继续」动作

**Basis:** `direct:` `notes.ts` 的 `useDeepenNotes`/`useGeneratePlan` 已实现"读 skill 元数据 → 建 session → 注入 system prompt → headless send → 探测产出文件"的完整范式（见旧 ideation 文档 Grounding）；`bridge.skillGet`、`buildPlanSystemPrompt` 均为现成能力。

**Rationale:** "继续这些文档"不止是展示，更要能从面板直接推进流水线。把闪记里已验证的 skill 调用范式抽象到文档卡上，让任意 doc（不只闪记衍生的）都能继续。

**Downsides:** 与闪记现有流水线（旧 ideation 文档）有职责交叉，需明确边界——闪记驱动的链 vs 面板手动驱动的链可能产出重复文档；动作可用性判断依赖准确的状态解析（idea #1/#2 的正确性是前提）。

**Confidence:** 72% · **Complexity:** Medium

---

## Rejection Summary

| # | Idea | 否决理由 |
|---|------|----------|
| R1 | 给所有历史文档批量回填统一 frontmatter，强制单一编码 | 改写 19+ 既有产物风险高、破坏 git 历史可读性；解析器兼容双编码（idea #1）比强制迁移更安全、且对未来 agent 自由产出的格式更宽容 |
| R2 | 用 LLM 读正文推断每个文档状态 | 慢、贵、不确定；状态字段已结构化存在（只是多编码），词表归一（idea #2）足够，无需读正文 |
| R3 | 复用 `TodoMeta`（open/done 两态）直接承载文档任务 | 两态不足以表达 idea/todo/review/active/done 五阶段；文档任务与 checkbox 级 todo 是不同粒度，混用会让两者语义都变模糊——文档级用新 `DocMeta`，checkbox 级仍用 `TodoMeta` |
| R4 | 把面板做成全局跨项目任务聚合 | 违反 query key 必含 `wsId` 的工作区隔离约定，且 docs/ 是仓库级而非工作区级，跨项目聚合会数据串场；先做单仓 docs/ 扫描，跨项目是后续独立议题 |

---

## Next Steps

建议优先 **idea #1 + #2**（解析器 + 状态词表，纯函数 + 表驱动测试，本文件 frontmatter 即可作首个夹具），它们是面板一切功能的地基；随后 **idea #5** 出最小看板，再叠加 **#3 标签**、**#4 血缘**、**#6 继续动作**。

可对 idea #1 走 `ce-brainstorm` 把 `DocMeta` 字段集与解析优先级定死，再进 `ce-plan`。
