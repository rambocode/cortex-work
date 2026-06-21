---
date: 2026-06-21
topic: tasks-doc-secondary-edit-send
---

# Tasks 文档二次编辑并发送到 Agent — 需求

## Summary

在 tasks 文档详情态新增「二次编辑」入口：弹出对话框让用户手写调整意见，把「文档路径引用 + 选中段落 + 意见」拼成上下文，复用文件管理现有的发送机制，送进当前会话的聊天框或终端。聊天框通道额外支持「插入并运行」（自动提交），终端通道只插入。

---

## Problem Frame

`TasksDocsView` 的文档详情态（`packages/views/cortex-desktop/personal/TasksDocsView.tsx` 的 `DocDetail`）目前是**只读** Markdown 渲染，对一份文档用户只有两条路：点卡片上的「继续」按钮（`useContinueDoc` 走固定 system prompt 为文档新建会话），或用系统编辑器外部打开手改。

缺的是中间档：用户读到文档某一段、想就这段给 agent 一个**自定义指令**（「这里改成 X」「按这个思路展开」），却没有应用内入口把「文档上下文 + 我的话」一次性递给正在用的 claude/codex。当前只能手动复制粘贴，或接受「继续」的固定提示词后再补充。文件管理（`FilesView`）已经为「文件选区 → 聊天框/终端」做了这件事，tasks 文档却没有。

---

## Key Decisions

- **复用文件管理的发送机制，不为文档新建会话。** 走 `usePersonalStore` 的 `insertToComposer` / `sendToTerminal`（即 `FilesView` 在用的同一套），目标是**当前活跃会话或终端**。「为文档新建独立会话」由现有「继续」按钮覆盖，本功能不重复。
- **自动运行只覆盖聊天框。** 聊天框可在填入后自动提交；终端保持「只插入」（bracketed paste），不补回车——避免破坏 bracketed paste「防止多行被 shell/TUI 逐行执行」的安全语义。
- **上下文用「路径引用 + 选中段落」，不嵌全文。** 与 `continueDoc`、`FilesView` 一致，让 claude/codex 自行读文件，prompt 短且不依赖把整份文档塞进去。

---

## Key Flows

- F1. 二次编辑 → 发送
  - **Trigger:** 用户在 tasks 文档详情态点「二次编辑」。
  - **Steps:** 打开对话框 → 对话框展示将携带的上下文（文档路径 + 选中段落，若有）→ 用户在文本框写调整意见 → 选择动作（插入到聊天框 / 插入并运行 / 插入到终端）。
  - **Outcome:** 拼好的「上下文 + 意见」按所选通道投递；聊天框「插入并运行」时自动提交，其余只填入；toast 反馈并关闭对话框。
  - **Covered by:** R1, R2, R3, R4, R6, R7, R8, R9

---

## Requirements

**入口与对话框**

- R1. tasks 文档详情态（`DocDetail`）新增「二次编辑」入口，点击打开对话框。
- R2. 对话框含一个多行文本输入框，供用户手写调整意见。
- R3. 对话框可见地展示本次将随意见一起发送的上下文（文档路径引用，及选中段落——若有）。

**上下文拼装**

- R4. 发送内容由「文档路径引用 + 选中段落（可选）+ 用户意见」拼成，复用 `buildContextSnippet`（`packages/views/cortex-desktop/personal/sendContext.ts`）。
- R5. 详情态支持选中文档中的一段文本作为上下文段落；无选区时仅带路径引用。

**发送通道与动作**

- R6. 对话框提供「插入到聊天框」与「插入到终端」两个通道，分别复用 `insertToComposer` 与 `sendToTerminal`（终端走 `wrapBracketedPaste`）。
- R7. 聊天框通道额外提供「插入并运行」动作：填入 composer 后自动提交，无需用户再回车。
- R8. 终端通道仅「插入」，不自动执行（不在 bracketed paste 后补回车）。
- R9. 发送后给出 toast 反馈并关闭对话框。

---

## Acceptance Examples

- AE1. **Covers R5.**
  - **Given:** 用户在详情态选中了文档中的一段文本。
  - **When:** 打开二次编辑并发送。
  - **Then:** 上下文含「路径引用 + 该选中段落」；若未选中任何文本，则上下文仅含路径引用。

- AE2. **Covers R7, R8.**
  - **Given:** 用户写好意见。
  - **When:** 选「插入并运行」（聊天框）。
  - **Then:** 内容填入 composer 并自动提交、agent 开始执行。换作终端通道时，内容仅以 bracketed paste 填入终端，等待用户自行回车。

- AE3. **Covers R6.**
  - **Given:** 当前没有活跃会话（聊天 composer 未挂载）。
  - **When:** 用户选「插入到聊天框」。
  - **Then:** 行为与 `FilesView` 现状一致（插入信号无人消费会丢失）——除非在 Outstanding Questions 中决定加引导。

---

## Scope Boundaries

- 不在详情态做内联富文本/源文档改写——修改源文档仍走「用系统编辑器打开」。
- 不向运行中的 claude/codex 进程注入文本——架构上其 stdin 被 `ignore`（`apps/desktop/src/main/ipc/cli.ts`），只能经聊天框/终端这层投递。
- 不为文档新建独立 agent 会话——由现有「继续」按钮（`useContinueDoc`）覆盖。

---

## Dependencies / Assumptions

- 依赖 `usePersonalStore` 的 `insertToComposer`（设置 `composerInsert` nonce，`ComposerShell` 在 `acceptComposerInsert` 时消费）与 `sendToTerminal`（设置 `pendingTerminalText` 并唤起终端）。
- 假设：聊天框插入要求当前有活跃会话——`PersonalComposer` 仅在存在 `session` 时挂载并带 `acceptComposerInsert`；无会话时插入信号无人消费而丢失。此为继承自 `FilesView` 的现有行为。
- 假设：详情态当前用 `MarkdownView` 渲染（只读），选中得到的是**渲染后文本**而非源 markdown；作为发给 agent 的上下文段落可接受。

---

## Outstanding Questions

**Deferred to Planning**

- 「插入并运行」的自动提交如何实现：复用 `composerInsert` 信号并加一个 `submit` 标志，还是新增独立 store 信号。
- 选中段落如何取得：对 `MarkdownView` 渲染结果用 `getSelection`，还是改为从源码取对应段落。
- 无活跃会话时是否需要提示/引导（沿用 `FilesView` 现状静默丢弃，还是加一条 toast 提醒先开会话）。
