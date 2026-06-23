---
title: "feat: 执行过程面板默认收起、点击向下展开"
type: feat
date: 2026-06-23
status: ready
depth: lightweight
component: PersonalProcessPanel
---

# feat: 执行过程面板默认收起、点击向下展开

## Summary

会话「执行过程」面板(`PersonalProcessPanel`)目前在 agent 运行中**默认完整展开**为右侧大卡片(见用户截图),抢占视觉、压窄会话区。本计划把默认形态改为**常驻细头部 + body 默认收起**的手风琴:无论运行中还是已完成,默认只露一条带标题(`执行过程`)、状态徽标(运行中/已完成)与朝下 chevron 的细头部;用户点击头部后 body 才向下展开露出步骤详情。运行/完成的状态变化与 chevron 朝向即为用户的「执行感知」,无需自动撑开整块面板。

属单组件、边界清晰的 Lightweight 改动:渲染逻辑(`PersonalProcessPanel.tsx`)、配套 CSS(`cortex-desktop.css`)、单测(`PersonalProcessPanel.test.tsx`)三处联动。

---

## Problem Frame

- **现状**:`PersonalProcessPanel.tsx:145` 的展开判定为 `expanded = userOpen ?? active` —— 运行中(`active=true`)默认展开整张卡片;一轮结束(`active=false`)才自动塌成一个 40px 圆形 icon(FAB)。即「运行 = 强制展开」。
- **痛点**:运行中面板自动撑满右列,信息密度高、视觉抢焦、压窄会话区,而多数时候用户只想知道「在跑/跑完了」,不需要逐步看过程。
- **目标**:默认收起,只用一条常驻细头部 + 图标状态变化给出感知;用户主动点开才向下展开看详情。
- **取舍**:用户已确认采用**常驻细头部**形态(而非沿用圆形 FAB):面板始终占位、标题与状态徽标常驻,代价是收起时右列不再塌窄、会话区不随之变宽——换来一个带标签、可感知状态的稳定再开入口。

---

## Requirements

- **R1**:面板默认收起 —— 运行中与已完成态首次渲染都只显示细头部,body 不渲染。
- **R2**:收起态头部常驻显示「执行过程」标题 + 状态徽标(运行中=琥珀、已完成=绿)+ 朝下 chevron。
- **R3**:点击 / Enter / Space 头部切换 body 显隐;展开时 chevron 旋转朝上,body 向下露出。
- **R4**:状态变化(运行中 ↔ 已完成)实时反映在徽标上,即便处于收起态(用户的「执行感知」来源)。
- **R5**:用户手动展开/收起在**同一轮**内保持(流式增量、收尾不重置);**下一轮**过程流(`processResetKey` 变化)恢复默认收起。
- **R6**:可达性不回退 —— 头部 `role=button` + `tabIndex=0` + 键盘可激活;`aria-expanded` 随展开态变化;body 仍 `aria-live=polite`;面板出现不抢当前焦点。
- **R7**:门控、会话隔离、扩展命令空态等既有行为完全保持不变(本计划不触碰)。

---

## Key Technical Decisions

### KTD1 — 翻转默认值:`active` → `false`

把 `expanded = userOpen ?? active` 改为 `expanded = userOpen ?? false`。这是行为翻转的核心一行:默认收起,`userOpen` 仍承载用户手动覆盖,`processResetKey` 变化时 `useEffect` 把 `userOpen` 重置为 `null` → 回到默认收起。「同一轮保持 / 下一轮恢复默认」机制完全复用,只是「默认」从展开变收起。

### KTD2 — 合并双渲染为单卡片手风琴,弃用圆形 FAB

现状收起态(`is-collapsed`)是一段**独立**的 `<button>` 圆形 FAB 渲染分支,与展开态完整卡片是两套 DOM。新设计统一为**一张卡片**:始终渲染 `.pw-process` 外壳 + `.pw-process-head`,仅 body 随 `expanded` 条件渲染。好处:头部(标题/徽标/chevron)收起展开两态共用、无 DOM 重建、过渡自然。圆形 FAB 的 `pw-process-fab-ic` 结构与 `.is-collapsed` 圆形 CSS 一并移除。

### KTD3 — 头部既是开关,语义随态切换

头部 `role=button`,`aria-expanded`/`aria-label` 随 `expanded` 切换(收起→「展开执行过程」,展开→「收起执行过程」)。复用现有展开态头部的键盘处理(Enter/Space `preventDefault` + toggle)。`toggle` 逻辑沿用 `setUserOpen((v) => !(v ?? active))` —— 注意默认翻转后,首次点击从「收起(默认)」翻到展开,行为正确。

### KTD4 — chevron 朝向表达开合

`Icon.Chevron` 自然朝下(⌄)。收起态 chevron 朝下,提示「点开向下展开」;展开态旋转朝上(⌃)。CSS 上即:收起态不加 `is-open`(或保持自然朝下),展开态加 `is-open` 旋转 180° 朝上。需调整现有 `.pw-process-chev` 的 `is-open` 约定(当前 `is-open` 为 `rotate(0)` 朝下,需改为展开朝上)。

### KTD5 — 收起态头部不撑满列高

收起态卡片 `align-self: start`(沿用现 `.is-collapsed` 的对齐意图),只占头部一行高度,避免出现一张几乎全空、撑满列高的卡片。收起态头部去掉 `border-bottom`(无 body 时下边框多余)。卡片宽度保持 `clamp(320px, 30vw, 418px)`——这是用户已确认接受的「面板常驻占位」代价。

---

## High-Level Technical Design

收起/展开两态共用同一卡片外壳,仅 body 条件渲染;`expanded` 由 `userOpen ?? false` 决定,跨轮经 `processResetKey` 重置默认。

```text
                 ┌─────────────────────────────────────┐
                 │  .pw-process  (单卡片外壳, 常驻)        │
                 │  ┌───────────────────────────────┐   │
   常驻头部 ─────▶│  │ .pw-process-head  role=button │   │
   (toggle 开关)  │  │  执行过程  [运行中/已完成]  chev │   │
                 │  └───────────────────────────────┘   │
                 │  ┌───────────────────────────────┐   │
   仅 expanded ─▶│  │ .pw-process-body  aria-live    │   │  ← {expanded && ...}
   时渲染        │  │   回复状态 / ProcessStep...     │   │
                 │  └───────────────────────────────┘   │
                 └─────────────────────────────────────┘

   expanded = userOpen ?? false        ← KTD1 翻转默认
   toggle  : userOpen = !(userOpen ?? active)
   跨轮重置: useEffect([processResetKey]) → userOpen = null → 默认收起

   状态机:
     首渲染(运行中) ── 默认收起 ──▶ [收起·运行中 ⌄]
                                      │ 点击头部
                                      ▼
                                  [展开·运行中 ⌃ + body]
                                      │ 收尾 active→false (同轮, userOpen 保持)
                                      ▼
                                  [展开·已完成 ⌃ + body]
     下一轮 processResetKey 变 ──────▶ [收起·运行中 ⌄]   (userOpen 重置 null)
```

---

## Implementation Units

### U1. 组件渲染改为常驻头部手风琴 + 默认收起

**Goal**:把 `PersonalProcessPanel` 的双分支渲染(圆形 FAB 收起态 / 完整卡片展开态)合并为单卡片手风琴,默认收起,头部常驻、body 条件渲染。

**Requirements**:R1, R2, R3, R4, R5, R6

**Dependencies**:无

**Files**:
- `packages/views/cortex-desktop/personal/PersonalProcessPanel.tsx`(改渲染逻辑 + 顶部 1–15 行 doc 注释)

**Approach**:
- KTD1:`const expanded = userOpen ?? false;`(原 `?? active`)。
- KTD2:删除 `if (!expanded) { return <button className="pw-process is-collapsed" ...> ...FAB... </button> }` 整个分支;保留单一 `return`,卡片 className 按 `expanded` 给 `is-expanded` / `is-collapsed`。
- 头部(`.pw-process-head`)提到条件之外、常驻渲染:`aria-expanded={expanded}`、`aria-label` 按态切换、chevron className 按 `expanded` 切 `is-open`。
- body 改为 `{expanded && (<div className="pw-process-body" aria-live="polite">...</div>)}`。
- `toggle`、`useEffect([processResetKey])` 重置、`active` 计算保持不变。
- 更新顶部 doc 注释:把「运行中默认展开、一轮结束自动收起为 icon」改述为「默认收起为常驻细头部、点击向下展开、下一轮恢复默认收起」。

**Patterns to follow**:沿用现有展开态头部的 `onKeyDown`(Enter/Space `preventDefault()` + `toggle()`)与 `data-active` 约定;`StatusStep` / `ProcessStep` 渲染不动。

**Execution note**:建议先改 U3 测试为「默认收起」预期(失败)再改本单元至通过(test-first;组件已有完善单测,翻转默认值风险点在跨轮重置与状态徽标)。

**Test scenarios**(实际断言落在 U3,本单元为被测主体):
- Covers R1. 运行中首渲染:存在 `.pw-process.is-collapsed`,`.pw-process-body` 为 null,头部含「执行过程」标题。
- Covers R3. 点击头部 → 出现 `.pw-process.is-expanded` + `.pw-process-body`,可见步骤文本。
- Covers R4. 收起态下 `active` 由 true→false:状态徽标从 `is-active`(运行中)变 `is-done`(已完成),仍保持收起。
- Covers R5. 同一轮:展开后流式新增步骤,仍展开;`active` 翻 false 仍展开(userOpen 保持)。
- Covers R5. 跨轮:展开后替换为新 `uid` 过程流(processResetKey 变)→ 恢复默认收起。
- Covers R6. 头部 `tabIndex=0`、可 focus、Enter 切换展开;面板挂载不抢外部 input 焦点。

**Verification**:`pnpm --filter @cortex-work/views test -- run packages/views/cortex-desktop/personal/PersonalProcessPanel.test.tsx` 全绿;手动 `pnpm dev:desktop` 跑一轮 agent,确认默认只见细头部、点击向下展开、跑完徽标转绿仍保持上次开合态、下一轮恢复收起。

---

### U2. 收起态头部 CSS 与 chevron 朝向

**Goal**:把收起态从 40px 圆形 FAB 样式改造为「常驻细头部」样式,并修正 chevron 开合朝向。

**Requirements**:R2, R3, KTD4, KTD5

**Dependencies**:U1(类名约定一致)

**Files**:
- `packages/views/cortex-desktop/cortex-desktop.css`(`.pw-process*` 段,约 973–1043 行)

**Approach**:
- 移除/重写 `.pw-process.is-collapsed` 现有的 40px 圆形规则(`width/height:40px; border-radius:999px; inline-flex 居中` 等)及 `.pw-process-fab-ic`、`is-collapsed[data-active]` 配色规则。
- 新 `.pw-process.is-collapsed`:`align-self: start`(只占头部高度,不撑满列高),卡片宽度沿用 `.pw-process` 的 `clamp`;`.is-collapsed .pw-process-head { border-bottom: none; }`。
- chevron(KTD4):调整 `.pw-process-chev` 与 `.is-open` —— 收起态自然朝下(⌄),`.is-open`(展开)旋转朝上(⌃,`rotate(180deg)`)。保留 `transition: transform .18s`。
- 头部 hover/focus-visible 可达样式保持(`.pw-process-head:focus-visible`)。

**Patterns to follow**:沿用 `--amber`/`--green`/`--border` 变量与现有徽标 `.pw-process-badge.is-active/.is-done` 配色;`prefers-reduced-motion` 段保持。

**Test expectation: none —— 纯样式调整,无行为断言;视觉效果在 U1 验证中手动确认(细头部形态、chevron 朝向、收起不撑满列高)。**

**Verification**:`pnpm dev:desktop` 目视:收起态为一条带标题/徽标/朝下 chevron 的细头部,不再是小圆 icon、不撑满列高;展开 chevron 朝上、body 向下展开;运行中徽标琥珀、完成绿。

---

### U3. 更新单测:默认收起 / 点击展开 / 跨轮恢复

**Goal**:把现有围绕「运行中默认展开 / 完成自动塌为 FAB」的用例改写为「默认收起细头部 / 点击向下展开 / 下一轮恢复默认收起」,移除对 `pw-process-fab-ic` 的断言。

**Requirements**:R1, R3, R4, R5, R6

**Dependencies**:U1

**Files**:
- `packages/views/cortex-desktop/personal/PersonalProcessPanel.test.tsx`

**Approach**(按现有用例逐条调整,保持会话隔离/门控等无关用例不动):
- 「当前会话有过程流时渲染并展示步骤」:默认收起后 body 不渲染,步骤文本不再直接可见 → 改为断言 `.pw-process.is-collapsed` 渲染 + 头部含「执行过程」;步骤可见性移到「点击展开后」断言。
- 「挂载时无过程但运行中立即显示右侧回复状态」/「typing 同步更新」:不再 `is-expanded`;改为断言收起态徽标=运行中,点击头部展开后才见回复状态文本。
- 「finalizeRun 后自动收起为 icon」:重写为「收尾后仍保持收起(默认),且为细头部非 FAB」——断言 `.is-collapsed` 存在、`.pw-process-fab-ic` **不存在**、徽标转 `is-done`。
- 「运行中也允许用户折叠」:语义反转为「运行中可点击展开,同一轮新增步骤保持展开」。
- 「下一轮过程流替换后恢复默认展开」→「恢复默认收起」:展开后换新 uid → 断言回到 `.is-collapsed` + body null。
- 「默认展开:运行中正常展开 body」describe:改为「默认收起:运行中只见细头部」。
- 键盘可达用例:起始态改为收起,Enter/点击展开;移除「收起态是 `<button>`/FAB」断言,改断言头部 `role=button` 可激活。

**Patterns to follow**:复用现有 `renderPanel` / `logMsg` 工厂与 `waitFor`/`act` 写法,仅改断言目标类名与展开顺序。

**Test scenarios**:见上方 U1 Test scenarios(本单元承载其断言)。新增/改写覆盖:
- Covers R1. 运行中首渲染默认 `.is-collapsed`、body null。
- Covers R3. 点击头部展开 → `.is-expanded` + body + 步骤文本可见。
- Covers R4. 收起态 `active` true→false 徽标 `is-active`→`is-done`,保持收起。
- Covers R5. 同轮流式增量/收尾保持用户开合态;跨轮(新 uid)恢复默认收起。
- Covers R6. 头部键盘 focus + Enter 切换;挂载不抢焦点(保留现用例)。
- 回归:确认无任何 `.pw-process-fab-ic` / `.is-collapsed` 圆形 FAB 残留断言。

**Execution note**:test-first —— 先把这些用例改成新预期(对当前实现失败),再做 U1/U2 至全绿。

**Verification**:`pnpm --filter @cortex-work/views test -- run packages/views/cortex-desktop/personal/PersonalProcessPanel.test.tsx` 全绿;`pnpm --filter @cortex-work/views typecheck` 通过。

---

## Scope Boundaries

**本计划范围内**:
- `PersonalProcessPanel` 默认收起 + 常驻头部手风琴渲染。
- 配套 CSS(收起态头部形态、chevron 朝向)与单测改写。
- 顶部 doc 注释同步新行为。

**不在范围内(保持现状,勿动)**:
- 门控逻辑(`chatViewActive` / 空态 / 扩展命令空态 return null)。
- 会话隔离与多会话并发(R7,只渲染 `activeSessionId` 那份)。
- `StatusStep` / `ProcessStep` 内部渲染、`usePersonalProcess` 数据通道、store。
- 收起态是否塌窄右列以加宽会话区——用户已确认接受「面板常驻占位」,**不**追求收起加宽会话区。

### Deferred to Follow-Up Work
- 若后续希望收起态更省地(细头部收窄为贴边小条或可整列隐藏以加宽会话区),作为独立交互迭代单开,不在本次。
- body 展开/收起的高度过渡动画(滑动展开)——本次仅条件渲染,如需顺滑动画后续再加。

---

## Risks & Dependencies

- **风险:跨轮重置回归**。翻转默认值后,「下一轮恢复默认」从「恢复展开」变「恢复收起」,`processResetKey`/`useEffect` 机制不变但断言方向反转——U3 须明确覆盖,避免漏测导致下一轮仍停在上一轮开合态。
- **风险:CSS 残留**。圆形 FAB 的 `.is-collapsed` 旧规则若未清干净,会与新细头部样式冲突(如残留 `border-radius:999px` / 40px 宽高)。U2 须确认旧规则移除。
- **风险:收起态 `aria-live` 失声**。收起时 body 不渲染,流式步骤不再被读屏播报——与现状 FAB 收起态一致(本就无 body),非回退;状态感知由头部徽标承载,可接受。
- **依赖**:无外部依赖;单文件组件 + 同包 CSS + 同包测试,改动自洽。

---

## Sources & Research

- 现状实现:`packages/views/cortex-desktop/personal/PersonalProcessPanel.tsx`(`expanded = userOpen ?? active`、双分支渲染)、`cortex-desktop.css:973–1043`(`.pw-process*`)、`PersonalProcessPanel.test.tsx`(默认展开/折叠用例)。
- 图标:`packages/ui/icons/index.tsx:132` `Icon.Chevron` 自然朝下,决定 chevron 朝向约定(KTD4)。
- 原始 U4 计划:`docs/plans/2026-06-18-003-feat-personal-process-side-panel-plan.md`(过程区设计起源,KTD3/KTD9)。
- 未做外部研究:单组件本地模式清晰、无高风险面、设计岔路已由用户当场拍板(常驻细头部形态),无需外部检索。
