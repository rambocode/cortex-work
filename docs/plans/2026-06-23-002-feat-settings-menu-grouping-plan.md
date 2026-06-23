---
title: "feat: 设置页菜单分组 + 应用/浏览器分区重组 + 左栏固定宽 300px"
date: 2026-06-23
type: feat
status: ready
depth: standard
---

# feat: 设置页菜单分组 + 应用/浏览器分区重组 + 左栏固定宽 300px

## Summary

把个人工作区整页设置（`PersonalSettingsView`）的左栏从**扁平 10 项**改造为**带分组表头的 5 组结构**，左栏宽度由 `164px` 固定为 `300px`。新增「应用」分组，组下并列两个菜单项：**插件**（沿用现有插件管理器）和**浏览器**（把当前深埋在「插件 → 管理页 → MCP 子标签」里的内置浏览器设置 `BrowserControlSection` 提取为独立顶层分区）。其余 8 个现有项按既定 5 组方案归类，不改各分区自身内容。

纯前端 UI 重组，零后端、零 IPC 契约改动；唯一的功能性位移是 `BrowserControlSection` 的归属从 MCP 子标签搬到「应用 → 浏览器」分区。

---

## Problem Frame

当前设置左栏（`SettingsMenu.tsx` 的 `TABS` 数组 + `PersonalSettingsView`）是 10 个 `pw-dlg-nav-item` 的扁平堆叠，随分区增多已缺乏归类、扫描成本上升。同时「内置浏览器设置」（`BrowserControlSection`，即「允许 agent 控制内置浏览器」开关）目前位于 `PluginManagePage.tsx:141` 的 MCP 子标签内，入口路径深（设置 → 插件 → 管理 → MCP），与「浏览器」这一独立心智模型不匹配，用户难以发现。

目标：
1. 左栏实现**分组**（带组标题），按 5 组方案归类 11 个项。
2. 左栏宽度固定 **300px**。
3. 新增「应用」组，组下并列「插件」「浏览器」两项；把内置浏览器设置提升为「浏览器」顶层分区。

> 说明：本计划据用户文字描述 + 两项交互确认编写。原始 [Image #11]（分组示意）、[Image #12]（宽度示意）未随会话传入，分组方案与「应用」组结构均已由用户在规划期显式确认（见下「Key Technical Decisions」）。

---

## Requirements

- **R1** 设置左栏渲染为分组结构：每组一个组标题 + 组内若干菜单项；当前选中项高亮逻辑不变。
- **R2** 左栏宽度固定为 `300px`（覆盖现有 `164px`）。
- **R3** 5 组方案（用户确认）：
  - **通用**：个人资料、通用
  - **模型与 Agent**：供应商、Agent、Pi
  - **应用**：插件、浏览器
  - **个性化**：宠物、语音
  - **自动化**：时间线、推送
- **R4** 「应用」组下两个并列菜单项：**插件**（id `plugins`，沿用现 `<PluginManager />`）与**浏览器**（id `browser`，新增分区，渲染 `BrowserControlSection`）。
- **R5** `BrowserControlSection` 从 `PluginManagePage.tsx` 的 MCP 子标签移除，唯一归宿为「应用 → 浏览器」分区（不双处渲染）。
- **R6** 所有菜单项文案与组标题走 i18n（`settings:tabs.*`），中英文同步。
- **R7** 既有分区自身内容、选中态同步、ESC 返回、焦点管理等行为零回归。

---

## High-Level Technical Design

左栏由「扁平项数组」升级为「分组 → 项」两层数据模型，渲染时每组先出组标题（复用 CSS 中已存在但未启用的 `.pw-dlg-nav-h`），再出组内项。

改造前 → 改造后导航结构：

```text
改造前（扁平 10 项）                改造后（5 组 / 11 项）
─────────────────                 ─────────────────────────
个人资料                           ▸ 通用
通用                                  个人资料
供应商                                通用
Agent                              ▸ 模型与 Agent
Pi                                    供应商
插件 ────┐                            Agent
宠物     │ 内置浏览器设置              Pi
时间线   │ 埋在 插件→管理→MCP       ▸ 应用
推送     │                            插件          （= 原 plugins，PluginManager 不变）
语音     │                            浏览器  ★新   （= 提取出的 BrowserControlSection）
         └────────────────►       ▸ 个性化
                                      宠物
                                      语音
                                   ▸ 自动化
                                      时间线
                                      推送
```

数据模型（方向性示意，非实现规范）：

```text
type SettingsTab = "...existing..." | "browser";   // 并集新增 browser
type NavGroup = { groupKey: string; items: SettingsTab[] };
const NAV_GROUPS: NavGroup[] = [ general, models, apps, personalization, automation ];
// 单一 TAB_META: Record<SettingsTab, { tabKey; icon }> 仍是项元数据唯一来源，
// 分组只描述「哪些项归哪组 + 顺序」，避免图标/文案双写漂移。
```

渲染时遍历 `NAV_GROUPS` → 输出 `.pw-dlg-nav-h` 组标题 + 组内项（项渲染逻辑、`is-active`/`aria-current` 与现状一致）。`tab` 状态机与 `setTab` 不变；分区右栏 switch 新增 `browser` 分支。

---

## Key Technical Decisions

- **KTD1 — 「应用」组采用两并列项（插件 + 浏览器），而非单「浏览器」项内含两块。** 用户规划期确认。插件管理与浏览器控制是两个独立心智模型，并列项比塞进一个页面更清晰，也最贴合「应用 = 可扩展能力集合」的归类。
- **KTD2 — 5 组方案按用户确认采用**（见 R3）。组划分依据：账户/外观（通用）、推理能力来源（模型与 Agent）、可扩展应用（应用）、个人偏好（个性化）、后台流程（自动化）。
- **KTD3 — 分组只新增「分组→项映射」层，项元数据（icon + i18n key）保持单一来源。** 现 `TABS` 数组同时承载顺序与元数据；重构为 `TAB_META`（项元数据）+ `NAV_GROUPS`（分组与顺序）两层，杜绝图标/文案在多处重复定义导致漂移（遵循 CLAUDE.md「能复用不新造」）。
- **KTD4 — `BrowserControlSection` 物理移动，不复制。** 从 `PluginManagePage` MCP 子标签删除（含 import），仅在新「浏览器」分区渲染。避免双数据源式的「同一开关两处入口」。
- **KTD5 — 复用既有 `.pw-dlg-nav-h` 样式承载组标题。** CSS 中该类已定义（`cortex-desktop.css:5978`，font-weight 700）但当前无引用，正是为分组表头预留，直接复用而非新造样式。
- **KTD6 — 宽度 300px 写在 `.pw-settings-page .pw-dlg-nav` 作用域覆盖**，与现有 `164px` 覆盖同处（`cortex-desktop.css:6100`），保持「设置页专属、不影响其它复用 `.pw-dlg-nav` 的弹窗」的既定作用域约定。

---

## Implementation Units

### U1. i18n：分组标签 + 「浏览器」项文案

**Goal** 为 5 个组标题与新增「浏览器」菜单项补齐中英文案与类型定义，作为后续 UI 单元的文案来源。

**Requirements** R3, R6

**Dependencies** 无

**Files**
- `packages/core/i18n/resources/zh-Hans/settings.json`（在 `tabs` 段增 `browser`；新增 `tabGroups` 段：`general` / `models` / `apps` / `personalization` / `automation`）
- `packages/core/i18n/resources/en/settings.json`（同步英文）
- `packages/core/i18n/@types/resources.d.ts`（typed i18n 资源，`tabs` 块在 :911 附近，按现有结构补 `browser` 与 `tabGroups`）

**Approach**
- `tabs.browser` = `浏览器` / `Browser`。
- 新增 `tabGroups.{general,models,apps,personalization,automation}`，文案：通用 / 模型与 Agent / 应用 / 个性化 / 自动化（英文：General / Models & Agents / Apps / Personalization / Automation）。
- `resources.d.ts` 若由脚本生成则按生成方式更新；若手维护则镜像 json 结构补键。实现期先确认该文件是否手维护（typecheck 会暴露缺键）。

**Patterns to follow** 现有 `tabs.*` 扁平键风格；`settings.json` 既有分段（`profile` / `general` 等）。

**Test scenarios**
- `packages/core/i18n/index.test.ts` 增断言：`getResource("zh-Hans","settings","tabs.browser")` === `浏览器`；`tabGroups.apps` === `应用`。
- Covers R6. 英文侧可加一条 `tabs.browser` === `Browser` 对称断言。

**Verification** `pnpm --filter @cortex-work/core test` 通过；`pnpm --filter @cortex-work/core typecheck` 无缺键报错。

---

### U2. SettingsMenu：分组数据模型 + 导航分组渲染

**Goal** 把扁平 `TABS` 重构为 `TAB_META` + `NAV_GROUPS` 两层，`PersonalSettingsView` 的 `<nav>` 按组渲染（组标题 + 组内项）。

**Requirements** R1, R3, R7

**Dependencies** U1

**Files**
- `packages/views/cortex-desktop/personal/SettingsMenu.tsx`

**Approach**
- `SettingsTab` 并集新增 `"browser"`（右栏分支在 U3 落地，本单元先纳入类型与分组占位）。
- 现 `TABS: {id,tabKey,icon}[]` → 拆为 `TAB_META: Record<SettingsTab,{tabKey;icon}>`（含 `browser` 的 icon，建议 `Icon.Globe` 或 `Icon.Compass`，与 providers 的 Globe 区分则用 Compass/Window 类）+ `NAV_GROUPS: {groupKey; items: SettingsTab[]}[]` 按 R3 顺序。
- `<nav>` 渲染：保留顶部「返回应用」按钮；其后 `NAV_GROUPS.map` → 每组先渲染 `<div className="pw-dlg-nav-h">{t(group.groupKey)}</div>`，再 `group.items.map` 渲染现有 `.pw-dlg-nav-item` 按钮（`is-active`/`aria-current`/`onClick={()=>setTab(id)}` 逻辑原样）。
- 不改 `tab` 状态、`setTab`、ESC/焦点等逻辑。

**Patterns to follow** 现 `PersonalSettingsView` nav map（`SettingsMenu.tsx:2008-2018`）；`pw-dlg-nav-item` className 拼接现状。

**Test scenarios**
- 渲染设置页：断言出现 5 个组标题文本（通用/模型与 Agent/应用/个性化/自动化）。
- 断言「应用」组下「插件」「浏览器」两个 nav 按钮均存在。
- 点击「通用」项 → 右栏切到 GeneralSection，`is-active` 落到该项（沿用现有 `Covers R4` 断言风格）。
- 既有「点击侧栏设置入口打开整页」「ESC 返回」「默认个人资料分区」用例保持绿（回归守卫，R7）。

**Verification** `pnpm --filter @cortex-work/views test -- run packages/views/cortex-desktop/personal/SettingsMenu.test.tsx` 通过；手测左栏出现分组表头。

---

### U3. 「浏览器」分区落地 + 从 MCP 子标签移除 BrowserControlSection

**Goal** 新「浏览器」分区在右栏渲染内置浏览器设置；同时从插件管理页 MCP 子标签移除该区，确保唯一归宿。

**Requirements** R4, R5, R7

**Dependencies** U2

**Files**
- `packages/views/cortex-desktop/personal/SettingsMenu.tsx`（新增 `BrowserSection` 包装 + 右栏 switch 增 `browser` 分支）
- `packages/views/cortex-desktop/personal/PluginManagePage.tsx`（删除 `<BrowserControlSection />` 调用 + 顶部 import）

**Approach**
- 在 `SettingsMenu.tsx` 增轻量 `BrowserSection`：渲染 `pw-dlg-title`/`pw-dlg-desc`（文案走 `settings:browser.*` 或复用 `tabs.browser` + 一句 desc，新增 i18n 键时回填 U1 风格）+ `<BrowserControlSection />`，与其它 Section（如 `AgentSection`）的标题/描述结构对齐。`import { BrowserControlSection } from "./BrowserControlSection";` 加到 SettingsMenu 顶部。
- 右栏 switch（`SettingsMenu.tsx:2022-2042`）的 `plugins` 分支旁增 `tab === "browser" ? <BrowserSection /> :`。
- `PluginManagePage.tsx`：删除 `:141` 的 `<BrowserControlSection />` 与 `:13` 的 import；MCP 子标签保留 `McpCard` + pi 扩展提示 + `ExtensionPanel`（其余不动）。

**Patterns to follow** 现 `AgentSection`（标题 + 描述 + 卡片）；`PersonalSettingsView` 右栏三元 switch。

**Test scenarios**
- 点击「浏览器」nav 项 → 右栏渲染 `BrowserControlSection`（断言「允许 agent 控制内置浏览器」开关在场）。Covers R4。
- 进入插件管理 → 管理页 → MCP 子标签：断言不再出现「允许 agent 控制内置浏览器」开关（`PluginManager.test.tsx` 增/改一条，守 R5 不双处渲染）。
- 浏览器分区开关点击 → 行为与原 MCP 子标签内一致（toggle 写入对应 store/bridge，沿用 `BrowserControlSection.test.tsx` 既有断言，不重复实现）。

**Verification** 两处测试文件通过；手测「浏览器」分区开关可用、MCP 子标签已无该开关。

---

### U4. CSS：左栏固定宽 300px + 分组表头视觉

**Goal** 左栏宽度固定 300px；组标题在分组列表中有恰当的间距与层级感。

**Requirements** R2, R1

**Dependencies** U2（依赖 `.pw-dlg-nav-h` 已被实际渲染）

**Files**
- `packages/views/cortex-desktop/cortex-desktop.css`

**Approach**
- 把 `.pw-settings-page .pw-dlg-nav { width: 164px; }`（`:6100`）改为 `width: 300px;`。
- 微调 `.pw-dlg-nav-h`（`:5978`）：当前 padding `0 8px 10px`，分组场景需在非首个组上方留间距（如 `padding-top` 或对非首组加 `margin-top`），并确保字号/色阶（`--text-3` 大写小标题 vs 现 `--text-1`）符合「组标题」而非「页标题」观感。可参考 `.pw-dlg-body .twk-sect`（`:6022`，10px/大写/letter-spacing/`--text-3`）的小节标题风格做收敛。
- macOS 让位规则（`:6069` padding-top:40px）与 300px 宽度正交，无需改动。

**Patterns to follow** `.twk-sect` 小节标题样式；现有 `.pw-settings-page` 作用域覆盖约定。

**Test scenarios** Test expectation: none — 纯样式改动，无行为断言；以手测/视觉走查验证（300px 宽、组标题层级清晰、深浅两色均可读）。

**Verification** 手测左栏宽 300px；分组表头与项视觉层级分明；深色/浅色模式均不糊。

---

### U5. 测试与类型收口

**Goal** 汇总回归守卫，确保全仓 typecheck/test/lint 绿。

**Requirements** R7

**Dependencies** U1, U2, U3, U4

**Files**
- `packages/views/cortex-desktop/personal/SettingsMenu.test.tsx`（分组渲染 + 浏览器分区，部分在 U2/U3 已加，此处补全边界）
- `packages/views/cortex-desktop/personal/PluginManager.test.tsx`（MCP 子标签不再含浏览器开关）
- 必要时 `packages/core/i18n/index.test.ts`（U1 已加）

**Approach** 以 U2/U3 的新断言为主，本单元做收口：跑全仓 `pnpm typecheck` + `pnpm test`，修正 `SettingsTab` 并集扩展、i18n typed 资源等引发的连带类型/快照问题。确认现有「插件标签渲染三层 IA」用例（`SettingsMenu.test.tsx:279`）在「插件」改挂于「应用」组后仍以 `name:"插件"` 命中（分组不改项 label）。

**Test scenarios**
- 全量回归：`SettingsMenu.test.tsx` / `PluginManager.test.tsx` / `i18n/index.test.ts` 全绿。
- 边界：切换到每个分区（11 项）右栏渲染对应 Section 不抛错（可参数化抽样几项：browser、plugins、pi、voice）。

**Verification** `pnpm typecheck && pnpm test && pnpm lint` 全绿。

---

## Scope Boundaries

**In scope**
- 设置左栏分组渲染、固定宽 300px、新增「应用/浏览器」分区、`BrowserControlSection` 位移、相关 i18n 与测试。

**Out of scope（非目标）**
- 不改各分区（profile/general/providers/agent/pi/plugins/pet/timeline/push/voice）自身的内容、控件或逻辑。
- 不改插件管理器（`PluginManager`）三层 IA 内部结构（除从 MCP 子标签摘掉 BrowserControlSection 外）。
- 不动 Web 端（`apps/web`）—— 本设置页为 desktop 个人工作区视图；如 Web 复用同组件则自然继承，但不为此新增 Web 专属适配。
- 不引入分组的折叠/展开交互（组标题为静态分隔，非可折叠面板）。

### Deferred to Follow-Up Work
- 分组的可折叠/记忆展开态、菜单项搜索/过滤 —— 如后续项数继续增长再评估。
- 设置项在窄窗下的响应式（移动到顶栏/抽屉）—— 当前整页覆盖层为桌面定宽场景，暂不处理。

---

## System-Wide Impact

- **受影响面**：仅 `packages/views` 设置视图 + `packages/core` i18n。无 IPC / `DesktopBridge` / store schema 改动，无后端面。
- **复用风险**：`.pw-dlg-nav` / `.pw-dlg-nav-h` 同时被其它弹窗（`.pw-dlg-*`）复用 —— 宽度 300px 与组标题间距改动**已限定在 `.pw-settings-page` 作用域**（U4），不外溢到通用弹窗。U4 落地时需确认未污染非设置页的 `.pw-dlg-nav-h` 使用者（若有）。
- **i18n typed 资源**：`SettingsTab` 并集 + `resources.d.ts` 需同步，否则 typecheck 报缺键（U1/U5 守）。

---

## Risks & Mitigations

- **风险：组标题样式 `.pw-dlg-nav-h` 被其它组件引用导致样式串场。** 缓解：U4 改动加 `.pw-settings-page` 前缀作用域；实现前 grep 该类引用面确认。
- **风险：`SettingsTab` 加 `browser` 后右栏 switch 漏分支（落到末尾 `: <VoiceSection/>` 兜底）。** 缓解：U3 显式加 `browser` 分支并加切换断言；U5 抽样遍历守。
- **风险：插件相关测试以文本「插件」断言，分组后若 label 变动会断。** 缓解：分组不改项 label（「插件」文案不变），仅新增组标题「应用」，现有断言应保持命中（U5 显式确认 `:279` 用例）。

---

## Sources & Research

- 现状代码：`SettingsMenu.tsx`（`TABS`/`PersonalSettingsView`）、`PluginManagePage.tsx:13,141`（BrowserControlSection 现归属）、`BrowserControlSection.tsx`、`cortex-desktop.css:5968-6106`（nav/宽度/作用域）、`settings.json` tabs 段、`SettingsMenu.test.tsx` 既有用例。
- 规划期用户确认：①「应用」组采两并列项（插件 + 浏览器）；② 采用 5 组方案。
- 未获取：[Image #11]/[Image #12] 未随会话传入，分组与宽度均以用户文字 + 上述确认为准。
