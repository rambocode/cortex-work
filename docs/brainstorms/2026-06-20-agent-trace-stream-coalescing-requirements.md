---
date: 2026-06-20
topic: agent-trace-stream-coalescing
---

# Agent 调试跟踪：流式增量合并为完整段

## Summary

在 agent 调试跟踪（dev-only 的 `agent-trace` 子系统）的**记录端**把流式增量合并成完整段：连续的 text 增量累积成一条完整 text 跟踪、连续的 reasoning 增量累积成一条完整 reasoning 跟踪，遇到不同类型事件即收尾。合并段在流式期间实时生长为同一条，点开即可看到当前累积的完整内容。

---

## Problem Frame

当前主进程对 `adapter.parseLine` / `PiSessionEvent` 解析出的**每一个增量**都记一条独立 trace（`cli.ts:351`、`pi-session.ts:35`）。pi 流式输出会吐出成百上千个 text / reasoning 增量，于是调试面板被一面「pi text」墙刷满——同一秒内几十条几乎一样的行，看不出任何有效信息，要逐条点开才能拼出完整输出，跟踪极其困难。

这还带来一个不易察觉但更要命的副作用：`recordAgentTrace` 的环形缓冲上限只有 500 条（`agent-trace.ts:25`）。一轮稍长的流式输出就能把缓冲灌满，导致同会话内其它阶段（start / tool / stderr / exit 等）的关键 trace 被挤出淘汰——恰恰是调试时最需要的上下文丢失了。

---

## Key Decisions

- **在记录端合并，不在面板端分组。** 合并逻辑收敛到 `recordAgentTrace` 一个点，环形缓冲里存的是「段」而非「增量」。这同时根治视觉刷屏与缓冲被挤爆两个问题；面板端分组只能治视觉、缓冲隐患仍在，故排除。
- **text 与 reasoning 各自独立成段。** 二者不合并进同一条，调试时推理过程与正文正文可分开查看。reasoning 在 pi-rpc 路径已有产出（`pi-rpc.ts:57`，`thinking_delta` → `reasoning`），本次让它和 text 一样被合并展示。
- **合并段在流式期间实时生长。** 同一条原地追加内容、不新增行；段收尾后定格为完整内容。既能看到流式进度又不刷屏。
- **本次只覆盖 pi-rpc 路径的 reasoning。** 归一化的 `CliStreamEvent`（`types.ts:311`）不含 reasoning，`pi.ts` 的 `parseLine` 丢弃 thinking_delta；是否给 claude/codex/oneshot 非 RPC 路径补 reasoning 留待后续，不在本次范围。

---

## Requirements

**合并行为**

- R1. 连续的同类型流式增量（text 或 reasoning）累积成**一条**跟踪，其内容为该段全部增量按序拼接的完整文本。
- R2. 段的边界由类型变化或一轮结束界定：当前段为 text/reasoning 时，遇到不同类型事件（工具调用、result、turn-end 等）或一轮/一次 run 结束即收尾；之后再次出现 text/reasoning 时另起新段。
- R3. 合并按 run/session + 段类型归属，确保并发或多 run 场景下增量不串到错误的段上。
- R4. 段在流式期间实时生长：每个新增量到达时更新**同一条**跟踪而非新增条目；段收尾后该条定格为完整内容。

**展示**

- R5. 面板将合并段渲染为一行，行内可见段类型（如 `[TEXT]` / `[REASONING]`）；展开后显示该段当前/最终的完整累积内容。
- R6. text 段与 reasoning 段在面板中是各自独立的条目，不合并显示。
- R7. 非流式事件（start / tool / stderr / error / exit 等）维持现有的「一事件一条」行为，不受合并影响。

**缓冲**

- R8. 合并后，一轮流式输出在环形缓冲（上限 500）中占用的条目数与增量数无关、仅与段数相关，使同会话其它阶段的 trace 不再因流式增量灌满而被淘汰。

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** 某轮先产 reasoning 再产 text：pi 吐出 48 个 reasoning 增量、随后 31 个 text 增量。**结果：** 跟踪面板新增 1 条 reasoning（实时生长至完整 1.2k 字）+ 1 条 text（实时生长至完整 860 字），而非 79 条。
- AE2. **Covers R2.** 一轮中出现 `reasoning → 工具调用 → 继续 text`。**结果：** 产出 3 条——reasoning（完整）、tool（原样一条）、text（完整）；中间的工具调用使前一段 reasoning 收尾，工具之后的 text 另起新段。
- AE3. **Covers R3.** 两个 run 的流式增量在同一时间窗交错到达。**结果：** 各自合并到归属自己 run 的段上，内容不交叉污染。
- AE4. **Covers R8.** 一轮产生 2000 个增量、共 2 段（reasoning + text）。**结果：** 环形缓冲为此轮仅新增 2 条；该轮的 start / exit 等其它阶段 trace 仍保留在缓冲内可见。

---

## Scope Boundaries

- 给非 RPC 归一化路径（claude / codex / oneshot，对应 `CliStreamEvent`）补 reasoning 捕获——延后，不在本次。
- 跟踪的导出 / 复制整段完整内容功能——延后。
- 增量级时序的可视化（查看每个增量到达时刻）——非目标；合并后该信息不再单独保留。

---

## Sources / Research

- `apps/desktop/src/main/ipc/agent-trace.ts` — `recordAgentTrace` 记录端 + 500 条环形缓冲（`MAX_EVENTS`）+ IPC 广播；当前 append-only，需要新增「更新同一条」的通道。
- `apps/desktop/src/main/ipc/cli.ts:351` — 流式路径对每个解析出的 `CliStreamEvent` 记一条 trace（刷屏来源之一）。
- `apps/desktop/src/main/ipc/pi-session.ts:35` — pi-rpc 路径对每个 `PiSessionEvent`（含 reasoning 增量）记一条 trace（截图所示路径）。
- `apps/desktop/src/main/agents/pi-rpc.ts:57` — `thinking_delta` → `reasoning` 增量的来源。
- `apps/desktop/src/main/ipc/types.ts:311`、`:389` — `CliStreamEvent`（无 reasoning）与 `PiSessionEvent`（有 `reasoning` 增量）两套事件联合类型。
- `packages/views/cortex-desktop/personal/AgentTracePanel.tsx` — 面板渲染，当前一事件一 `<li>`、无合并；需支持按 id upsert 与实时生长。
