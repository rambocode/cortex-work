---
title: "feat: 闪记跨项目移动 + 写作面三档加宽"
type: feat
date: 2026-06-24
status: ready
depth: standard
---

# feat: 闪记跨项目移动 + 写作面三档加宽

## Summary

两个相互独立的桌面端闪记体验改进,合为一个 plan:

1. **闪记可移动到不同项目** —— 让任意闪记(不止「未归类」)都能切换归属项目,并可移回「未归类」。入口出现在三处:列表每条闪记、宽写作面 `FlashNoteEditor` 顶栏、右栏速览 `NoteDetail`。
2. **源码 / 实时预览 / 仅预览三档加宽** —— 正文列从当前 750px 居中改为「满宽,左右各留 70px」,三档统一、切档不跳变。

数据层(`NotesStore.update` + `notesUpdate` 桥接 + `NotePatch.projectId`)已完整支持改归属,无需后端/store 改动;两个需求本质都是**渲染层(组件 + CSS)改造**。

---

## Problem Frame

- 现状下闪记的归属项目**只能在创建时定下**:列表里的 `MoveToProjectMenu` 仅对「未归类」分组的行渲染(`NotesView.tsx` NoteGroup 内 `{!group ? <MoveToProjectMenu/> : null}`),且菜单选项只有项目、没有「未归类」也不排除当前项目。一旦闪记归错项目,用户无法纠正,只能删除重建。
- 写作面三档(源码/实时预览/仅预览)共享 750px 居中「版心」(`.pw-note-cm-host .cm-content` 与 `.pw-note-editor-preview > .pw-todo-md` 的 `max-width: 750px`)。在宽屏桌面中栏里,750px 偏窄,长文/代码块横向空间不足,用户希望更贴近编辑器宽度的书写区。

---

## Requirements

- **R1** 列表中任意闪记(含已归某项目的)都可经下拉菜单切换到另一个项目。
- **R2** 移动目标列表排除当前项目,并提供「未归类」项,允许把已归项目的闪记移回未归类;未归类闪记的菜单不出现「未归类」项。
- **R3** 移动入口同时出现在三处:列表每条闪记、宽写作面 `FlashNoteEditor` 顶栏、右栏速览 `NoteDetail`,三处复用同一菜单组件与移动逻辑。
- **R4** 源码 / 实时预览 / 仅预览三档正文列改为「满宽,左右各预留 70px」,三档列宽与位置一致,互相切换不跳变。

成功标准:改归属即时生效并跨重启持久(含移回未归类);三档加宽后视觉一致;`pnpm --filter @cortex-work/views test`、`pnpm typecheck`、`pnpm lint` 全绿。

---

## Key Technical Decisions

- **KTD1 — 复用既有数据层,零后端改动。** 移动 = `useUpdateNote().mutateAsync({ id, patch: { projectId } })`。移回未归类传 `projectId: undefined`:经 contextBridge + Electron IPC(structured clone 保留对象的 `undefined` 属性)抵达主进程,`NotesStore.update` 的字段级合并 `{...note, ...patch}` 把 `projectId` 置为 `undefined`,`JSON.stringify(data, null, 2)` 落盘时自然丢弃该键 → 重载后 `projectId` 缺省 = 未归类(与 `NoteMeta.projectId?` 语义一致)。**该路径有序列化层风险,见 Risks。**
- **KTD2 — 抽取共享 `MoveToProjectMenu` 组件。** 现组件内联在 `NotesView.tsx`,而 `FlashNoteEditor` 在独立文件需复用,故抽到 `personal/MoveToProjectMenu.tsx`,三处共用。避免菜单的 hover 自动收起 / outside-click 关闭范式在三处各写一份导致漂移。
- **KTD3 — 70px 固定留白,三档统一。** 按需求字面取固定 70px(非响应式 `clamp`)。CM 横向留白由 `EditorView.theme` 的 `.cm-content` padding 拥有(去掉 `max-width: 750px` 即满宽,padding 70px 形成左右 gutter);仅预览同步去 `max-width`、横向 padding 改 70px,使三档同宽同位、切档不跳变。
- **KTD4 — 移动入口沿用现有菜单关闭范式。** hover 离开延时收起 + mousedown outside 关闭(`NotesView.tsx` MoveToProjectMenu 现有实现,与 PersonalTopBar `ProjectMenu`、TodosView `ArchiveMenu` 一致)。

---

## Implementation Units

### U1. 抽取并泛化 MoveToProjectMenu(列表全行可移动 + 未归类目标 + 排除当前项目)

- **Goal**:把内联在 `NotesView` 的 `MoveToProjectMenu` 抽成独立共享组件并泛化为「任意闪记换项目 / 移回未归类」,列表所有行(不止未归类)都挂入口。
- **Requirements**:R1、R2,并为 R3 提供共享组件。
- **Dependencies**:无(打头)。
- **Files**:
  - `packages/views/cortex-desktop/personal/MoveToProjectMenu.tsx`(新建:从 NotesView 迁出 + 泛化)
  - `packages/views/cortex-desktop/personal/NotesView.tsx`(改为 import;`NoteGroup` 移除 `!group` guard,所有行渲染菜单并传 `currentProjectId={group?.id}`;`moveTo` 与 `onMoveTo` 的 `projectId` 改 `string | undefined`)
  - `packages/core/i18n/resources/zh-Hans/notes.json`、`packages/core/i18n/resources/en/notes.json`(`group` 段新增「移回未归类」项标签键,如 `group.moveToUnassigned`;列表项「未归类」可复用现有 `group.unassigned`)
  - `packages/core/i18n/@types/resources.d.ts`(同步类型;注意 i18n extract 全量规范化坑,见 Patterns)
  - `packages/views/cortex-desktop/personal/NotesView.test.tsx`、`packages/views/cortex-desktop/personal/MoveToProjectMenu.test.tsx`(新建)
- **Approach**:
  - 组件 props 增 `currentProjectId?: string`;`onPick` 签名改 `(projectId: string | undefined) => void`。
  - 选项 = `liveProjects.filter(p => p.id !== currentProjectId)`;当 `currentProjectId` 存在时,在菜单顶部追加「未归类」项 → `onPick(undefined)`;`currentProjectId` 不存在(已是未归类)则不显示「未归类」项。
  - 空态:无其它可选项目且无未归类项可显示时,沿用现 `group.noArchivableProject` 文案。
  - `NoteGroup`:删 `{!group ? ... : null}`,所有行渲染 `<MoveToProjectMenu currentProjectId={group?.id} projects={liveProjects} onPick={(pid) => onMoveTo(n.id, pid)} />`。
  - `moveTo(noteId, projectId: string | undefined)`:`updateNote.mutateAsync({ id: noteId, patch: { projectId } })`(显式带 `projectId` 键,`undefined` 即移回未归类),成功/失败沿用现有 `toast.moved` / `toast.moveFailed`。
- **Patterns to follow**:菜单关闭范式照搬现 `MoveToProjectMenu`(closeTimer + outside mousedown);i18n 加 key 后注意 extract 仅提交新增键,勿提交规范化全量输出(见 MEMORY「i18n extract CI 坑」)。
- **Test scenarios**:
  - 已归项目 `p1` 的闪记行渲染「移到项目」入口(此前仅未归类有)。Covers R1.
  - 该菜单选项排除当前项目 `p1`,含其它项目 `p2`,并含「未归类」项。Covers R2.
  - 点 `p2` → `notesUpdate` 以 `{ projectId: "p2" }` 调用,触发 `toast.moved`。
  - 点「未归类」→ `notesUpdate` 以 `patch` 含 `projectId: undefined` 调用。
  - 未归类闪记的菜单**不含**「未归类」项,只列项目。Covers R2.
  - 仅一个项目且当前即该项目、无其它目标 → 菜单只剩「未归类」项(或空态文案)。

### U2. 宽写作面(FlashNoteEditor)顶栏接入移动菜单

- **Goal**:`FlashNoteEditor` 顶栏把静态项目徽标换成可切换项目的入口。
- **Requirements**:R3。
- **Dependencies**:U1。
- **Files**:
  - `packages/views/cortex-desktop/personal/FlashNoteEditor.tsx`(替换 header 中 `project ? <span class="pw-todo-total">…</span> : <span class="pw-readonly">未归类</span>` 一段)
  - `packages/views/cortex-desktop/cortex-desktop.css`(若菜单触发器在顶栏需要不同于列表行的外观,增/调样式)
- **Approach**:复用 `MoveToProjectMenu`,`currentProjectId={note.projectId}`,`projects={liveProjects}`(从 `usePersonalStore(s => s.projects)` 过滤未归档),`onPick={(pid) => updateNote.mutateAsync({ id: noteId, patch: { projectId: pid } }).then(...toast)}`。触发器外观沿用现项目徽标/灰字「未归类」的位置,使其可点开菜单。
- **Patterns to follow**:`FlashNoteEditor` 已有 `useUpdateNote`、`onToast`;toast 文案复用 notes 命名空间。
- **Test scenarios**:
  - 顶栏渲染项目切换器;点开列出可选项目 + 未归类。Covers R3.
  - 选另一个项目 → `notesUpdate` 带新 `projectId` 调用。
  - 注:`FlashNoteEditor` 正文区依赖 CodeMirror 动态 import,jsdom 下默认 `live` 档可能走 `onLoadError` 降级到仅预览;测试聚焦顶栏菜单交互,不依赖编辑器装载。移动核心逻辑已由 U1 菜单单测覆盖,此处为浅层接线验证。

### U3. 右栏速览详情(NoteDetail)接入移动菜单

- **Goal**:`NotesView` 内 `NoteDetail` 头部加移动入口。
- **Requirements**:R3。
- **Dependencies**:U1。
- **Files**:`packages/views/cortex-desktop/personal/NotesView.tsx`(`NoteDetail` 组件 header)
- **Approach**:在 `NoteDetail` header(返回/编辑/删除按钮区附近)渲染 `<MoveToProjectMenu currentProjectId={note.projectId} projects={liveProjects} onPick={...} />`。`NoteDetail` 是 `NotesView` 内的子组件:复用父级 `moveTo`(经 prop 下传)或就近用 `useUpdateNote` —— 优先经 prop 下传父级 `moveTo`,避免在子组件重复 hook 与 toast 装配。
- **Patterns to follow**:与 U2 同源的菜单接线;`NoteDetail` 现有按钮布局与 `pw-icon-btn` 样式。
- **Test scenarios**:
  - 打开某闪记右栏速览详情 → 头部渲染移动入口。Covers R3.
  - 在详情里选另一个项目 → `notesUpdate` 带新 `projectId` 调用。

### U4. 源码 / 实时预览 / 仅预览三档加宽至「满宽 − 左右各 70px」

- **Goal**:三档正文列从 750px 居中改为满宽、左右各留 70px,三档同宽同位。
- **Requirements**:R4。
- **Dependencies**:无(与 U1-U3 解耦,可并行)。
- **Files**:
  - `packages/views/cortex-desktop/cortex-desktop.css`:
    - `.pw-note-cm-host .cm-content`:`max-width: 750px` → `max-width: none`(配合既有 `width: 100%`、`flex-grow: 0` 满宽);`.cm-scroller { justify-content: center }` 满宽下无副作用,可保留。
    - `.pw-note-editor-preview > .pw-todo-md` 与 `.pw-note-editor-preview > .pw-empty-hint`:`max-width: 750px` → `none`;横向 padding `clamp(24px, 5vw, 48px)` → `70px`。
    - 更新相邻注释,把「三档统一 750px 版心」契约改述为「三档统一满宽 − 左右各 70px」。
  - `packages/views/cortex-desktop/personal/editor/NoteCodeMirrorEditor.tsx`:`buildTheme` 里 `.cm-content` 的 `padding: "clamp(28px, 5vh, 56px) clamp(24px, 5vw, 48px) 120px"` → 横向改 70px:`"clamp(28px, 5vh, 56px) 70px 120px"`(纵向不变)。
- **Approach**:横向留白归各自的 padding(CM theme / 预览 `.pw-todo-md`)拥有,去掉 `max-width` 让内容满宽;三档横向 padding 统一 70px,保证列宽一致、切档不跳变。
- **Patterns to follow**:现 CM theme 与 CSS 的「版心宽度归 CSS、横向内边距归 CM padding」分工(`NoteCodeMirrorEditor` 注释已述);保持注释与实现同步(项目注释规约)。
- **Test scenarios**:`Test expectation: none -- 纯样式/版心宽度调整,无行为变更。` 验证靠手动视觉:`pnpm dev:desktop` 打开一条闪记,三档切换确认正文列满宽、左右各 70px、切档不跳变(短文/长文/代码块各看一遍)。

---

## Scope Boundaries

**In scope**:三处移动入口(列表行 / 写作面顶栏 / 右栏详情)、目标含「未归类」、三档加宽固定 70px。

### Deferred to Follow-Up Work
- 多选**批量**移动到项目(现多选语义专用于「深化」,不复用作移动)。
- 移动到**已归档**项目(目标仅活跃项目 `liveProjects`,与现归档约定一致)。
- 加宽留白的响应式/可配置化(固定 70px,不做窄窗自适应)。
- Web 端:闪记为桌面能力(`notesAvailable` 依赖 `desktopBridge`),不在本期。

---

## Risks & Dependencies

- **R-risk1(中)— `projectId: undefined` 跨 IPC 清空字段的序列化可靠性。** 单测用 fake bridge,不经过 contextBridge / Electron 真实序列化层;理论上 structured clone 保留对象 `undefined` 属性,但需**实跑验证一次**「项目 → 未归类」往返(`pnpm dev:desktop`:移回未归类 → 重启 → 仍未归类)。**回退**:若 `undefined` 被吞,改用 `null` 哨兵 —— `moveTo` 传 `projectId: null`,主进程 `NotesStore.update` 把 `null` 视作删除该键(`delete next.projectId`)。该回退会扩散到 `NotePatch` 类型与 preload/main,故优先验证 `undefined` 路径。
- **R-risk2(低)— 窄窗留白偏多。** 三档固定 70px gutter,极窄中栏(内容 < ~300px)留白占比偏高;桌面中栏一般足够宽,接受;如反馈强烈再加 min。
- **依赖**:U2、U3 依赖 U1 抽出的共享组件;U4 独立可并行。i18n 改动注意 extract 规范化坑(MEMORY「i18n-extract-ci-gotcha」)。

---

## Verification

- `pnpm --filter @cortex-work/views test`(NotesView / MoveToProjectMenu 单测)
- `pnpm typecheck` + `pnpm lint`(含 i18n 类型同步)
- 手动:`pnpm dev:desktop` 验证三处移动入口(含移回未归类 + 重启持久)与三档加宽视觉一致。
