---
title: "feat: Tasks 文档二次编辑并发送到 Agent"
type: feat
date: 2026-06-21
origin: docs/brainstorms/2026-06-21-tasks-doc-secondary-edit-send-requirements.md
---

# feat: Tasks 文档二次编辑并发送到 Agent

## Summary

在 tasks 文档详情态选中一段文本后，**直接弹出二次编辑面板**（面板与遮罩**仅限右栏文档区**，不弹全屏遮罩；非工具栏常驻按钮、非浮出小按钮）：写调整意见，把「文档路径引用 + 选中段落 + 意见」复用 `sendContext` 拼装，经 `usePersonalStore` 送进当前会话聊天框或终端。聊天框额外支持「插入并运行」——通过给现有 `composerInsert` 信号加一个 `submit` 标志，让 `ComposerShell` 插入后自动提交；终端只插入。此外，详情态支持复用现有 Monaco 编辑器在线编辑该 MD 文档并保存（`bridge.writeFile`）。

---

## Problem Frame

`TasksDocsView` 的文档详情态（`packages/views/cortex-desktop/personal/TasksDocsView.tsx` 的 `DocDetail`）目前只读：对一份文档用户只能点「继续」（固定提示词新建会话）或用系统编辑器外部打开。缺中间档——读到某段、想就这段给 claude/codex 一句自定义指令，却没有应用内入口把「文档上下文 + 我的话」一次递过去。文件管理 `FilesView` 已为「文件选区 → 聊天框/终端」做了这件事（`insertToComposer` / `sendToTerminal` + `buildContextSnippet`），tasks 文档复用同一套即可（see origin: `docs/brainstorms/2026-06-21-tasks-doc-secondary-edit-send-requirements.md`）。

---

## Requirements

**入口与对话框**

- R1. tasks 文档详情态（`DocDetail`）选中一段文本（鼠标释放）即直接打开二次编辑面板；面板与遮罩**仅限右栏文档区**（`pw-doc-edit-overlay` 为 `position:absolute` 盖住 `.pw-todo-detail`），不弹全屏遮罩。
- R2. 对话框含多行文本输入框，供用户手写调整意见。
- R3. 对话框可见地展示本次将携带的上下文（文档路径引用，及选中段落——若有）。

**上下文拼装**

- R4. 发送文本由文档路径引用、选中段落（可选）与用户意见组成，顺序为「引用内容在前、用户意见在后」。**有选区**时上下文块复用 `buildContextSnippet`（`packages/views/cortex-desktop/personal/sendContext.ts`）；**无选区**时不调用 `buildContextSnippet`（其会无条件包一层代码围栏，空选区会产出空围栏），改用裸路径引用。
- R5. 选区即触发：选中段落随意见一起发送；浮层仅在有非空选区时出现，故发送时必有选中段落（`buildPathRef` 作无选区防御性兜底）。

**发送通道与动作**

- R6. 对话框提供「插入到聊天框」与「发送到终端」两个通道，分别复用 `insertToComposer` 与 `sendToTerminal`（终端走 `wrapBracketedPaste`）。沿用既有 `sendToChatBtn` / `sendToTerminalBtn` 文案命名。
- R7. 聊天框通道额外提供「插入并运行」动作：填入 composer 后自动提交，无需用户再回车。
- R8. 终端通道仅「插入」，不自动执行（不在 bracketed paste 后补回车）。
- R9. 发送后给出 toast 反馈并关闭对话框。

**在线编辑**

- R10. 详情态提供「编辑」入口，复用现有 Monaco 编辑器（`MonacoViewer`）对该 MD 文档做源码编辑；保存经 `bridge.writeFile(doc.path, draft)` 写回，成功后同步详情内容并 toast。
- R11. 复用 FilesView 的编辑范式：dirty 标记、⌘S 保存、「完成」退出编辑（退出前若 dirty 先保存）；切换文档时重置编辑态。

---

## Key Technical Decisions

- KTD1. **扩展现有 `composerInsert` 信号，不另开通道。** 给 `composerInsert` 加可选 `submit?: boolean`，`insertToComposer(text, opts?)` 透传。复用既有 nonce 去重通道，自动提交天然受 `send()` 内部 `running/sending/空文本` 守卫保护。这使「插入后自动发送」成为所有会话共用的通用能力（任何调用方可用），符合 origin 确认的范围。
- KTD2. **自动提交以「显式文本」触发，不读旧 state。** `send()` 读闭包内 `text` state，而 `setText` 异步——同 tick `setText` 后直接 `send()` 会发旧文本。正解是让发送路径接受**显式文本参数**（现成先例：`ComposerShell.tsx:415` 已有 `onSend(c.cmd, [])` 以显式文本发送 slash 命令），消费 effect 算出最终文本后 `setText` 兼以该显式文本触发发送。`requestAnimationFrame` 仅用于 setText 后聚焦，不作为「等 state 更新」的手段。注意：自动提交须复用 `onSend` 既有分支（`/clear`、`/compact`、editing 重发，见 `PersonalChatArea.tsx:460-483`），并确保拼装文本不被误判为 slash 命令。
- KTD3. **选区即触发面板 + `window.getSelection()` 取段落。** `DocDetail` 是 `MarkdownView` 渲染态，没有 Monaco 那套选区回调；在 md 容器 `onMouseUp` 读 `window.getSelection()`，非空（trim 后）即把选区文本存入 state 并打开面板。仅监听 `onMouseUp`（不监听 `onKeyUp`，避免 shift 扩选时每个 keyup 反复弹窗）。
- KTD4. **降级策略（仅聊天框需要）。** 「插入并运行」在 CLI 运行中（`running`）或无活跃会话（composer 未挂载）时，退化为「只插入 + toast 提示」，不排队、不自动新建会话。无会话时插入信号无人消费而丢失——继承 `FilesView` 现有行为。终端通道无此问题：`sendToTerminal` 置 `terminalOpen:true` 会唤起终端，PTY 未就绪时片段先暂存待投递，故无「无终端」降级缺口。
- KTD5. **面板拆为独立组件 `DocEditDialog`，遮罩限右栏。** 沿用 `pw-confirm-dlg` 紧凑纵向布局，但遮罩用 `pw-doc-edit-overlay`（`position:absolute; inset:0`，盖住作为定位祖先的 `.pw-todo-detail`），**不**用全屏的 `pw-dlg-overlay`；面板宽度跟随右栏（`min-width:0`，避免默认 confirm 的 360 溢出窄轨）。与 `DocDetail` 解耦，避免 `TasksDocsView.tsx` 继续膨胀（1200 行上限）。
- KTD6. **上下文路径用相对 `doc.path`。** `toTildePath` 对相对路径原样返回，可接受；不为生成 `~` 形式而额外解析绝对路径。

---

## Implementation Units

### U1. store：`composerInsert` 增加 `submit` 标志

- **Goal:** 让 `insertToComposer` 能携带「插入后自动提交」意图。
- **Requirements:** R7
- **Dependencies:** 无
- **Files:**
  - `packages/core/store/personal.ts`（`composerInsert` 类型 ~`:99`、`insertToComposer` 签名 ~`:224`、实现 ~`:725`）
  - `packages/core/store/personal.test.ts`（既有断言 ~`:230`）
- **Approach:** `composerInsert` 形状由 `{ text, nonce }` 扩为 `{ text, nonce, submit?: boolean }`；`insertToComposer(text: string, opts?: { submit?: boolean })`，set 时写入 `submit: opts?.submit`。沿用 `:97-99` 对 `composerInsert` 的 `zh-Hans` 注释风格，补一句说明 `submit` 是「插入后自动发送」的跨组件契约。
- **Patterns to follow:** 现有 `insertToComposer` / `composerInsert` 实现与注释。
- **Test scenarios:**
  - `insertToComposer("x")` → `composerInsert.text==="x"`、`submit` 为 undefined/false、`nonce` 递增。
  - `insertToComposer("x", { submit: true })` → `submit===true`、`nonce` 递增。
  - 连续两次调用 `nonce` 单调递增。
- **Verification:** `pnpm --filter @cortex-work/core test` 通过，类型检查无误。

### U2. ComposerShell：消费 `submit` 自动提交

- **Goal:** 收到带 `submit` 的插入信号时，插入文本后自动发送。
- **Requirements:** R7, R8（终端不受影响）
- **Dependencies:** U1
- **Files:**
  - `packages/views/cortex-desktop/personal/ComposerShell.tsx`（消费 effect `:286-297`、`send` `:187-199`）
  - `packages/views/cortex-desktop/personal/ComposerShell.test.tsx`（若不存在则新建）
- **Approach:** 在 `acceptComposerInsert` 的消费 effect 内，按现有逻辑算出最终拼接文本并 `setText`；若 `composerInsert.submit && !running`，按 KTD2 以**显式文本**触发发送路径（不读旧 `text` state）。`running` 为真时跳过自动发送（降级，见 U3 的 toast）。保持 nonce 去重不变。
- **Patterns to follow:** 现有消费 effect 的 nonce 去重与 `requestAnimationFrame(focus)`；`send` 的守卫。
- **Test scenarios:**
  - `submit:true` 且 `running=false` → setText 后自动触发发送，发送内容为完整拼接文本（非旧 text）。
  - `submit:false`（或未带）→ 只 setText，不发送（现有行为不回归）。
  - `submit:true` 但 `running=true` → 不自动发送（只插入）。
  - 目标文本为空 → 不发送（`send` 守卫）。
  - `acceptComposerInsert=false` → 既不插入也不发送。
  - 同一 nonce 不重复消费。
- **Verification:** ComposerShell 单测通过；手动验证会话页二次编辑「插入并运行」会真正发起 CLI。

### U3. DocEditDialog 组件 + DocDetail 接线

- **Goal:** 详情态新增「二次编辑」入口与弹框，完成选区抓取、上下文拼装与三种发送动作。
- **Requirements:** R1, R2, R3, R4, R5, R6, R8, R9
- **Dependencies:** U1, U2, U4
- **Files:**
  - `packages/views/cortex-desktop/personal/DocEditDialog.tsx`（新建）
  - `packages/views/cortex-desktop/personal/DocEditDialog.test.tsx`（新建）
  - `packages/views/cortex-desktop/personal/TasksDocsView.tsx`（`DocDetail` 选区浮层 + 接线）
  - `packages/views/cortex-desktop/cortex-desktop.css`（局部遮罩 `pw-doc-edit-overlay` + 面板 `pw-doc-edit-dlg` 样式）
- **Approach:**
  - `DocDetail` 在 md 容器 `onMouseUp` 检测选区，非空即存选区文本并打开面板（KTD3）；把 `onToast` 透传进 `DocDetail`（原签名只有 `doc`/`onBack`）。
  - `DocEditDialog` 用 `pw-doc-edit-overlay`（限右栏的局部遮罩，KTD5）+ `pw-confirm-dlg`：标题、上下文预览（路径 + 无选区提示）、意见 textarea、三个动作按钮（插入到聊天框 / 插入并运行 / 发送到终端）、ESC 关闭（照 `PiToolConfirmDialog.tsx:25-33`）。
  - 拼装（R4）：最终文本 = 上下文块 + 用户意见（引用在前、意见在后）。有选区时上下文块 = `buildContextSnippet(doc.path, selection)`；无选区时改用裸路径引用（不调用 `buildContextSnippet`，避免空代码围栏）。**弹框的上下文预览必须与实际发送文本一致**——预览有选区/无选区两种形态各自对应同一拼装逻辑。
  - 聊天框走 `insertToComposer(text, { submit })`（「插入」submit=false、「插入并运行」submit=true）；终端走 `sendToTerminal(wrapBracketedPaste(text))`。
  - **意见为空**时禁用全部三个动作按钮（可见禁用态）——意见是必填，不支持仅发上下文。
  - 三个动作按钮点击即同步关闭弹框，避免重复点击触发二次投递。
  - 各动作后 `onToast(...)` 并关闭弹框（R9）。「插入并运行」遇运行中/无会话由 U2 降级，文案上 toast 提示「已插入，待发送」。
- **Patterns to follow:** `FilesView.tsx:338-350`（`sendSelectionToTerminal`/`sendSelectionToChat`）、`PiToolConfirmDialog.tsx:43-66`（弹框骨架）、`AutomationDialog.tsx:48-63`（表单原语）。
- **Test scenarios:**
  - 弹框渲染：textarea + 三个动作按钮 + 上下文预览。
  - 有选区时上下文含「路径 + 选中段落」；无选区时仅路径（Covers AE1）。
  - 点「插入到聊天框」→ `insertToComposer` 被调用，submit 为 false，文本含意见与上下文。
  - 点「插入并运行」→ `insertToComposer` 的 opts `submit===true`（Covers AE2）。
  - 点「发送到终端」→ `sendToTerminal` 收到 `wrapBracketedPaste` 包裹文本，不含自动回车（Covers AE2）。
  - 任一动作后触发 `onToast` 且弹框关闭（Covers R9）。
  - ESC 关闭弹框。
  - 意见为空时三个动作按钮禁用；非空时启用。
  - 无选区时上下文不含空代码围栏（裸路径引用），预览与发送文本一致（Covers AE1）。
- **Verification:** `pnpm --filter @cortex-work/views test` 通过；手动：详情态选中一段 → 二次编辑 → 三种动作分别落到聊天框（含自动运行）与终端。

### U4. i18n 文案

- **Goal:** 弹框标题、按钮、toast 文案走 i18n。
- **Requirements:** R9（toast）、R1/R2/R6/R7（按钮与标题）
- **Dependencies:** 无
- **Files:**
  - `packages/core/i18n/resources/zh-Hans/files.json`
  - `packages/core/i18n/resources/en/files.json`
  - `packages/core/i18n/@types/resources.d.ts`（生成产物，须与 json 一致）
- **Approach:** 在 `files` 命名空间新增弹框相关 key（标题、「二次编辑」「插入到聊天框」「插入并运行」「发送到终端」按钮、「已插入待发送」toast）；复用已有 `insertedToComposer` / `sentToTerminal`。zh-Hans 与 en 两份对称，扁平 key + camelCase。优先跑 i18next-cli 生成 `resources.d.ts`；手动改时保持与 json 一致。
- **Patterns to follow:** `files.json` 现有 `sendToChatBtn` / `sendToTerminalBtn` / `insertedToComposer`。
- **Test scenarios:** Test expectation: none —— 纯文案资源；正确性由类型生成与 zh/en 对称约定覆盖。
- **Verification:** `pnpm typecheck` 通过，应用内中英文案显示正确。

### U5. DocDetail 在线编辑（复用 Monaco）

- **Goal:** 详情态可在线编辑该 MD 文档并保存。
- **Requirements:** R10, R11
- **Dependencies:** 无（与 U1–U4 独立）
- **Files:**
  - `packages/views/cortex-desktop/personal/TasksDocsView.tsx`（`DocDetail`）
- **Approach:** 复刻 `FilesView` 的编辑范式：`editMode`/`dirty`/`draftRef` 三态；详情头部「编辑」入口（`pw-ftb-btn` + `Icon.Edit`），编辑态显示「保存」（`is-primary` + `Icon.Check`，disabled=!dirty）与「完成」。编辑态渲染 `MonacoViewer`（`language="markdown"`、`wordWrap`、`readOnly={false}`、`key=doc.path`），`onChange` 写 `draftRef` 并按 `v!==content` 置 dirty，`onSave`（⌘S）触发保存。`save` 走 `bridge.writeFile(doc.path, draftRef.current)`，成功后 `setContent` + 清 dirty + `t("saved")` toast，失败 `t("saveFailed")`。切换文档时（readFile effect）重置 `editMode`/`dirty` 并把 `draftRef` 同步为新内容。文案复用既有 `files.toolbar.*` / `files.saved` / `files.saveFailed`。
- **Patterns to follow:** `FilesView.tsx:312-327`（save/finishEdit）、`:403-419`（编辑/保存/完成工具栏）、`:475-492`（MonacoViewer 用法）。
- **Test scenarios:** Test expectation: none —— 编辑保存依赖 Monaco 动态 import 与桌面 `bridge.writeFile`，jsdom 下不可靠（与 `FilesView` 同款编辑流程一致未做单测）；以 typecheck + 手动验证覆盖。
- **Verification:** `pnpm --filter @cortex-work/views typecheck` 通过；手动：详情「编辑」→ 改内容（出现 dirty ●）→ ⌘S/「保存」→ toast「已保存」→「完成」回到只读且内容已更新；切换文档自动退出编辑态。

---

## Acceptance Examples

- AE1. **Covers R5.** Given 详情态选中了一段文本，When 打开二次编辑并发送，Then 上下文含「路径 + 该段落」；未选中则仅路径。
- AE2. **Covers R7, R8.** Given 写好意见，When 选「插入并运行」（聊天框），Then 填入 composer 并自动提交、agent 开始执行；换终端通道时仅 bracketed paste 填入、等用户回车。
- AE3. **Covers R6, KTD4.** Given 无活跃会话或 CLI 运行中，When 选「插入到聊天框 / 插入并运行」，Then 退化为只插入并 toast 提示，不自动新建会话、不排队。

---

## Scope Boundaries

- 在线编辑用 Monaco 源码编辑（同 FilesView），不做所见即所得（WYSIWYG）富文本编辑；系统编辑器打开入口保留。
- 不向运行中的 claude/codex 进程注入文本——其 stdin 被 `ignore`（`apps/desktop/src/main/ipc/cli.ts`），只经聊天框/终端层投递。
- 不为文档新建独立 agent 会话——由现有「继续」按钮（`useContinueDoc`）覆盖。
- 终端不自动执行（不补回车），保留 bracketed paste 安全语义。

### Deferred to Follow-Up Work

- 无活跃会话时主动引导/新建会话再插入（当前继承 `FilesView` 静默丢弃行为）。
- 「插入并运行」遇 CLI 运行中的排队/重试机制。

---

## Risks & Dependencies

- **自动提交时序**（KTD2）是本计划最易出错点：若实现走旧闭包 `text` 会发错内容。U2 测试用例显式覆盖「发送内容为完整拼接文本」。
- **共享信号副作用**：`submit` 标志使自动提交成为全局能力，任何调用 `insertToComposer({submit})` 的方都会触发发送；改 store 时注意现有唯一调用方 `FilesView` 不传 `submit`，行为不回归（U1/U2 测试覆盖 `submit:false` 路径）。
- **依赖**：`usePersonalStore`（`insertToComposer` / `sendToTerminal`）、`sendContext` 工具、`ComposerShell` 发送链路（`PersonalChatArea` → `send`）。均为现有稳定接口。

---

## Sources & Research

- 现有发送机制：`packages/views/cortex-desktop/personal/FilesView.tsx:338-350`、`sendContext.ts:17-25`。
- composer 插入与发送：`ComposerShell.tsx:187-199`（send）、`:286-297`（消费 effect）、`PersonalComposer.tsx:77`（`acceptComposerInsert`）、`PersonalChatArea.tsx:455-483`（onSend → CLI、会话存在性）。
- store 信号：`packages/core/store/personal.ts:97-99/224/717-726`。
- 弹框范式：`PiToolConfirmDialog.tsx:25-66`、`AutomationDialog.tsx:48-63`、`cortex-desktop.css:5326-5361`（`pw-dlg-overlay` / `pw-confirm-dlg`）。
- i18n：`packages/core/i18n/resources/{zh-Hans,en}/files.json`、`@types/resources.d.ts`。
- 约束：CLAUDE.md（views 包边界、单文件 1200 行、zh-Hans 注释）。`docs/solutions/` 不存在，无既往学习。
