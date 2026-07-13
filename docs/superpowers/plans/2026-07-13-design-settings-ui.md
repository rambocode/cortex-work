# Design Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“设置 → 设计”改造成紧凑、专业、自适应的双列设置页，同时保持现有字段、交互和持久化合同不变。

**Architecture:** `DesignSettingsSection` 新增页面作用域根节点、只读状态摘要、局部 `DesignCard` 组件和五卡网格。现有 `usePersonalStore` 与 `DesktopBridge` 数据流不变；样式全部限定在 `.pw-design-settings` 下，并通过 CSS container query 在内容区变窄时回落单列。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、Testing Library、原生 CSS container queries、现有 `@cortex-work/ui/icons` 与设置控件。

---

## 文件结构

- Create: `packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx` — 验证页面结构、摘要、store 更新、目录 bridge 和响应式 CSS 合同。
- Modify: `packages/views/cortex-desktop/personal/DesignSettingsSection.tsx` — 负责五卡布局和现有设置交互，不新增持久化职责。
- Modify: `packages/views/cortex-desktop/cortex-desktop.css` — 只追加 `.pw-design-settings` 作用域样式，不修改其他设置分区共享样式。

### Task 1: 固定结构与数据流合同

**Files:**
- Create: `packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx`
- Test: `packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx`

- [ ] **Step 1: 写结构、摘要和更新链路失败测试**

创建测试文件，使用 `defaultDesignSettings()` 重置 store，并通过 `CoreProvider` 注入可选 bridge：

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import { defaultDesignSettings } from "@cortex-work/core/design/compat/app-settings";
import { DesignSettingsSection } from "./DesignSettingsSection";

const TEST_WS_ID = "test-ws";
const TEST_IDENTITY = { userId: "me", name: "我" };

function renderUI(bridge: DesktopBridge | null = null) {
  return render(
    <CoreProvider wsId={TEST_WS_ID} identity={TEST_IDENTITY} desktopBridge={bridge}>
      <DesignSettingsSection />
    </CoreProvider>,
  );
}

beforeEach(() => {
  usePersonalStore.setState({ designSettings: defaultDesignSettings() });
});
afterEach(cleanup);

describe("DesignSettingsSection", () => {
  it("渲染紧凑摘要与五个语义卡片", () => {
    const { container } = renderUI();
    const root = container.querySelector(".pw-design-settings");
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll(".pw-design-card")).toHaveLength(5);
    expect(root!.querySelector(".pw-design-card--workspace")).not.toBeNull();

    const summary = within(root!.querySelector(".pw-design-summary") as HTMLElement);
    expect(summary.getByText("默认视口")).toBeTruthy();
    expect(summary.getByText("桌面")).toBeTruthy();
    expect(summary.getByText("默认视图")).toBeTruthy();
    expect(summary.getByText("预览")).toBeTruthy();
    expect(summary.getByText("设计系统预设")).toBeTruthy();
    expect(summary.getByText("none")).toBeTruthy();
  });

  it("字段与开关继续更新 designSettings store", () => {
    renderUI();
    fireEvent.change(screen.getByPlaceholderText("React + Tailwind + shadcn/ui"), {
      target: { value: "React + CSS Modules" },
    });
    fireEvent.change(screen.getByDisplayValue("桌面"), { target: { value: "mobile" } });
    fireEvent.click(screen.getByRole("switch", { name: "实时刷新" }));

    expect(usePersonalStore.getState().designSettings).toMatchObject({
      implementStackHint: "React + CSS Modules",
      defaultViewport: "mobile",
      liveRefresh: false,
    });
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --filter @cortex-work/views exec vitest run cortex-desktop/personal/DesignSettingsSection.test.tsx
```

Expected: FAIL，因为 `.pw-design-settings`、`.pw-design-summary`、`.pw-design-card` 和工作目录卡片类尚不存在。

- [ ] **Step 3: 补目录 bridge 与 CSS 合同失败测试**

在同一测试文件追加：

```tsx
it("选择目录与恢复默认沿用 DesktopBridge", async () => {
  const pickDirectory = vi.fn(async () => "/tmp/design-picked");
  const designWorkspaceRoot = vi.fn(async () => "/tmp/design-default");
  const bridge = { pickDirectory, designWorkspaceRoot } as unknown as DesktopBridge;
  renderUI(bridge);

  fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
  await screen.findByDisplayValue("/tmp/design-picked");
  expect(pickDirectory).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await screen.findByDisplayValue("/tmp/design-default");
  expect(designWorkspaceRoot).toHaveBeenCalledTimes(1);
});

it("bridge 不可用时目录按钮保持禁用", () => {
  renderUI(null);
  expect(screen.getByRole("button", { name: "选择目录" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "恢复默认" })).toBeDisabled();
});

it("设计设置样式声明双列、跨列和容器窄屏回落", () => {
  const css = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");
  expect(css).toMatch(/\.pw-design-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  expect(css).toMatch(/\.pw-design-card--workspace\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  expect(css).toMatch(/@container\s+design-settings\s*\(max-width:\s*720px\)/);
});
```

- [ ] **Step 4: 再次运行测试并确认仍为预期 RED**

Run:

```bash
pnpm --filter @cortex-work/views exec vitest run cortex-desktop/personal/DesignSettingsSection.test.tsx
```

Expected: FAIL 在新结构和 CSS 断言；现有目录 bridge 行为应通过。

- [ ] **Step 5: 提交测试基线**

```bash
git add packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx
git commit -m "test(views): 覆盖设计设置页紧凑布局合同"
```

### Task 2: 实现紧凑五卡结构

**Files:**
- Modify: `packages/views/cortex-desktop/personal/DesignSettingsSection.tsx`
- Test: `packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx`

- [ ] **Step 1: 增加局部卡片组件和选项单一来源**

在 imports 中加入：

```tsx
import type { ReactNode } from "react";
import { Icon } from "@cortex-work/ui/icons";
```

删除 `SettingCard` import，保留 `SBlock`、`SwitchRow`、`BareSelect`。在组件前增加局部卡片：

```tsx
function DesignCard({
  title,
  icon,
  className = "",
  children,
}: {
  title: string;
  icon: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`pw-scard pw-design-card ${className}`.trim()}>
      <div className="pw-scard-t pw-design-card-title">
        <span className="pw-design-card-icon" aria-hidden="true">{icon}</span>
        <span>{title}</span>
      </div>
      <div className="pw-design-card-body">{children}</div>
    </section>
  );
}
```

在 `DesignSettingsSection` 内定义一次选项并复用到摘要与下拉：

```tsx
const viewportOptions = [
  { value: "desktop", label: t("design.viewportDesktop") },
  { value: "tablet", label: t("design.viewportTablet") },
  { value: "mobile", label: t("design.viewportMobile") },
];
const viewOptions = [
  { value: "preview", label: t("design.viewPreview") },
  { value: "code", label: t("design.viewCode") },
];
const backgroundOptions = [
  { value: "light", label: t("design.bgLight") },
  { value: "dark", label: t("design.bgDark") },
];
const currentViewport = viewportOptions.find((option) => option.value === settings.defaultViewport)?.label;
const currentView = viewOptions.find((option) => option.value === settings.defaultCanvasView)?.label;
```

- [ ] **Step 2: 用作用域根节点、摘要和网格替换顶层 fragment**

保持全部现有事件处理器不变，将 return 骨架调整为：

```tsx
return (
  <div className="pw-design-settings">
    <div className="pw-design-heading">
      <div className="pw-dlg-title">{t("design.title")}</div>
      <div className="pw-dlg-desc">{t("design.desc")}</div>
    </div>

    <div className="pw-design-summary" aria-label={t("design.title")}>
      <div className="pw-design-summary-item">
        <span>{t("design.defaultViewport")}</span>
        <strong>{currentViewport}</strong>
      </div>
      <div className="pw-design-summary-item">
        <span>{t("design.defaultCanvasView")}</span>
        <strong>{currentView}</strong>
      </div>
      <div className="pw-design-summary-item">
        <span>{t("design.preset")}</span>
        <strong>{settings.designSystemPreset}</strong>
      </div>
    </div>

    <div className="pw-design-grid">{designCards}</div>
  </div>
);
```

- [ ] **Step 3: 迁移五组字段到局部卡片并保持处理器不变**

在 `return` 前将 `designCards` 定义为以下五张卡片；所有事件处理器直接沿用当前 store 与 bridge 调用：

```tsx
const designCards = (
<>
<DesignCard title={t("design.codeCard")} icon={<Icon.Code size={15} />} className="pw-design-card--code">
  <SBlock label={t("design.stackHint")} desc={t("design.stackHintDesc")}>
    <input
      className="pw-set-input"
      value={settings.implementStackHint}
      placeholder={t("design.stackHintPlaceholder")}
      onChange={(e) => setDesignSettings({ implementStackHint: e.target.value })}
    />
  </SBlock>
  <SwitchRow label={t("design.injectIntoCode")} desc={t("design.injectIntoCodeDesc")} value={settings.injectIntoCode} onChange={(v) => setDesignSettings({ injectIntoCode: v })} />
  <SwitchRow label={t("design.publishDesignSystem")} desc={t("design.publishDesignSystemDesc")} value={settings.publishDesignSystem} onChange={(v) => setDesignSettings({ publishDesignSystem: v })} />
</DesignCard>

<DesignCard title={t("design.canvasCard")} icon={<Icon.Eye size={15} />} className="pw-design-card--canvas">
  <div className="pw-design-fields">
    <div className="pw-design-field">
      <SBlock label={t("design.defaultViewport")}>
        <BareSelect value={settings.defaultViewport} onChange={(v) => setDesignSettings({ defaultViewport: v as DesignViewportSetting })} options={viewportOptions} />
      </SBlock>
    </div>
    <div className="pw-design-field">
      <SBlock label={t("design.defaultCanvasView")}>
        <BareSelect value={settings.defaultCanvasView} onChange={(v) => setDesignSettings({ defaultCanvasView: v as DesignCanvasViewSetting })} options={viewOptions} />
      </SBlock>
    </div>
    <div className="pw-design-field pw-design-field--wide">
      <SBlock label={t("design.canvasBackground")}>
        <BareSelect value={settings.canvasBackground} onChange={(v) => setDesignSettings({ canvasBackground: v as DesignBackgroundSetting })} options={backgroundOptions} />
      </SBlock>
    </div>
  </div>
  <SwitchRow label={t("design.liveRefresh")} desc={t("design.liveRefreshDesc")} value={settings.liveRefresh} onChange={(v) => setDesignSettings({ liveRefresh: v })} />
  <SwitchRow label={t("design.deviceFrame")} desc={t("design.deviceFrameDesc")} value={settings.deviceFrame} onChange={(v) => setDesignSettings({ deviceFrame: v })} />
</DesignCard>

<DesignCard title={t("design.workspaceCard")} icon={<Icon.Folder size={15} />} className="pw-design-card--workspace">
  <SBlock label={t("design.workspaceRoot")} desc={t("design.workspaceRootDesc")}>
    <div className="pw-design-workspace-control">
      <input className="pw-set-input" value={settings.defaultWorkspaceRoot} onChange={(e) => setDesignSettings({ defaultWorkspaceRoot: e.target.value })} />
      <div className="pw-design-workspace-actions">
        <button
          className="pw-btn pw-design-action pw-design-action--primary"
          disabled={!bridge}
          onClick={() => {
            void bridge?.pickDirectory().then((dir) => {
              if (dir) setDesignSettings({ defaultWorkspaceRoot: dir });
            });
          }}
        >
          {t("design.pickDir")}
        </button>
        <button
          className="pw-btn pw-design-action"
          disabled={!bridge?.designWorkspaceRoot}
          onClick={() => {
            void bridge?.designWorkspaceRoot?.().then((dir) => {
              setDesignSettings({ defaultWorkspaceRoot: dir });
            });
          }}
        >
          {t("design.resetDir")}
        </button>
      </div>
    </div>
  </SBlock>
</DesignCard>

<DesignCard title={t("design.systemCard")} icon={<Icon.Palette size={15} />} className="pw-design-card--system">
  <SBlock label={t("design.brandColor")} desc={t("design.brandColorDesc")}>
    <input className="pw-set-input" value={settings.brandColor} placeholder="#3B82D8" onChange={(e) => setDesignSettings({ brandColor: e.target.value })} />
  </SBlock>
  <SBlock label={t("design.tone")} desc={t("design.toneDesc")}>
    <input className="pw-set-input" value={settings.tone.join(", ")} onChange={(e) => setDesignSettings({ tone: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
  </SBlock>
  <SBlock label={t("design.preset")}>
    <BareSelect value={settings.designSystemPreset} onChange={(v) => setDesignSettings({ designSystemPreset: v as DesignSystemPreset })} options={DESIGN_SYSTEM_PRESETS.map((preset) => ({ value: preset, label: preset }))} />
  </SBlock>
  <SBlock label={t("design.guidelines")} desc={t("design.guidelinesDesc")}>
    <textarea className="pw-set-input pw-design-textarea" rows={3} value={settings.designGuidelines} onChange={(e) => setDesignSettings({ designGuidelines: e.target.value })} />
  </SBlock>
</DesignCard>

<DesignCard title={t("design.agentCard")} icon={<Icon.Bot size={15} />} className="pw-design-card--agent">
  <SBlock label={t("design.model")} desc={t("design.modelDesc")}>
    <input className="pw-set-input" value={settings.model} onChange={(e) => setDesignSettings({ model: e.target.value })} />
  </SBlock>
  <SBlock label={t("design.generationPrompt")} desc={t("design.generationPromptDesc")}>
    <textarea className="pw-set-input pw-design-textarea" rows={4} value={settings.generationPrompt} onChange={(e) => setDesignSettings({ generationPrompt: e.target.value })} />
  </SBlock>
</DesignCard>
</>
);
```

- [ ] **Step 4: 运行组件测试确认结构与交互只剩 CSS 断言失败**

Run:

```bash
pnpm --filter @cortex-work/views exec vitest run cortex-desktop/personal/DesignSettingsSection.test.tsx
```

Expected: 结构、摘要、store 与 bridge 测试 PASS；CSS 合同测试仍 FAIL。

- [ ] **Step 5: 提交组件结构**

```bash
git add packages/views/cortex-desktop/personal/DesignSettingsSection.tsx packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx
git commit -m "feat(views): 重构设计设置页信息结构"
```

### Task 3: 实现自适应紧凑样式

**Files:**
- Modify: `packages/views/cortex-desktop/cortex-desktop.css`
- Test: `packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx`

- [ ] **Step 1: 追加完全作用域化的布局样式**

在设置页排版规则之后追加：

```css
/* 设计设置：紧凑双列卡片；以右侧内容区自身宽度回落，不依赖整窗宽度。 */
.pw-design-settings {
  container: design-settings / inline-size;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pw-design-heading { display: flex; flex-direction: column; gap: 4px; }
.pw-design-settings .pw-dlg-desc { margin-bottom: 0; }
.pw-design-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--border-soft);
}
.pw-design-summary-item {
  min-width: 0;
  padding: 9px 12px;
  background: var(--bg-card-2, var(--bg-soft));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.pw-design-summary-item span { font-size: 11.5px; color: var(--text-3); }
.pw-design-summary-item strong {
  overflow: hidden;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pw-design-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}
.pw-settings-page .pw-design-card { margin-top: 0; padding: 0 14px 5px; }
.pw-design-card--workspace { grid-column: 1 / -1; }
.pw-design-card-title { display: flex; align-items: center; gap: 8px; padding: 13px 2px 8px; }
.pw-design-card-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 7px;
  background: var(--bg-chip);
  color: var(--text-2);
}
.pw-design-card-body > .pw-sblock:first-child,
.pw-design-card-body > .pw-srow:first-child { border-top: 0; }
.pw-design-card .pw-sblock { padding: 11px 2px; }
.pw-design-card .pw-srow { gap: 12px; padding: 11px 2px; }
.pw-design-card .pw-srow-l { flex: 1 1 auto; }
.pw-design-card .pw-srow-c { flex: 0 0 auto; }
.pw-design-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.pw-design-fields .pw-sblock { border-top: 0; }
.pw-design-field:nth-child(even) { padding-left: 8px; }
.pw-design-field:nth-child(odd) { padding-right: 8px; }
.pw-design-field--wide { grid-column: 1 / -1; padding-right: 0; padding-left: 0; }
.pw-design-workspace-control { display: flex; align-items: center; gap: 8px; }
.pw-design-workspace-control > .pw-set-input { flex: 1 1 auto; min-width: 0; }
.pw-design-workspace-actions { display: flex; gap: 8px; flex: none; }
.pw-design-action { min-height: 32px; padding: 6px 12px; border-radius: 8px; font-size: 12.5px; }
.pw-design-action--primary { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 32%, var(--border)); }
.pw-design-textarea { min-height: 84px; resize: vertical; line-height: 1.5; font-family: inherit; }

@container design-settings (max-width: 720px) {
  .pw-design-summary { grid-template-columns: 1fr; }
  .pw-design-grid { grid-template-columns: 1fr; }
  .pw-design-card--workspace { grid-column: auto; }
  .pw-design-workspace-control { align-items: stretch; flex-direction: column; }
  .pw-design-workspace-actions { flex-wrap: wrap; }
}

@container design-settings (max-width: 420px) {
  .pw-design-fields { grid-template-columns: 1fr; }
  .pw-design-field,
  .pw-design-field:nth-child(even),
  .pw-design-field:nth-child(odd) { grid-column: auto; padding-right: 0; padding-left: 0; }
}
```

- [ ] **Step 2: 运行组件测试确认 GREEN**

Run:

```bash
pnpm --filter @cortex-work/views exec vitest run cortex-desktop/personal/DesignSettingsSection.test.tsx
```

Expected: 全部测试 PASS。

- [ ] **Step 3: 运行 views 包回归和静态检查**

Run:

```bash
pnpm --filter @cortex-work/views test
pnpm --filter @cortex-work/views typecheck
pnpm --filter @cortex-work/views exec eslint cortex-desktop/personal/DesignSettingsSection.tsx cortex-desktop/personal/DesignSettingsSection.test.tsx
git diff --check
```

Expected: 测试、类型检查与 lint 均退出 0；`git diff --check` 无输出。

- [ ] **Step 4: 提交样式实现**

```bash
git add packages/views/cortex-desktop/cortex-desktop.css packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx
git commit -m "style(views): 紧凑化设计设置页布局"
```

### Task 4: 真实页面视觉验收

**Files:**
- Verify: `packages/views/cortex-desktop/personal/DesignSettingsSection.tsx`
- Verify: `packages/views/cortex-desktop/cortex-desktop.css`

- [ ] **Step 1: 启动桌面端并打开设计设置页**

Run:

```bash
pnpm dev:desktop
```

Expected: Electron 正常启动；进入“设置 → 设计”后无渲染报错。

- [ ] **Step 2: 验收宽屏、窄屏和主题状态**

手动或通过浏览器自动化验证：

- 宽屏下代码/画布并排、目录跨列、设计系统/Agent 并排。
- 页面首屏展示内容多于改动前，且所有字段仍可编辑。
- 缩窄内容区后五卡单列；继续缩窄后画布三个字段单列。
- 目录按钮不重叠，长路径不撑破布局。
- 亮色与深色主题中文字、边框、图标底和焦点态清晰。

- [ ] **Step 3: 运行全仓测试作为最终回归**

Run:

```bash
pnpm test
```

Expected: Turbo 全部任务退出 0。

- [ ] **Step 4: 最终提交（仅在视觉验收产生修正时）**

```bash
git add packages/views/cortex-desktop/personal/DesignSettingsSection.tsx packages/views/cortex-desktop/personal/DesignSettingsSection.test.tsx packages/views/cortex-desktop/cortex-desktop.css
git commit -m "fix(views): 收口设计设置页响应式细节"
```
