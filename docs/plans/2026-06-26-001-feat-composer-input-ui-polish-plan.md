---
title: "feat: 会话输入框 UI 优化（GitBar 去背景 + 合并上传按钮 + 底部间距）"
type: feat
date: 2026-06-26
status: ready
depth: lightweight
---

# feat: 会话输入框 UI 优化

## Summary

优化新会话落地页 / 会话内输入框（ComposerShell + GitBar）的三处视觉细节，依据用户标注图：

1. **GitBar 行去背景** —「Plan · 只读」运行模式选择器与「不使用项目」项目选择器去掉灰色填充底色（`var(--bg-chip)`），改为 **透明底 + 描边** 的 chip 样式，与顶部「自动执行」按钮视觉统一。
2. **合并上传入口** — 把当前并排的「图片」「附件」两个独立图标按钮，合并为 **单个上传按钮**，点击弹出小菜单（上传图片 / 上传文档）。
3. **底部间距** — 输入框最底部（GitBar 行）下方保持 **20px** 外边距。

纯前端样式 + 交互微调，不涉及数据层、IPC 或状态管理。改动集中在 `packages/views/cortex-desktop` 的 2 个组件 + 1 个 CSS 文件 + i18n 文案。

---

## Problem Frame

当前输入框底部工具栏存在三个视觉/交互问题：

- **GitBar 行底色突兀**：`.pw-gitbar-mode`（Plan 选择器）复用 `.pw-model-pill` 的灰色填充底色（`cortex-desktop.css:4478`），与同行其它元素及顶部「自动执行」按钮风格不一致，视觉偏重。
- **上传图标占位冗余**：图片、附件是两个独立 `.pill` 按钮（`ComposerShell.tsx:765-790`），横向占据工具栏空间，在 Agent/模型/思考多个选择器挤占下显得拥挤。
- **底部贴边**：GitBar 通过 `.composer-wrap + .pw-gitbar { margin-top: -10px }` 上移贴近输入框，但底部缺少稳定留白。

三处都是有界的展示层调整，行为契约（点击上传、切换模式/项目）保持不变。

---

## Scope Boundaries

**In scope**
- GitBar 行（Plan 模式选择器 + 项目选择器）的 chip 视觉：透明底 + 描边。
- 图片/附件按钮合并为单个上传按钮 + 下拉菜单，沿用现有 `useDismissableMenu` 上弹模式。
- GitBar 底部 20px 外边距。
- 新会话落地页（`NewSessionLanding`）与会话内（`PersonalChatArea`）两处共用 GitBar / ComposerShell，改动需在两处都正确呈现。

**Out of scope（非目标）**
- 不改输入框文本域、发送按钮、Skills/语音/闪记按钮的样式与行为。
- 不改 Agent / 模型 / 思考强度选择器的样式（仍保留 `pw-model-pill` 灰底）。
- 不动上传的实际文件处理逻辑（`onPickFiles` / `onPickDocs`、accept 类型、主进程解析）。

### Deferred to Follow-Up Work
- 若后续要把模型/思考选择器也统一为透明描边风格，单独评估（本次仅 GitBar 行）。

---

## Key Technical Decisions

- **KTD1 — 合并形态采用「单按钮 + 弹菜单」**（用户确认）。保留一个 `Icon.Paperclip` 上传按钮，点击弹出含「上传图片 / 上传文档」两项的小菜单；分别触发既有的隐藏 `<input>`（`fileInputRef` / `docInputRef`）。复用 `useDismissableMenu`（见 `AgentSelect.tsx`）的上弹（`menuPlacement="up"`）模式，保持与同行 Agent 选择器一致的交互范式。
  - 备选「外框包两个图标」已被用户否决。
- **KTD2 — GitBar chip 采用透明底 + 描边**（用户确认），对齐「自动执行」按钮风格。不下沉为「完全无边框纯文字」。实现上为 `.pw-gitbar-mode` 增加局部覆盖（去 `--bg-chip` 填充、加 `1px solid var(--border)` 描边），并让 `ProjectPicker` 触发器在 GitBar 内呈现同款描边（其默认已是透明底 `pw-proj-picker-trigger`，仅需补描边以视觉对齐）。
  - 作用域限定在 GitBar 行：通过 `.pw-gitbar .pw-gitbar-mode` / `.pw-gitbar .pw-proj-picker-trigger` 限定选择器，避免影响其它复用 `pw-model-pill` 的元素。
- **KTD3 — 底部 20px 用 GitBar 的 `margin-bottom`**。在 `.pw-gitbar` 上补 `margin-bottom: 20px`（当前 `margin: 0 40px`）。注意与落地页前缀 `.pw-landing .pw-gitbar`（`cortex-desktop.css:7277`）和密度档位 `[data-density]` 不冲突——这些只覆盖横向 `margin-inline`，纵向 margin 不被覆盖。

---

## Implementation Units

### U1. GitBar 行去背景 + 底部 20px 间距（CSS）

**Goal**：GitBar 行的 Plan 模式选择器与项目选择器改为透明底 + 描边；GitBar 底部留 20px。

**Requirements**：标注①「去除背景，效果如上图」、标注③「底部保持 margin 20px」。

**Dependencies**：无。

**Files**：
- `packages/views/cortex-desktop/cortex-desktop.css`（修改）

**Approach**：
- `.pw-gitbar`（`:1310`）：在现有 `margin: 0 40px` 基础上补底部外边距 → 改为纵向 `20px`、横向 `40px`（如 `margin: 0 40px 20px`）。验证密度档位 `[data-density="compact"|"cozy"] .pw-gitbar`（`:1387-1388`）只设 `margin-inline`，不会覆盖底部值；落地页 `.pw-landing .pw-gitbar`（`:7277`）只设 `margin-inline: auto`，同样不覆盖。
- 新增作用域限定规则，去掉 GitBar 内 chip 的灰底、加描边：
  - `.pw-gitbar .pw-gitbar-mode`：覆盖 `background: transparent` + `border: 1px solid var(--border)`（`.pw-model-pill` 本身无 border，需新增），保持现有紧凑 padding。
  - `.pw-gitbar .pw-proj-picker-trigger`：补 `border: 1px solid var(--border)`（其默认 border 为 transparent，`:7208`），使透明底也有描边、与 Plan 选择器对齐；保留 hover/`data-open` 既有反馈。
- 注意 hover 态：`.pw-model-pill:hover { background: var(--bg-hover) }`（`:4482`）会在 GitBar 内仍生效，需确认透明底 + hover 灰底的过渡观感可接受；如不一致，在 GitBar 作用域内同步覆盖 hover。

**Patterns to follow**：顶部「自动执行」按钮的描边 chip 风格；`.pw-gitbar-stats` / `.pw-gitbar-commit`（`:1363` / `:1376`）已有的 `border: 1px solid var(--border…)` 描边写法。

**Test scenarios**：`Test expectation: none — 纯展示层 CSS 调整，无行为变化`。验证以人工 / 截图回归为主（见 Verification）。

**Verification**：
- 落地页与会话内两处 GitBar：Plan 选择器、项目选择器均为透明底 + 描边，无灰色填充块。
- 亮色 / 暗色主题下描边色（`--border`）均可见、对比适中。
- GitBar 下方有 20px 留白；compact / cozy 密度档横向边距仍随档位变化、纵向恒为 20px。

---

### U2. 合并图片/附件为单个上传按钮（弹菜单）

**Goal**：用一个上传按钮 + 下拉菜单（上传图片 / 上传文档）替换并排的两个图标按钮，行为等价。

**Requirements**：标注②「合并为一个」。

**Dependencies**：无（与 U1 独立，可并行）。

**Files**：
- `packages/views/cortex-desktop/personal/ComposerShell.tsx`（修改 `:765-798` 区域）
- `packages/views/cortex-desktop/cortex-desktop.css`（新增上传按钮/菜单样式）
- `packages/core/i18n/resources/zh-Hans/chat.json`（新增菜单项/按钮文案）
- `packages/core/i18n/resources/en/chat.json`（同步英文）
- `packages/core/i18n/@types/resources.d.ts`（若 i18n key 需登记类型）
- `packages/views/cortex-desktop/personal/ComposerShell.test.tsx`（新增/补充测试，若不存在则就近创建）

**Approach**：
- 保留两个隐藏 `<input>`（`fileInputRef` 接受图片、`docInputRef` 接受文档）及其 `onChange`（`onPickFiles` / `onPickDocs`）不变——仅改触发它们的 UI。
- 用单个 `.pill` 按钮（图标沿用 `Icon.Paperclip`，或 `Icon.Plus`）替换原图片+附件两个按钮；点击切换一个上弹小菜单。
- 菜单复用 `useDismissableMenu`（`personal/useDismissableMenu.ts`，`AgentSelect.tsx` 同款）实现点击外部 / Esc 关闭、`menuPlacement="up"` 上弹。菜单两项：
  - 「上传图片」→ `fileInputRef.current?.click()` 后关闭菜单。
  - 「上传文档」→ `docInputRef.current?.click()` 后关闭菜单。
- 文案：复用既有 `composer.uploadImage` / `composer.uploadDoc` 作菜单项文案；按钮 `aria-label` / `title` 新增 `composer.attach`（如「添加附件」/ "Attach"）。
- a11y：按钮 `aria-haspopup="menu"`、`aria-expanded`，菜单项为 `role="menuitem"`，与 `AgentSelect` 一致。

**Patterns to follow**：`AgentSelect.tsx`（`useDismissableMenu` + `menuPlacement="up"` + 上弹菜单结构）；菜单容器样式可复用 `.pw-ctx-menu` / `.pw-tb-menu-item` 体系（`ProjectMenu.tsx` / `FileContextMenu.tsx` 在用）。

**Test scenarios**：
- Happy path：点击上传按钮 → 菜单出现，含「上传图片」「上传文档」两项。
- Happy path：点击「上传图片」→ 触发 `fileInputRef`（隐藏 input 的 `accept` 仍为图片类型）且菜单关闭。
- Happy path：点击「上传文档」→ 触发 `docInputRef`（`accept` 仍为 `DOC_ACCEPT_ATTR`）且菜单关闭。
- Edge：菜单打开时点击外部 / 按 Esc → 菜单关闭（`useDismissableMenu` 行为）。
- Edge：`running`（生成中）态下按钮的禁用/可用表现与改动前一致（核对原两个按钮是否受 `running` 影响——原代码未禁用，合并后保持不禁用）。
- a11y：按钮 `aria-expanded` 随菜单开合切换；菜单项可键盘聚焦。

**Verification**：
- 落地页与会话内 ComposerShell 工具栏只剩一个上传按钮，图片 / 文档上传均可正常发起。
- 既有图片/文档上传后续流程（预览 chip、发送、主进程解析）不受影响。
- `pnpm --filter @cortex-work/views test` 通过；`pnpm typecheck`、`pnpm lint` 通过。

---

## System-Wide Impact

- **共用组件双入口**：`GitBar` 与 `ComposerShell` 同时被 `NewSessionLanding`（新会话落地页）与 `PersonalChatArea`（会话内）挂载，CSS 与组件改动会同时作用于两处，需在两处都验证。
- **i18n 全量提取坑**（见记忆 [[i18n-extract-ci-gotcha]]）：新增 i18n key 会触发 extract 全量规范化；只提交本次新增 key 的最小 diff，不要把规范化全量输出一并提交。
- **未分层 button reset 坑**（见记忆 [[cortex-css-unlayered-button-reset]]）：`cortex-desktop.css` 存在未分层的 `button` reset 恒胜 Tailwind 工具类；新上传按钮 / 菜单项若用 `<button>`，样式走 `wf-*` / 既有 `.pill`、`.pw-tb-menu-item` 类，避免被 reset 吃掉。

---

## Risks & Dependencies

- **Hover 观感**：GitBar chip 从灰底改透明描边后，`pw-model-pill:hover` 的灰底 hover 在透明态下对比变化更明显，需人工核对是否需要在 GitBar 作用域内调 hover。低风险，截图即可判定。
- **菜单层级 / 定位**：上弹菜单在底部工具栏，需确保不被输入框容器 `overflow` 裁剪或被其它浮层遮挡。复用 `AgentSelect` 同款定位可规避（其已在同一行验证可用）。
- **密度档位回归**：确认 compact / cozy 下 GitBar 底部 20px 与横向档位边距并存无冲突。
