---
date: 2026-06-24
topic: chat-document-attachments
---

# 聊天文档附件与 agent 工具处理 — 需求

## Summary

在两个聊天表面（Agent CLI 会话、团队/个人消息）支持发送 PDF / Word / Excel / PPT 等文档附件。文档内容由一个 MCP 文档抽取工具按需提供给 agent，让 agent 调用工具读取并理解。v1 目标是"读懂"——把文档内容用于问答、总结、分析与参考写作；图片附件复用已完成的链路。

## Problem Frame

当前 composer 的图片附件已端到端打通（粘贴/拖拽/选择 → 三个 agent 各自的投递路径），但文档类附件没有可用通路。`.md`/`.txt` 拖拽虽能走 `readFile`，却是 UTF-8 / 2MB 截断读取——PDF、Office 这类二进制丢进去只会变成乱码并白白消耗 token，代码里已明确标注这类文件"不可拖"。

三个 agent（claude / codex / pi）都没有原生读取 PDF/Office 的能力，仓库里也没有任何抽取库。结果是：用户手里最常见的工作文档（合同 PDF、数据 Excel、汇报 PPT、文案 Word）根本进不了对话，agent 无法基于它们工作。这是把 agent 接入真实办公场景的一道明显缺口。

## Key Decisions

- **MCP 抽取工具优先于宿主侧打包抽取库。** 把 pdf/office 抽取库直接打进主运行时会让安装包与主进程持续膨胀；改为以 MCP 工具形态由 agent 按需调用，可独立扩展、不污染主进程。pi 核心无原生 MCP，但 cortex 已有桥接扩展机制（浏览器控制同款），抽取工具据此覆盖三端。

- **v1 只做"读懂"。** 抽取文本（必要时含表格的纯文本）供 agent 理解；保真排版（表格结构 / 图表 / PPT 页面语义）与产出/修改新文件（填表、生成 Word/PPT、格式转换、OCR）留二期。抽取层预留可复用接口。

- **内置独立进程交付，而非按需拉起或插件市场。** 换取即开即用 + 离线可用，代价是接受安装包体积增长；进程隔离让抽取库不进主进程运行时。

- **图片走现有链路，文档走新链路。** 图片端到端已完成（per-agent 投递），不重做；文档新增承载字段与抽取工具路径。

- **"agent 处理"只在有 agent 参与时发生。** IM 人对人场景下，文档仅作普通聊天附件存储与展示，不触发抽取。

## Actors

- A1. 用户 — 在 composer 选择/拖拽/粘贴文档附件并发送。
- A2. Agent（claude / codex / pi）— 调用文档抽取工具读取内容，据此问答/总结/分析。
- A3. 文档抽取进程/工具 — 随包内置的独立进程，以 MCP 工具暴露，把二进制文档按需转为文本/结构化内容。
- A4. IM 接收方 — 可能是人，也可能是 bot/agent；决定是否触发抽取。

## Requirements

**附件输入（Composer）**

- R1. Composer 支持选择、拖拽、粘贴以下文档附件，与现有图片附件并列：PDF、现代 Office（.docx / .xlsx / .pptx）、纯文本类（.csv / .txt / .md）。旧二进制格式（.doc / .xls / .ppt）不支持。
- R2. 所有文档附件（含纯文本类）统一走新的附件链路，以原始文件形态落盘到 agent 可访问位置，不再使用旧的 UTF-8 `readFile`（2MB 截断）通道。
- R3. `Message` 类型新增 `files?` 字段承载文档附件引用，区别于现有 `images?`。
- R4. 发送前可见已选文档列表并可移除，支持多文件。
- R14. 单文件设适中大小上限（量级约 50MB，确切阈值留 ce-plan），超限时发送被拒绝并给出提示，不做静默截断。

**投递与 agent 抽取**

- R5. 文档内容由抽取工具按需提供给 agent（agent 调用工具读取），而非发送时全量注入上下文。
- R6. 抽取能力以 MCP 工具形态暴露，覆盖 claude、codex、pi；pi 经现有 MCP 桥接扩展机制接入。
- R7. v1 抽取产出为文本（必要时含表格的纯文本），供问答/总结/分析/参考；不要求保真排版。
- R8. 图片附件复用现有 per-agent 图片投递链路，不纳入文档抽取工具。

**两个表面的行为**

- R9. Agent CLI 会话：文档附件落盘后，当前 agent 可经抽取工具读取其内容。
- R10. 团队/个人消息发给 bot/agent：行为与 Agent CLI 会话一致，抽取工具对该 agent 可用。
- R11. 团队/个人消息发给人：文档作为普通聊天附件，不触发抽取；v1 不保证跨端共享（接收方在另一设备获取文档留二期）。

**体积与交付**

- R12. 文档抽取以随包内置的独立进程提供，即开即用、离线可用；抽取库不加载进主进程运行时。
- R13. 抽取层与工具接口设计为可被二期复用（处理/转换、产出新文件）。

## Key Flows

- F1. Agent CLI 会话发送文档
  - **Trigger:** 用户在 Agent CLI 会话 composer 选择一个 PDF/Office 文档并发送。
  - **Actors:** A1, A2, A3
  - **Steps:** 文档落盘到 agent 可达位置 → 抽取 MCP 工具对当前 agent 可用 → agent 按需调用工具读取文本 → 据此回答/总结。
  - **Covered by:** R1, R2, R5, R6, R9

- F2. IM 发给 bot/agent
  - **Trigger:** 用户在团队/个人消息中向一个 bot/agent 发送文档附件。
  - **Actors:** A1, A2, A3, A4
  - **Steps:** 同 F1，文档对该 agent 经抽取工具可读。
  - **Covered by:** R10

- F3. IM 发给人
  - **Trigger:** 用户在团队/个人消息中向另一个人发送文档附件。
  - **Actors:** A1, A4
  - **Steps:** 文档作为普通聊天附件存储与展示，对方查看/下载；不触发任何抽取。
  - **Covered by:** R11

## Acceptance Examples

- AE1. **Covers R5, R9.** **Given** 用户在 Agent CLI 会话发送一个多页 PDF，**When** agent 需要其中内容回答问题，**Then** agent 通过抽取工具读取文本（按需，而非发送时全量注入），并基于内容作答。

- AE2. **Covers R6.** **Given** 当前 agent 是 pi，**When** 会话开启，**Then** 文档抽取工具经 pi 桥接扩展注入，pi 可像 claude/codex 一样调用它。

- AE3. **Covers R11.** **Given** 用户在团队消息中把一个 Excel 发给同事（人），**When** 消息送达，**Then** 该文件以普通附件呈现可下载，系统不进行任何抽取。

- AE4. **Covers R8.** **Given** 用户同时附带一张图片和一个 Word 文档，**When** 发送，**Then** 图片走现有图片投递链路、文档走抽取工具路径，两者互不混用。

## Scope Boundaries

**Deferred for later（二期，接口预留）**

- 高保真抽取：保留表格结构、图表、PPT 页面语义。
- 产出/修改新文件：填 Excel、生成 Word/PPT、格式转换、OCR。
- 基于文件的复杂任务编排（"按这个表生成报表"等）超出"读懂"的部分。
- 人对人文档附件的后端共享存储与跨端下载；v1 仅保证 agent 路径（Agent CLI + IM 发给 bot/agent）。

**本期不做（已比较后排除）**

- 宿主侧打包抽取库直接注入上下文（方案 A）：体积膨胀，否决。
- 按需拉起（npx/下载）或插件市场交付抽取能力：与"即开即用 + 离线"取向冲突，本期选内置独立进程。

## Dependencies / Assumptions

- 依赖现有 MCP 注入机制：claude 写 `.mcp.json`、codex 走 `-c` 参数、pi 经桥接扩展（`McpServerConfig` → bridge）。三者均已存在。
- 假设落盘位置对 agent 工作目录可达；具体路径与沙箱策略由 ce-plan 决定。
- 假设内置独立进程模型（utilityProcess vs child_process）由 ce-plan 选定——注意现有 agent 实际均以 `child_process.spawn` 启动，CLAUDE.md 中"pi 经 utilityProcess.fork"的描述与当前代码不符。

## Outstanding Questions

**Deferred to Planning**

- 抽取工具的协议与参数形状（按文件路径 / 按附件 id），以及返回内容的分页/分块策略。
- 落盘路径与沙箱策略，抽取进程的进程模型与生命周期。
- 安全：不可信文档抽取的进程隔离与资源（内存/时长）限制。

## Sources / Research

- 图片附件与拖拽链路：`packages/views/cortex-desktop/personal/ComposerShell.tsx`（`onSend`/`PendingImage`；拖入走 `bridge.readFile` 约 494 行）
- 消息类型：`packages/core/types/index.ts:99`（text 变体有 `images?`，无 `files?`）
- `readFile` 截断：`apps/desktop/src/main/ipc/fs.ts:25,458`（2MB / UTF-8）
- 非文本不可拖的现状说明：`packages/views/cortex-desktop/personal/FilesView.tsx:65`
- MCP 配置类型与注入：`apps/desktop/src/main/ipc/types.ts:161`、`apps/desktop/src/main/ipc/cli.ts:437`
- 各适配器 MCP 注入方式：`apps/desktop/src/main/agents/claude.ts:68`、`codex.ts:70`、`pi.ts:56`
- pi MCP 桥接（覆盖 pi 的关键）：`apps/desktop/src/main/agents/pi-mcp-bridge.ts`、`apps/desktop/src/main/ipc/pi-session.ts:166`
- 浏览器控制走同款桥接（pi 支持 MCP 的实证）：`pi-session.ts:172`（`buildBrowserMcpServerConfig` → `collectBridgeServers`）
