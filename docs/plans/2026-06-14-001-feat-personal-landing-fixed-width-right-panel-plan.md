---
title: "feat: 个人工作区落地页定宽内容列 + 无项目时隐藏右侧面板"
type: feat
status: completed
date: 2026-06-14
depth: standard
---

> **执行结果（2026-06-14，分支 `feat/personal-landing-layout`）**
> - U1 已落地：`.pw-landing` 定义 `--pw-landing-col: 820px`，看板/GitBar/输入框封顶居中（commit `d2d4e3c`）。
> - U2 已落地：新增 `useCloseRightPanelOnHome(homeOpen)`，进入落地页即收起右栏，附 4 例回归测试（commit `df501f9`）。
> - 质量门：views 测试 128/128 通过、views + desktop(node/web) typecheck 通过、views lint 通过。
> - **执行期决策**：Open Question 之外发现「落地页收起右栏会连带让聊天页右栏默认收起」与 R6 的张力，经用户确认采用**方案 A**（聊天页右栏默认也收起，更简单聚焦；用户手动打开后跨会话记忆，回落地页再收起）。即 R6 的「聊天右栏不变」按此口径调整。
> - 待用户手动验证：宽屏定宽居中 / 窄屏铺满、落地页无项目右栏不显示、选项目不弹出、点 Task 与顶栏开关仍可打开。

# feat: 个人工作区落地页定宽内容列 + 无项目时隐藏右侧面板

## Summary

个人工作区的「新会话 / 首页落地页」（`NewSessionLanding` + 内嵌 `HomeBoard`）目前中间内容随窗口无限拉宽，且右侧面板默认常显跨项目 Tasks。本计划做两件事：

1. 把落地页的中间内容（看板 / 项目分支条 / 输入框）改为**最大宽度封顶 + 居中**的可读列，宽屏两侧留白、窄屏自适应铺满。聊天会话页**不变**。
2. 落地页右侧面板**默认隐藏**；选中项目**不**自动弹出，仅在用户显式操作（点 Task 看详情、顶栏面板开关）时才打开。

两项改动都收敛在 `packages/views/cortex-desktop/` 的落地页表现层与 `PersonalWorkspace` 的右栏门控，不触碰会话页、终端、自动化与后端。

---

## Problem Frame

最近的「个人工作区改造」（commit `1cd2c26`）把首页与新会话合并为 `NewSessionLanding`（`homeOpen` 为真时渲染），其结构为：顶部「新会话」标签条 → 中部 `HomeBoard` 看板（热力图 / 一日总结 / 跨项目 Tasks）→ `GitBar`（项目·分支，可切项目）→ `ComposerShell` 输入框。

两个体验问题：

- **内容过宽**：`.chat`（落地页根 `main.chat.pw-landing`）为 `flex: 1`，看板与输入框横向铺满整个中间区，宽屏下阅读/操作焦点分散。
- **右栏喧宾夺主**：`rightOpen` 全局默认 `true`，落地页恒显示右侧面板（`rightView: "todos"` 跨项目 Tasks 列表）。用户希望落地页保持聚焦——无项目时不显示右栏，且选项目时也不要自动把右栏弹出来打断。

约束：聊天会话页（`PersonalChatArea`）的铺满布局与右栏行为保持现状；团队工作区（同样使用 `rightOpen`）默认行为不受影响。

---

## Requirements

- **R1** 落地页中间内容采用最大宽度封顶 + 居中的内容列：窄窗口自适应铺满，宽窗口封顶并两侧留白居中。
- **R2** 定宽仅作用于**新会话 / 首页落地页**（`.pw-landing` 范围内）；聊天会话页保持铺满，不改动。
- **R3** 落地页右侧面板默认隐藏（无项目时不显示）。
- **R4** 在落地页选中具体项目**不**自动弹出右侧面板（无自动 pop）。
- **R5** 用户显式动作仍可打开右栏：点击看板里的 Task（`requestTaskDetail` / 打开 Tasks，已 `setRightOpen(true)`）、顶栏右侧面板开关（`PersonalPanelControls`）。
- **R6** 离开落地页进入聊天会话 / 时间线 / 自动化的右栏行为不变；团队工作区右栏默认行为不变。

---

## Key Technical Decisions

### KTD1 — 宽度用 `max-width` 封顶 + `margin: 0 auto`，不用硬固定像素

采用可读列模式（封顶后居中，类似 ChatGPT/Claude 对话列）。窄于封顶值时内容自适应铺满，不出现硬固定像素带来的横向溢出/挤压。封顶值取一个常量（建议 `760px`～`820px`，执行时按视觉微调），通过 CSS 变量 `--pw-landing-col` 统一三个内层块（看板、GitBar、输入框）的列宽，保证三者左右边缘对齐。

### KTD2 — 右栏隐藏靠「进入落地页时关闭」的副作用，而非渲染期强制门控

不能简单地把渲染门控改成 `!homeOpen`，否则会连带屏蔽 R5 的显式打开（点 Task 看详情时 `homeOpen` 仍为真）。采用：**当 `homeOpen` 由假变真（含首屏挂载）时，关闭右栏（`setRightOpen(false)`）**。

- 覆盖冷启动（初始 `homeOpen: true`）、点击「新会话/首页」（`openHome()` 翻 `homeOpen` 为真）、从会话返回首页等所有进入落地页的路径。
- 选中项目不改 `homeOpen`、不触碰 `rightOpen` → 不自动弹出（满足 R4）。
- 显式动作（Task 点击 / 顶栏开关）单独把 `rightOpen` 置真，且不引起 `homeOpen` 跳变 → 副作用不复触发、面板保持打开（满足 R5）。
- 不改 `rightOpen` 全局默认（仍 `true`），团队工作区不受影响（满足 R6）。

### KTD3 — 把该副作用抽成可测的小 hook，避免整树渲染做断言

`PersonalWorkspace` 依赖 `bridge` 且挂载整棵工作区子树，直接渲染做断言成本高、易脆。把「进入落地页关闭右栏」抽成一个本地小 hook（如 `useCloseRightPanelOnHome(homeOpen)`），在 `PersonalWorkspace` 内调用；单测用一个最小探针组件驱动该 hook，验证调用契约（首挂载/转真时关闭、`homeOpen` 不变时不复关）。

> 落地页定宽为纯 CSS，无行为分支，按团队约定（实现+自动化测试归 Claude，UI 视觉由用户手动验证）该单元不写测试，验收以用户目测为准。

---

## High-Level Technical Design

落地页结构与本计划改动落点：

```text
main.chat.pw-landing                 (flex column；R2 范围边界)
├── header.pw-landing-bar            「新会话」标签条（不改）
├── div.pw-landing-board  ──┐
│     └── div.pw-home        │  R1: 三个内层块共用
├── GitBar  div.pw-gitbar  ──┤  --pw-landing-col 封顶 + 居中
└── ComposerShell           │
      div.pw-landing-composer┘
```

右栏可见性判定（`PersonalWorkspace` 内）：

```text
进入落地页 (homeOpen: false → true，含首屏)
        │
        ▼
  setRightOpen(false)          ← KTD2 副作用（唯一自动关闭点）
        │
        ├── 选中项目            → 不动 rightOpen   → 保持隐藏（R4）
        ├── 点 Task / 顶栏开关  → setRightOpen(true) → 显示（R5，homeOpen 不变，副作用不复触发）
        └── 离开落地页          → 走原有会话/时间线/自动化门控（R6）

渲染门控（沿用现状，不改判定式）：
  !automationOpen && rightOpen ? <PersonalRightPanel/> : null
```

> 以上为方向性示意，非实现规格。

---

## Implementation Units

### U1. 落地页定宽内容列（CSS）

**Goal**：让落地页看板、项目分支条、输入框共用一个封顶居中的内容列（R1、R2）。

**Requirements**：R1、R2。

**Dependencies**：无。

**Files**：
- `packages/views/cortex-desktop/cortex-desktop.css`（修改 `.pw-landing` 相关规则段，约 5156–5177 行附近）

**Approach**：
- 在 `.pw-landing` 作用域内定义列宽变量，例如 `.pw-landing { --pw-landing-col: 800px; }`（具体数值执行时按视觉微调）。
- 为三个内层块加 `max-width: var(--pw-landing-col)` 与 `margin-inline: auto`：
  - `.pw-landing .pw-home`（看板，现有 `width: 100%` + `padding: 20px 28px`，叠加封顶后窄屏仍铺满）
  - `.pw-landing .pw-gitbar`（项目·分支条）
  - `.pw-landing-composer`（输入框外壳）
- 保证三块左右内边距一致、边缘对齐；窄于封顶值时退化为自适应铺满（`max-width` 天然满足，无需媒体查询）。
- 仅在 `.pw-landing` 后代选择器内改动，**不触及** `.chat`/`.msgs`/`.composer-wrap` 等会话页通用类（守住 R2 边界）。`HomeBoard` 的 `.pw-home` 当前仅在落地页内渲染；用 `.pw-landing .pw-home` 限定，避免误伤潜在的独立 `HomeView` 复用。

**Patterns to follow**：仓库已有 `max-width + margin: 0 auto` 居中列写法（如 `.pw-tl-list`、`.pw-tl-cal` 的 `max-width: 760px; margin: 0 auto`，cortex-desktop.css:4694/4763）。沿用同一风格与命名前缀 `pw-`。

**Test scenarios**：`Test expectation: none -- 纯样式改动，无行为分支；按团队约定（见 KTD3 注）由用户手动目测验收宽屏居中/窄屏铺满。`

**Verification**：宽窗口下落地页看板与输入框封顶居中、两侧留白；缩窄窗口内容自适应铺满不溢出；聊天会话页布局无任何变化。

---

### U2. 进入落地页时关闭右侧面板（逻辑）

**Goal**：落地页右栏默认隐藏、选项目不自动弹出，但保留显式打开能力（R3、R4、R5、R6）。

**Requirements**：R3、R4、R5、R6。

**Dependencies**：无（与 U1 互不影响，可并行）。

**Files**：
- `packages/views/cortex-desktop/personal/PersonalWorkspace.tsx`（新增 hook 调用；hook 可同文件导出或拆同目录小文件）
- `packages/views/cortex-desktop/personal/PersonalWorkspace.test.tsx`（新建，测试 hook 行为）

**Approach**：
- 实现 `useCloseRightPanelOnHome(homeOpen: boolean)`：内部 `useEffect`，依赖 `[homeOpen]`，当 `homeOpen` 为真时调用 `useCortexUIStore.getState().setRightOpen(false)`（或经选择器拿到 `setRightOpen`）。依赖数组只含 `homeOpen`，确保仅在挂载与 `homeOpen` 跳变时触发，不会在 `rightOpen` 变化的重渲染里反复关闭（守住 R5）。
- 在 `PersonalWorkspace` 顶部取 `homeOpen` 后调用该 hook。其余渲染门控（`!automationOpen && rightOpen ? <PersonalRightPanel/>`）保持不变。
- 导出 hook 供测试引用。

**Execution note**：先写 hook 的失败测试锁定调用契约（含「`homeOpen` 持真期间 `rightOpen` 被显式置真后不被复关」这一回归点），再实现。

**Patterns to follow**：跨 store 读取沿用 Zustand `useXxxStore.getState()` 直取（仓库 store action 间协调已有此用法，如 `personal.ts` 内对自身 `get()` 的使用）；hook 命名与 `usePersonalCliEvents` / `useAutomationEvents` 等副作用 hook 风格一致。测试 harness 复用 `NewSessionLanding.test.tsx` 的 `CoreProvider` + 探针组件套路。

**Test scenarios**：
- Happy path：探针以 `homeOpen=true` 挂载 → `setRightOpen(false)` 被调用一次。
- 转真触发：`homeOpen` 由 `false`→`true` rerender → `setRightOpen(false)` 被调用。
- 选项目不弹出（R4 回归）：`homeOpen` 持续为真、仅其它无关 prop/state 变化导致 rerender → `setRightOpen(false)` **不**额外触发（断言调用次数不增）。
- 显式打开保持（R5 回归）：进入落地页关闭后，模拟 `setRightOpen(true)`（不改 `homeOpen`）→ hook 不复关闭（依赖未变，effect 不重跑）。
- 离开不误伤（R6）：`homeOpen` 由 `true`→`false` → 不调用 `setRightOpen`（不强制开/关，交还原有门控）。

**Verification**：冷启动落地页右栏不显示；点击「新会话/首页」进入时右栏收起；在落地页选中项目右栏仍不弹出；点击看板 Task 或顶栏面板开关可正常打开右栏；进入聊天会话后右栏行为与改动前一致；团队工作区右栏默认行为不变；`pnpm --filter @cortex-work/views test` 与 `pnpm typecheck` 通过。

---

## Scope Boundaries

**In scope**：
- 落地页（`.pw-landing` / `NewSessionLanding` + `HomeBoard`）中间内容定宽居中。
- 落地页右侧面板的默认隐藏与显式打开联动。

**Out of scope（不改动）**：
- 聊天会话页 `PersonalChatArea` 的布局与右栏行为。
- 终端面板、时间线、自动化视图。
- 团队工作区的右栏默认开关。
- `rightOpen` 全局默认值、右栏宽度拖拽（`PersonalRightPanel` resizer）逻辑。
- 后端（`server/`）、IPC、store 数据结构（不新增持久化字段）。

### Deferred to Follow-Up Work
- 若后续希望「落地页选中项目后自动展示该项目 Tasks 于右栏」，需另立需求——与本次「选项目不自动弹出」的明确决定相反，故不在本计划内。
- 定宽列封顶值是否随密度（compact/cozy）联动、是否做成用户可调，留作后续打磨。

---

## Open Questions

- **Q1（执行时定）**：`--pw-landing-col` 取值（760 / 800 / 820px 等）与是否需与现有 `composer-wrap` 横向内边距精确对齐——由 U1 执行时按视觉确定，不阻塞计划。
- **Q2**：落地页在「无项目」时用户手动点顶栏开关打开右栏，应展示什么（当前 `rightView` 默认 `todos` 跨项目列表）。默认沿用现状（显示跨项目 Tasks），如需在无项目时禁用/置灰开关另议。

---

## Risks & Dependencies

- **R-冷启动首帧闪现**：`rightOpen` 全局初始为 `true`，副作用在挂载后才把它置假，理论上存在「首帧右栏一闪」风险。缓解：effect 在挂载即同步执行；若实测有可见闪烁，可在 `PersonalWorkspace` 渲染门控里对「落地页首进未显式打开」补一层抑制，或为个人侧引入一次性抑制标记（不改团队默认）。执行时以实测为准。
- **依赖**：无新增第三方依赖；不改 store 形状与 IPC 契约，跨 Web/Desktop 边界无影响。

---

## Sources & Research

- `packages/views/cortex-desktop/personal/PersonalWorkspace.tsx` — 右栏渲染门控 `!automationOpen && rightOpen`、`homeOpen` 判定。
- `packages/views/cortex-desktop/personal/NewSessionLanding.tsx` — 落地页结构、本地 `selectedProjectId`、`hasChosen`。
- `packages/views/cortex-desktop/personal/HomeView.tsx` — `HomeBoard`，Task 点击 `requestTaskDetail` / 打开 Tasks 均 `setRightOpen(true)`（R5 显式打开来源）。
- `packages/core/store/ui.ts` — `rightOpen` 默认 `true`、`setRightOpen` / `toggleRight`（团队/个人共用，R6 边界）。
- `packages/core/store/personal.ts` — `homeOpen` 初始 `true`、`createSession`（落地页离场）、`openHome`（落地页进场）。
- `packages/views/cortex-desktop/cortex-desktop.css` — `.pw-landing` 段（5156–5177）、`.pw-home`（4939）、`.pw-gitbar`（5179+）、居中列范式 `.pw-tl-list`/`.pw-tl-cal`（4694/4763）。
- `packages/views/cortex-desktop/TitleBar.tsx` — `PersonalPanelControls` 顶栏右栏开关（R5 显式打开来源）。
- `packages/views/cortex-desktop/personal/NewSessionLanding.test.tsx` — 测试 harness（`CoreProvider` + `fakeBridge`）参照。
