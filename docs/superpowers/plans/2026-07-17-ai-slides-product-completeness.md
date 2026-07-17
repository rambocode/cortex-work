# AI Slides 产品完整度实施计划

> **For agentic workers:** 按 vertical slice 顺序实施。每个任务先写失败测试，再写最小实现；跨进程合同先于 UI。实施基线为包含模板真实预览的 `9879a99`。

**Goal:** 补齐 AI Slides 的演讲者备注用户闭环、角色化多 Agent 流水线，以及 PPTX 可编辑性和降级透明度，使功能从“内部 MVP”达到可稳定交付的产品形态。

**Architecture:** 保持 `deck.json + slides/*.html` 事实来源不变。备注正文继续存放在 `notes/<slotId>.md`；多 Agent 产物写入 deck 内的 `drafts/runs/<runId>/`，必须经父 Agent或用户批准后才进入正式 slide/notes；PPTX 导出在现有 `SlideScene` 上扩展语义节点和质量报告，不绕过 HTML-first 管线。

**Tech Stack:** Electron 39、React 19、TypeScript、Zustand、Vitest、Testing Library、MCP、PptxGenJS、JSZip。

**Related:**

- `docs/superpowers/specs/2026-07-16-ai-slides-design.md`
- `docs/superpowers/plans/2026-07-16-ai-slides.md`
- `docs/superpowers/specs/2026-07-16-ai-slides-acceptance.md`

**实施状态（2026-07-17）：** Task 0–9 的代码与自动化测试已完成；Task 10 的全量测试、
typecheck、lint、desktop build、arm64/x64 构建已执行。真实 Agent 凭据端到端、10 页性能
P50/P95、PowerPoint 人工编辑和打包 GUI 全流程仍以验收记录中的“尚未验证”为准。

---

## 1. 完成定义

### 演讲者备注

- 用户可在当前页下方打开、查看和编辑备注。
- 备注切页前自动保存，保存中、已保存、冲突和失败状态可见。
- Agent 生成的备注和用户编辑使用同一文件及 revision 合同。
- PPTX 和 HTML presenter 导出备注；PDF、PNG 明确忽略备注。
- 删除、复制和重排 slide 后，备注归属保持正确。

### 多 Agent 流水线

- 用户可发起“内容研究”“视觉研究”“整套审阅”“生成备注”四类角色任务。
- 每个角色有固定输入、结构化输出、状态、耗时和失败重试。
- 子 Agent 不直接写正式 `slides/*.html` 或 `notes/*.md`。
- 角色产物持久化到 `drafts/runs/`，重启后可恢复。
- Reviewer findings 可逐条接受、忽略或交给主 Agent 修复。
- 用户能看到当前阶段、角色进度和角色结论，不需要从原始聊天日志猜状态。

### PPTX 产品质量

- 导出前展示每页原生对象数、栅格覆盖率、降级原因和质量等级。
- 用户能定位高栅格化页面，并选择继续导出或交给 Agent 优化。
- SVG 保持矢量图片，不因 POC 限制整块栅格化。
- 基础列表、旋转、透明度、图片裁剪和合并单元格尽量映射到 PPTX。
- 带 Cortex 语义 chart spec 的 bar/line/pie 图表可导出为 PowerPoint 原生 chart；普通 canvas 继续安全降级。
- 不承诺任意 CSS、动画、滤镜或无语义 canvas 可编辑。

---

## 2. 领域与文件合同

### 2.1 备注合同

不把备注正文写进 `deck.json`。`SlidesSlot.notesPath` 继续只保存相对路径。

新增 IPC 类型：

```ts
export type SlidesReadNotesRequest = SlidesDeckScopedRequest & {
  slotId: string;
};

export type SlidesReadNotesResult =
  | { ok: true; markdown: string; slotRevision: number }
  | { ok: false; error: SlidesError };

export type SlidesSaveNotesRequest = SlidesDeckScopedRequest & {
  slotId: string;
  markdown: string;
  expectedRevision: number;
};
```

备注保存仍调用已有 `writeSlideNotes()`，不新增第二套文件实现。

### 2.2 流水线合同

新增 deck 内部文件：

```text
.cortex-design/<deckId>/drafts/runs/<runId>/
├── run.json
├── topic-research.json
├── visual-research.json
├── narrative-review.json
├── render-review.json
├── notes-draft.json
└── slide-drafts/
    └── <slotId>.html
```

核心类型：

```ts
export type SlidesRole =
  | "topic-researcher"
  | "visual-researcher"
  | "narrative-reviewer"
  | "render-reviewer"
  | "notes-writer";

export type SlidesRoleRunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "accepted"
  | "rejected"
  | "failed"
  | "canceled";

export type SlidesPipelineRun = {
  schemaVersion: 1;
  id: string;
  deckId: string;
  kind: "research" | "review" | "notes";
  deckRevisionAtStart: number;
  status: "running" | "awaiting-approval" | "completed" | "failed" | "canceled";
  roles: SlidesRoleRun[];
  createdAt: string;
  updatedAt: string;
};
```

关键规则：

- `run.json` 是流水线状态事实来源，不塞进 `deck.json`。
- 角色结果必须通过 zod schema；自由文本只能作为 `rawSummary`，不能直接应用。
- `deckRevisionAtStart` 用于检测审阅期间 deck 是否已变化。
- 接受结果时再次校验当前 revision；冲突后必须重新审阅或由用户明确继续。
- 子 Agent 只能返回结果或写 draft 目录，不能写正式目录。

### 2.3 导出质量合同

扩展现有 `SceneExportReport`：

```ts
export type SlidesExportQuality = "high" | "mixed" | "raster-heavy";

export interface SceneExportReport {
  nativeCount: number;
  rasterCount: number;
  rasterAreaRatio: number;
  rasterReasons: string[];
  warnings: string[];
  quality: SlidesExportQuality;
  nativeKinds: Record<"text" | "image" | "table" | "shape" | "chart", number>;
}
```

建议等级：

- `high`：栅格覆盖率 `< 15%` 且无 blocking warning。
- `mixed`：栅格覆盖率 `15%–50%`。
- `raster-heavy`：栅格覆盖率 `> 50%` 或整页降级。

阈值以截图像素面积为准，不用 raster node 数量代替视觉占比。

---

## 3. 目标文件结构

### Core

- Create: `packages/core/design/slides/slides-pipeline-types.ts`
- Create: `packages/core/design/slides/slides-pipeline-schema.ts`
- Create: `packages/core/design/slides/slides-export-quality.ts`
- Modify: `packages/core/design/slides/slides-types.ts`
- Modify: `packages/core/desktop/slides-ipc-types.ts`
- Modify: `packages/core/desktop/bridge.ts`
- Modify: `packages/core/design/slides/slides-prompt.ts`

### Desktop

- Create: `apps/desktop/src/main/capabilities/slides/pipeline/workspace.ts`
- Create: `apps/desktop/src/main/capabilities/slides/pipeline/tools.ts`
- Create: `apps/desktop/src/main/capabilities/slides/pipeline/role-schemas.ts`
- Create: `apps/desktop/src/main/capabilities/slides/export/chart-spec.ts`
- Modify: `apps/desktop/src/main/capabilities/design-delegate/server.ts`
- Modify: `apps/desktop/src/main/capabilities/slides/tools.ts`
- Modify: `apps/desktop/src/main/capabilities/slides/workspace.ts`
- Modify: `apps/desktop/src/main/capabilities/slides/export/types.ts`
- Modify: `apps/desktop/src/main/capabilities/slides/export/dom-extractor.ts`
- Modify: `apps/desktop/src/main/capabilities/slides/export/pptx.ts`
- Modify: `apps/desktop/src/main/capabilities/slides/export/deck-export.ts`
- Modify: `apps/desktop/src/main/ipc/slides-ipc-types.ts`
- Modify: `apps/desktop/src/main/ipc/slides.ts`
- Modify: `apps/desktop/src/preload/index.ts`

### Views

- Create: `packages/views/cortex-desktop/design/slides/SlidesNotesPanel.tsx`
- Create: `packages/views/cortex-desktop/design/slides/SlidesWorkflowPanel.tsx`
- Create: `packages/views/cortex-desktop/design/slides/SlidesReviewFindings.tsx`
- Create: `packages/views/cortex-desktop/design/slides/SlidesExportQualityDialog.tsx`
- Modify: `packages/views/cortex-desktop/design/slides/SlidesWorkspace.tsx`
- Modify: `packages/views/cortex-desktop/design/slides/SlidesToolbar.tsx`
- Modify: `packages/views/cortex-desktop/design/slides/SlidesCheckPanel.tsx`
- Modify: `packages/views/cortex-desktop/design/slides/slides-store.ts`
- Modify: `packages/views/cortex-desktop/design/DesignAIRail.tsx`
- Modify: `packages/core/i18n/resources/zh-Hans/design.json`
- Modify: `packages/core/i18n/resources/en/design.json`

---

## Task 0：固定当前基线

**目的:** 固定包含模板下拉和参考页预览的 `9879a99` 为实施基线，避免后续任务误从旧提交开始。

- [ ] 确认 `git merge-base --is-ancestor 9879a99 HEAD` 成功。
- [ ] 在独立 worktree 或从当前干净基线开始本计划。
- [ ] 不执行 `git stash`、`git reset` 或覆盖式 checkout。
- [ ] 将 Electron fixture 从默认并发测试池隔离，修复 Desktop 全量测试偶发 V8 crash。
- [ ] 重新运行三包全量测试、typecheck、lint 和 desktop build，建立绿色基线。

**验证:**

```bash
pnpm --filter @cortex-work/core test
pnpm --filter @cortex-work/views test
pnpm --filter @cortex-work/desktop test
pnpm --filter @cortex-work/core typecheck
pnpm --filter @cortex-work/views typecheck
pnpm --filter @cortex-work/desktop typecheck
pnpm lint
pnpm --filter @cortex-work/desktop build
git diff --check
```

---

## Task 1：增加备注 IPC 与 store 合同

**Files:** IPC mirror、preload、workspace、slides store。

- [ ] 先写镜像契约测试，固定 read/save notes request/result。
- [ ] IPC `slides:readNotes` 只允许读取 manifest 中已有 slot。
- [ ] IPC `slides:saveNotes` 校验 256KB 上限、revision、路径和 slot id。
- [ ] 保存复用 `writeSlideNotes()`，空内容允许保存为空文件；不自动删除 `notesPath`。
- [ ] preload 和 `DesktopBridge` 只增加两项窄方法。
- [ ] store 增加当前页 notes、loading、dirty、saving、savedAt、error、conflict 状态。
- [ ] 切换 deck 时清空 notes 缓存；切页时先 flush 当前页。
- [ ] revision conflict 时保留用户草稿，不以服务端内容静默覆盖。

**测试重点:** 初次保存创建文件、空备注、切页 flush、并发冲突、超限、删除/复制后的归属。

---

## Task 2：实现用户可编辑的备注面板

**Files:** `SlidesNotesPanel.tsx`、Workspace、Toolbar、i18n。

- [ ] Toolbar 增加“备注”开关，快捷键 `N` 只在非输入焦点时生效。
- [ ] 面板位于舞台下方，默认高度 160px，可在 120–360px 内拖动调整。
- [ ] 显示当前页标题、字符数、保存状态和 Agent 生成入口。
- [ ] 使用受控 textarea，600ms debounce 保存。
- [ ] `Cmd/Ctrl+S` 立即保存；切页、关闭面板和卸载前 flush。
- [ ] 冲突态展示“保留我的版本 / 重新加载远端”，不自动合并 Markdown。
- [ ] “生成备注”只向主 Agent 发送结构化 prompt，不在 renderer 直接调用模型。
- [ ] 备注不存在时显示写作提示，不自动生成。
- [ ] PDF/PNG 导出菜单明确标注“不包含备注”。

**验收:** 用户手写备注、Agent 生成备注、重启恢复、PPTX/HTML presenter 查看备注完整闭环通过。

---

## Task 3：定义角色输出 schema 和流水线持久化

**Files:** core pipeline types/schema，desktop pipeline workspace。

- [ ] 为五个角色定义最小结构化输出：
  - Topic：facts、sources、claims、openQuestions。
  - Visual：assetIdeas、chartIdeas、visualRisks。
  - Narrative Review：deck findings、slide findings、suggestedOrder。
  - Render Review：severity、slideId、elementId、code、hint。
  - Notes：每个 slot 的 Markdown 草案。
- [ ] 所有输出限制条目数和总字节数，防止工具结果撑爆上下文或磁盘。
- [ ] 实现 create/load/update/cancel pipeline run，使用临时文件加 rename。
- [ ] run id、role、artifact path 和 deck revision 全部严格校验。
- [ ] 应用重启后可读取最近一次未完成或待批准 run。
- [ ] deck 删除时随 document root 一起清理；单页删除不篡改历史 run。

**测试重点:** schema 拒绝自由形状、原子恢复、旧 revision、损坏 run、路径逃逸。

---

## Task 4：把通用委派升级为角色化 Slides 委派

**原则:** 子 Agent 只研究和提出建议，正式写入仍由父 Agent或用户批准。

- [ ] 保留现有 `delegate_task` 兼容普通 Design，不修改其既有行为。
- [ ] 为 Slides 父回合增加 `delegate_slides_role({ run_id, role, scope, prompt })`。
- [ ] 工具内部仍复用 `runSubAgent`，但自动加入角色 system contract 和 JSON 输出要求。
- [ ] label 固定为 `slides:<role>:<runId>`，不再冒充 `page:<artifactId>`。
- [ ] 子 Agent 不注入 `cortex-slides` 正式写工具，防止并发覆盖。
- [ ] 子 Agent 返回后主进程解析 schema，并写入对应 draft artifact。
- [ ] 解析失败标记 role failed，保留 raw summary 供诊断，但不能进入接受流程。
- [ ] 单角色最多重试两次；run 总并发默认 3，notes writer 在 review 完成后运行。
- [ ] 取消父回合时停止所有 running role 并写 canceled 状态。

**测试重点:** 角色 prompt 隔离、并发上限、取消、JSON 解析失败、子 Agent 无正式写权限。

---

## Task 5：增加流水线 MCP 工具和 Agent 合同

**Files:** Slides tools、slides prompt。

- [ ] 新增：`create_pipeline_run`、`get_pipeline_run`、`record_role_result`、`accept_role_result`、`reject_role_result`。
- [ ] `accept_role_result` 不直接执行任意 patch，只接受已定义动作：
  - research → 更新当前会话上下文，不写 deck。
  - review finding → 写 review findings 文件。
  - notes draft → 经 revision 检查后写对应 notes 文件。
  - reorder suggestion → 返回候选顺序，必须用户确认后调用现有 move/reorder。
- [ ] 主 Agent prompt 明确角色调用顺序和退出条件。
- [ ] ready deck 的“深度审阅”默认执行 narrative + render；不自动重做所有页面。
- [ ] reviewer 默认只报告，不直接修复；修复由父 Agent使用现有 slide 工具执行。
- [ ] 所有工具返回最新 run 状态和可执行 next action。

---

## Task 6：实现 Workflow UI

**Files:** `SlidesWorkflowPanel.tsx`、AIRail、Workspace、store。

- [ ] Toolbar 增加“AI 工作流”入口。
- [ ] 提供三个明确动作：生成前研究、整套深度审阅、批量生成备注。
- [ ] 面板展示 role、状态、耗时、摘要、重试和取消。
- [ ] running 时从 IPC 轮询 `run.json`；Agent 回合结束后立即刷新。
- [ ] awaiting-approval 结果必须由用户接受或拒绝。
- [ ] 点击 review finding 定位 slide；有 elementId 时同步舞台选区。
- [ ] findings 合并显示在 `SlidesCheckPanel`，增加来源筛选：规则检查 / Narrative / Render。
- [ ] 角色原始聊天仍可在 DesignAIRail 查看，但 Workflow Panel 是状态事实来源。
- [ ] 重启后恢复待批准结果，不自动重新执行 Agent。

**验收:** 用户不阅读聊天日志，也能判断每个角色做了什么、是否失败、哪些建议尚未应用。

---

## Task 7：增加 PPTX 可编辑性预检和导出报告

**Files:** export types/deck-export、IPC、store、`SlidesExportQualityDialog.tsx`。

- [ ] 提取器计算 raster node 的裁剪后面积并去重，输出 `rasterAreaRatio`。
- [ ] 增加 `slides:analyzeExportQuality`，只渲染分析，不弹保存框、不写文件。
- [ ] 分析结果包含每页 quality、对象类型计数、降级原因和 warning。
- [ ] Toolbar 选择 PPTX 后先打开质量对话框。
- [ ] 高质量页面直接显示绿色；mixed 显示提示；raster-heavy 明确说明哪些元素不可编辑。
- [ ] 用户可以“继续导出”“取消”“让 Agent 优化这些页面”。
- [ ] “让 Agent 优化”构造包含 slide id、reason、当前 theme 的修订 prompt。
- [ ] 正式 `slides:export` 成功结果附带同一报告，避免预检与导出规则漂移。
- [ ] 报告不记录完整 HTML、用户文本或绝对路径。

**性能约束:** 预检缓存键为 `deckId + manifest.revision`；未修改 deck 时再次导出复用结果。

---

## Task 8：扩展基础原生 PPTX 映射

**优先级顺序:** SVG → 图片裁剪 → 文本列表 → 旋转/透明度 → 表格合并。

- [ ] inline SVG 序列化为 SVG data URI，作为矢量图片写入 PPTX，不进入 base raster。
- [ ] `<img>` 提取 `object-fit/object-position`，映射为 PptxGenJS sizingCrop/sizingContain。
- [ ] 文本节点保留 bullet、numbering、paragraph spacing 和垂直对齐。
- [ ] 支持简单 `transform: rotate()`；含 scale/skew/3D 的节点继续 raster。
- [ ] 映射元素 opacity；复杂 blend mode 继续 raster。
- [ ] 表格提取 rowspan/colspan，并验证 PptxGenJS merge 行为。
- [ ] border-radius 不能可靠表达时不得伪装成完全保真，报告中保留 approximation warning。
- [ ] 每项增加真实 Electron fixture、PPTX XML 断言和 Keynote/PowerPoint 人工样例。

---

## Task 9：增加语义化原生图表

**原则:** 不从任意 canvas 像素反推数据；只有页面显式提供合法 chart spec 才生成原生 chart。

页面合同：

```html
<div data-cortex-chart-id="revenue-chart">
  <script type="application/json" data-cortex-chart-spec>
    {
      "version": 1,
      "type": "bar",
      "categories": ["Q1", "Q2"],
      "series": [{ "name": "收入", "values": [12, 18] }]
    }
  </script>
  <canvas aria-label="季度收入"></canvas>
</div>
```

- [ ] 定义并校验 bar/line/pie 三类 schema，限制 series/category 数量和数值范围。
- [ ] DOM extractor 遇到合法 spec 时生成 `SceneChartNode`，隐藏 canvas，避免重复截图。
- [ ] PptxGenJS 映射原生 chart、legend、颜色、data labels 和坐标轴标题。
- [ ] 非法/缺失 spec 时保持现有 canvas raster fallback。
- [ ] 更新 Slides Agent prompt，要求新生成的数据图表附带 chart spec。
- [ ] 静态检查增加 `chart-spec-invalid` 和 `chart-spec-missing` warning。
- [ ] 导出质量报告区分 native chart 与 raster canvas。

**非目标:** 首期不支持组合图、双轴、散点、雷达、瀑布图和动态图表。

---

## Task 10：整体验收与发布门槛

- [ ] 用户备注：手写、Agent 生成、切页、冲突、重启、四种导出行为通过。
- [ ] Workflow：research/review/notes 各跑一次，失败、取消、重试和批准通过。
- [ ] 验证子 Agent 无法直接改 `slides/*.html` 和 `notes/*.md`。
- [ ] 10 页 deck 导出预检完成时间记录 P50/P95。
- [ ] 10 页 PPTX 导出完成时间记录 P50/P95，满足既有 90 秒门槛。
- [ ] 至少准备一套覆盖 SVG、裁剪图片、列表、旋转、合并表格、bar/line/pie 的 fixture deck。
- [ ] Microsoft PowerPoint 和 Apple Keynote 分别验证打开、编辑、备注和原生 chart。
- [ ] 修复 Desktop 全量测试并发 Electron crash，默认全量命令必须连续通过两次。
- [ ] 当前源码重新构建 arm64/x64 包，不复用 2026-07-13 的旧产物。
- [ ] 仓库外启动打包应用，完成一次真实 Agent 生成和 PPTX 导出。
- [ ] 更新 `2026-07-16-ai-slides-acceptance.md`，只记录本轮真实执行证据。

**最终验证:**

```bash
pnpm --filter @cortex-work/core test
pnpm --filter @cortex-work/views test
pnpm --filter @cortex-work/desktop test
pnpm --filter @cortex-work/core typecheck
pnpm --filter @cortex-work/views typecheck
pnpm --filter @cortex-work/desktop typecheck
pnpm lint
pnpm --filter @cortex-work/desktop build
pnpm --filter @cortex-work/desktop prepackage:mac-arm64
pnpm --filter @cortex-work/desktop build:mac-arm64
pnpm --filter @cortex-work/desktop prepackage:mac-x64
pnpm --filter @cortex-work/desktop build:mac-x64
git diff --check
```

---

## 4. 建议里程碑

### Milestone P2-A：备注闭环

- Task 0–2。
- 用户可查看、编辑和恢复备注。
- 建议先交付，改动面最小、用户价值直接。

### Milestone P2-B：角色化审阅

- Task 3–6。
- research/review/notes 产物可持久化、可批准、可恢复。
- 不要求子 Agent直接改正式 deck。

### Milestone P2-C：导出透明度

- Task 7。
- 用户在导出前知道哪些内容可编辑，避免“导出后才发现整页是图”。

### Milestone P2-D：原生对象增强

- Task 8–10。
- SVG、图片裁剪、列表和常用图表获得更高原生覆盖率。

---

## 5. 风险控制

- 不把 notes 正文、pipeline run 或 export report 塞进 `deck.json`，避免 manifest 膨胀和高频冲突。
- 不给子 Agent正式 deck 写权限；并发只产生 draft，应用动作保持串行。
- 不用“原生对象数量”冒充保真度，必须计算栅格面积。
- 不从 canvas 猜图表数据；无语义 spec 就明确降级。
- 不因追求可编辑性破坏视觉正确性；无法可靠映射时优先保真并报告降级。
- 不在本计划中顺手重构普通 Design Workspace 或通用聊天委派。
- 模板预览能力以 `9879a99` 为既有行为，后续任务必须保留其 IPC、preload 和 UI 合同。
