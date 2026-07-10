# Personal Sidebar Project Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将个人工作区左侧栏重构为“工作模式 → 当前项目 → 当前会话 → 项目切换 → 固定快捷入口”的项目上下文布局。

**Architecture:** 不增加 store、IPC 或持久化状态；当前上下文完全由 `activeSessionId`、`activeProjectId`、`projects` 和 `sessions` 派生。`PersonalSidebar` 负责上下文编排，现有 `SessionList` 继续负责会话行为，`SettingsMenu` 增加快捷入口展示变体，CSS 将唯一滚动区限制在中部内容。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、Testing Library、共享 CSS design tokens、Electron desktop shell。

---

## File Map

- Modify: `packages/views/cortex-desktop/personal/PersonalSidebar.tsx`
  - 派生当前项目上下文，渲染模式切换、当前项目卡片、当前会话、项目切换列表和固定快捷入口。
- Modify: `packages/views/cortex-desktop/personal/SettingsMenu.tsx`
  - 保留默认行式入口，同时支持底部快捷入口变体与 `settingsOpen` 选中态。
- Modify: `packages/views/cortex-desktop/cortex-desktop.css`
  - 删除旧顶部/底部布局规则，新增项目上下文层级、唯一滚动区和固定快捷入口样式。
- Modify: `packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx`
  - 覆盖模式门控、当前项目派生、项目切换、无项目上下文和固定快捷入口。
- Modify: `packages/views/cortex-desktop/personal/SettingsMenu.test.tsx`
  - 覆盖快捷入口变体及设置选中态。

### Task 1: 用组件测试锁定新的侧栏结构

**Files:**
- Modify: `packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx`

- [ ] **Step 1: 扩充测试桥接和渲染参数**

将测试 helper 改为显式控制项目管理、自动化和 Loop 能力，并允许传入闪记回调：

```tsx
function bridgeWith({
  projects = true,
  automation = true,
  workflow = true,
}: {
  projects?: boolean;
  automation?: boolean;
  workflow?: boolean;
} = {}): DesktopBridge {
  return {
    listEditors: async () => [],
    pickDirectory: async () => null,
    ...(projects ? { tasksListProjects: async () => [] } : {}),
    ...(automation ? { automationList: async () => [] } : {}),
    ...(workflow ? { workflowList: async () => [] } : {}),
  } as unknown as DesktopBridge;
}

function renderSidebar(
  bridge: DesktopBridge | null,
  options: { onOpenProjectsWindow?: () => void; onOpenFlashNote?: () => void } = {},
) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PersonalSidebar
        onToast={() => {}}
        onOpenProjectsWindow={options.onOpenProjectsWindow}
        onOpenFlashNote={options.onOpenFlashNote}
      />
    </CoreProvider>,
  );
}
```

同时将现有调用统一替换：`bridgeWith(true)` 改为 `bridgeWith()`，`bridgeWith(false)` 改为 `bridgeWith({ projects: false })`；原第二参数回调改为 `{ onOpenProjectsWindow: callback }`，保证旧用例在 helper 签名变化后仍能编译。

- [ ] **Step 2: 为模式切换和固定快捷入口写失败测试**

```tsx
it("把会话 / 写作 / 设计渲染在模式切换区", () => {
  const { container } = renderSidebar(bridgeWith());
  const modes = container.querySelector(".pw-sidebar-modes")!;
  expect(modes.textContent).toContain("会话");
  expect(modes.textContent).toContain("写作");
  expect(modes.textContent).toContain("设计");
});

it("把闪记 / 自动化 / Loop / 设置固定在底部快捷入口区", () => {
  const { container } = renderSidebar(bridgeWith(), { onOpenFlashNote: vi.fn() });
  const shortcuts = container.querySelector(".pw-sidebar-shortcuts")!;
  expect(shortcuts.textContent).toContain("闪记");
  expect(shortcuts.textContent).toContain("自动化");
  expect(shortcuts.textContent).toContain("Loop");
  expect(shortcuts.textContent).toContain("设置");
  expect(container.querySelector(".pw-sidebar-scroll")!.contains(shortcuts)).toBe(false);
});

it("缺少桥接能力时隐藏对应模式和快捷入口并保留设置", () => {
  const { container } = renderSidebar(null);
  expect(container.querySelector(".pw-sidebar-modes")!.textContent).toBe("会话");
  const shortcuts = container.querySelector(".pw-sidebar-shortcuts")!;
  expect(shortcuts.textContent).toBe("设置");
});
```

- [ ] **Step 3: 为当前项目和项目切换写失败测试**

在测试文件中导入 `ProjectMeta`、`SessionMeta`，加入固定 fixture：

```tsx
const projectA: ProjectMeta = {
  id: "project-a",
  name: "cortex-work",
  path: "/tmp/cortex-work",
  addedAt: 1,
};
const projectB: ProjectMeta = {
  id: "project-b",
  name: "Tandem",
  path: "/tmp/Tandem",
  addedAt: 2,
};
const sessionA: SessionMeta = {
  id: "session-a",
  projectId: projectA.id,
  title: "当前项目会话",
  agent: "codex",
  createdAt: 1,
  updatedAt: 2,
};
```

```tsx
it("从活动会话派生当前项目且不在切换列表重复显示", () => {
  usePersonalStore.setState({
    projects: [projectA, projectB],
    sessions: [sessionA],
    activeProjectId: projectB.id,
    activeSessionId: sessionA.id,
    homeOpen: false,
  });
  const { container } = renderSidebar(bridgeWith());
  expect(container.querySelector(".pw-context-card")!.textContent).toContain("cortex-work");
  expect(container.querySelector(".pw-context-sessions")!.textContent).toContain("当前项目会话");
  const switcher = container.querySelector(".pw-project-switcher")!;
  expect(switcher.textContent).toContain("Tandem");
  expect(switcher.textContent).not.toContain("cortex-work");
});

it("点击项目切换项选择其最近会话", () => {
  const sessionB = { ...sessionA, id: "session-b", projectId: projectB.id, title: "Tandem 会话", updatedAt: 3 };
  usePersonalStore.setState({
    projects: [projectA, projectB],
    sessions: [sessionA, sessionB],
    activeProjectId: projectA.id,
    activeSessionId: sessionA.id,
    homeOpen: false,
  });
  renderSidebar(bridgeWith());
  fireEvent.click(screen.getByRole("button", { name: /Tandem/ }));
  expect(usePersonalStore.getState().activeSessionId).toBe(sessionB.id);
});
```

- [ ] **Step 4: 运行测试并确认失败原因正确**

Run:

```bash
pnpm --filter @cortex-work/views test -- PersonalSidebar.test.tsx
```

Expected: FAIL，缺少 `.pw-sidebar-modes`、`.pw-context-card`、`.pw-sidebar-shortcuts` 等新结构；不得出现测试环境或类型错误。

- [ ] **Step 5: 提交测试基线**

```bash
git add packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx
git commit -m "test(sidebar): 锁定项目上下文布局"
```

### Task 2: 实现当前项目上下文和模式切换

**Files:**
- Modify: `packages/views/cortex-desktop/personal/PersonalSidebar.tsx`

- [ ] **Step 1: 增加当前上下文所需的 store selectors**

在 `PersonalSidebar` 中补充现有 selector：

```tsx
const activeProjectId = usePersonalStore((s) => s.activeProjectId);
const createSession = usePersonalStore((s) => s.createSession);
const activateProject = usePersonalStore((s) => s.activateProject);
const settingsOpen = usePersonalStore((s) => s.settingsOpen);
const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
const generalSettings = usePersonalStore((s) => s.generalSettings);
const setRightView = usePersonalStore((s) => s.setRightView);
const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
```

替换旧顶部导航时同时删除不再使用的 `homeOpen` selector；`conversationModeOpen` 取代它驱动“会话”模式选中态。

- [ ] **Step 2: 派生当前项目、当前会话和切换列表**

放在 `partitionProjects(projects)` 与 `pickProject` 之间：

```tsx
const activeSession = sessions.find((session) => session.id === activeSessionId);
const contextProjectId = activeSession ? activeSession.projectId : activeProjectId;
const contextProject = projects.find((project) => project.id === contextProjectId);
const contextIsNoProject = Boolean(activeSession && !activeSession.projectId);
const contextSessions = sessions
  .filter((session) => {
    if (session.archivedAt != null) return false;
    if (contextProject) return session.projectId === contextProject.id;
    return contextIsNoProject && !session.projectId;
  })
  .sort((a, b) => b.updatedAt - a.updatedAt);
const projectChoices = visible.filter((project) => project.id !== contextProject?.id);
const defaultAgent = resolveDefaultAgent({ generalSettings, agentsAvailable });
const conversationModeOpen = !writingOpen && !designOpen && !automationOpen && !workflowOpen && !settingsOpen;

const createContextSession = () => {
  createSession(contextProject?.id, defaultAgent);
  onToast(contextProject ? `已在 ${contextProject.name} 新建 Session` : "已新建无项目 Session");
};

const openProject = (project: ProjectMeta) => {
  const latest = sessions
    .filter((session) => session.projectId === project.id && session.archivedAt == null)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (latest) {
    setActiveSession(latest.id);
    return;
  }
  activateProject(project.id);
  setRightView("todos");
  setRightOpen(true);
};
```

- [ ] **Step 3: 用三段式模式切换替换旧顶部导航**

删除 `WorkspaceTabs` 和 `.pw-top-nav-row` 旧入口，渲染：

```tsx
<div className="pw-sidebar-modes" aria-label="工作模式">
  <button className={conversationModeOpen ? "is-active" : ""} onClick={openHome}>会话</button>
  {bridge ? (
    <button className={writingOpen ? "is-active" : ""} onClick={openWriting}>写作</button>
  ) : null}
  {bridge ? (
    <button className={designOpen ? "is-active" : ""} onClick={() => openDesign()}>设计</button>
  ) : null}
</div>
```

- [ ] **Step 4: 渲染当前项目卡片与当前会话区**

```tsx
<section className="pw-context-card" aria-label="当前项目">
  <div className="pw-context-card-title">
    <Icon.Folder size={15} />
    <strong>{contextProject?.name ?? (contextIsNoProject ? "无项目会话" : "选择一个项目开始")}</strong>
    {contextProject ? <span>当前项目</span> : null}
  </div>
  <div className="pw-context-card-actions">
    <button className="is-primary" onClick={createContextSession}>
      <Icon.Plus size={13} /> 新建会话
    </button>
    {bridge?.tasksListProjects && onOpenProjectsWindow ? (
      <button onClick={onOpenProjectsWindow}>
        <Icon.Folder size={13} /> 项目管理
      </button>
    ) : null}
  </div>
</section>

<div className="pw-sidebar-scroll">
  <section className="pw-context-sessions">
    <div className="pw-section-h"><span>当前项目会话</span></div>
    {contextSessions.length ? (
      <SessionList sessions={contextSessions} activeSessionId={activeSessionId} onSelect={setActiveSession} onToast={onToast} />
    ) : (
      <button className="pw-context-empty" onClick={createContextSession}>＋ 新建第一条会话</button>
    )}
  </section>
  {/* Task 3 在这里加入项目切换列表 */}
</div>
```

- [ ] **Step 5: 运行当前结构测试**

Run:

```bash
pnpm --filter @cortex-work/views test -- PersonalSidebar.test.tsx
```

Expected: 模式切换、当前卡片和当前会话用例 PASS；项目切换和快捷入口用例仍 FAIL。

- [ ] **Step 6: 提交当前上下文骨架**

```bash
git add packages/views/cortex-desktop/personal/PersonalSidebar.tsx packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx
git commit -m "feat(sidebar): 增加当前项目上下文"
```

### Task 3: 实现项目切换列表并保留项目操作

**Files:**
- Modify: `packages/views/cortex-desktop/personal/PersonalSidebar.tsx`
- Test: `packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx`

- [ ] **Step 1: 将 `ProjectBlock` 收敛为不展开会话的 `ProjectSwitchRow`**

保留 `ProjectMenu`、归档标记和 hover 操作，但项目行不再嵌套 `SessionList`：

```tsx
function ProjectSwitchRow({
  project,
  archived,
  editors,
  onOpen,
  onToast,
}: {
  project: ProjectMeta;
  archived: boolean;
  editors: EditorInfo[];
  onOpen: () => void;
  onToast: (text: string) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const createSession = usePersonalStore((s) => s.createSession);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  return (
    <div className="pw-project-switch-row">
      <button className="pw-project-switch-main" onClick={onOpen} title={project.path}>
        <Icon.Folder size={14} />
        <span>{project.name}</span>
        {project.pinnedAt ? <Icon.Pin size={11} /> : null}
      </button>
      <div className={menuAnchor ? "pw-project-actions is-menu-open" : "pw-project-actions"}>
        <button
          className="pw-icon-btn"
          title="更多"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenuAnchor({ x: rect.right, y: rect.bottom + 4 });
          }}
        ><Icon.More size={13} /></button>
        <button
          className="pw-icon-btn"
          title="新建 Session"
          onClick={() => createSession(project.id, resolveDefaultAgent({ generalSettings, agentsAvailable }))}
        ><Icon.Plus size={13} /></button>
      </div>
      {menuAnchor ? (
        <ProjectMenu project={project} archived={archived} editors={editors} anchor={menuAnchor} onClose={() => setMenuAnchor(null)} onToast={onToast} />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: 在滚动区渲染项目切换、归档和无项目入口**

```tsx
<section className="pw-project-switcher">
  <div className="pw-section-h">
    <span>切换项目</span>
    <button className="pw-icon-btn" title="添加项目（选择本地文件夹）" onClick={pickProject} disabled={!bridge}>
      <Icon.FolderPlus size={14} />
    </button>
  </div>
  {projectChoices.map((project) => (
    <ProjectSwitchRow key={project.id} project={project} archived={false} editors={editors} onOpen={() => openProject(project)} onToast={onToast} />
  ))}
  {noProjectSessions.length > 0 && !contextIsNoProject ? (
    <button className="pw-project-switch-main pw-no-project-switch" onClick={() => setActiveSession(noProjectSessions[0]!.id)}>
      <Icon.File size={14} /><span>无项目</span><small>{noProjectSessions.length}</small>
    </button>
  ) : null}
  {archived.length > 0 ? (
    <div className="pw-archived-group">
      <button className="pw-archived-h" data-collapsed={!archivedOpen} onClick={() => setArchivedOpen((value) => !value)}>
        <span className="chev"><Icon.Chevron size={10} /></span>
        <span>已归档 ({archived.length})</span>
      </button>
      {archivedOpen ? archived.map((project) => (
        <ProjectSwitchRow key={project.id} project={project} archived editors={editors} onOpen={() => openProject(project)} onToast={onToast} />
      )) : null}
    </div>
  ) : null}
</section>
```

- [ ] **Step 3: 增加无项目上下文测试**

```tsx
it("选择无项目入口后显示无项目会话上下文", () => {
  const noProject = { ...sessionA, id: "no-project", projectId: undefined, title: "临时会话" };
  usePersonalStore.setState({ projects: [projectA], sessions: [sessionA, noProject], activeSessionId: sessionA.id });
  renderSidebar(bridgeWith());
  fireEvent.click(screen.getByRole("button", { name: /无项目/ }));
  expect(usePersonalStore.getState().activeSessionId).toBe(noProject.id);
  expect(screen.getByText("无项目会话")).toBeTruthy();
});
```

- [ ] **Step 4: 运行项目切换测试**

Run:

```bash
pnpm --filter @cortex-work/views test -- PersonalSidebar.test.tsx
```

Expected: 除固定快捷入口相关测试外全部 PASS。

- [ ] **Step 5: 提交项目切换实现**

```bash
git add packages/views/cortex-desktop/personal/PersonalSidebar.tsx packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx
git commit -m "feat(sidebar): 增加项目切换列表"
```

### Task 4: 实现固定快捷入口和设置变体

**Files:**
- Modify: `packages/views/cortex-desktop/personal/PersonalSidebar.tsx`
- Modify: `packages/views/cortex-desktop/personal/SettingsMenu.tsx`
- Modify: `packages/views/cortex-desktop/personal/SettingsMenu.test.tsx`

- [ ] **Step 1: 为 `SettingsMenu` 快捷入口变体写失败测试**

```tsx
it("shortcut 变体使用底部快捷入口样式并反映设置打开态", () => {
  usePersonalStore.setState({ settingsOpen: true });
  const { container } = renderUI(<SettingsMenu variant="shortcut" />);
  const button = screen.getByRole("button", { name: "设置" });
  expect(button.classList.contains("pw-sidebar-shortcut")).toBe(true);
  expect(button.classList.contains("is-active")).toBe(true);
  expect(container.querySelector(".sb-foot")).toBeNull();
});
```

- [ ] **Step 2: 实现 `SettingsMenu` 的快捷入口变体**

```tsx
export function SettingsMenu({ variant = "row" }: { variant?: "row" | "shortcut" }) {
  const { t } = useTranslation();
  const openSettings = usePersonalStore((s) => s.openSettings);
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  if (variant === "shortcut") {
    return (
      <button
        className={`pw-sidebar-shortcut ${settingsOpen ? "is-active" : ""}`}
        onClick={() => openSettings()}
        aria-label={t("sidebar.settings")}
      >
        <Icon.Settings size={15} />
        <span>{t("sidebar.settings")}</span>
      </button>
    );
  }
  return (
    <div className="sb-foot">
      <button className="sb-row is-mute" onClick={() => openSettings()}>
        <Icon.Settings size={15} />
        <span className="label">{t("sidebar.settings")}</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 3: 在 `PersonalSidebar` 底部渲染能力门控快捷入口**

删除旧的独立闪记、自动化、Loop 和 footer，渲染：

```tsx
<div className="pw-sidebar-shortcuts" aria-label="快捷入口">
  {onOpenFlashNote ? (
    <button className="pw-sidebar-shortcut" onClick={onOpenFlashNote} aria-label="闪记">
      <Icon.Pin size={15} /><span>闪记</span>
    </button>
  ) : null}
  {bridge?.automationList ? (
    <button className={`pw-sidebar-shortcut ${automationOpen ? "is-active" : ""}`} onClick={openAutomation} aria-label="自动化">
      <Icon.Workflow size={15} /><span>自动化</span>
    </button>
  ) : null}
  {bridge?.workflowList ? (
    <button className={`pw-sidebar-shortcut ${workflowOpen ? "is-active" : ""}`} onClick={openWorkflow} aria-label="Loop">
      <Icon.GitBranch size={15} /><span>Loop</span>
    </button>
  ) : null}
  <SettingsMenu variant="shortcut" />
</div>
```

- [ ] **Step 4: 运行两个组件测试文件**

Run:

```bash
pnpm --filter @cortex-work/views test -- PersonalSidebar.test.tsx SettingsMenu.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 提交固定快捷入口**

```bash
git add packages/views/cortex-desktop/personal/PersonalSidebar.tsx packages/views/cortex-desktop/personal/SettingsMenu.tsx packages/views/cortex-desktop/personal/SettingsMenu.test.tsx packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx
git commit -m "feat(sidebar): 固定全局快捷入口"
```

### Task 5: 完成视觉层级和滚动布局

**Files:**
- Modify: `packages/views/cortex-desktop/cortex-desktop.css`

- [ ] **Step 1: 删除已退役布局规则**

删除不再使用的 `.pw-top-nav-row`、`.pw-footer-row`、`.pw-sidebar-footer` 及其子选择器；保留通用 `.pw-home-btn`，避免影响其他个人工作区页面。

- [ ] **Step 2: 增加模式切换和当前项目卡片样式**

```css
.pw-sidebar-modes {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 3px;
  margin: 8px 10px 10px;
  padding: 3px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--text-1) 6%, transparent);
}
.pw-sidebar-modes button {
  min-width: 0;
  padding: 7px 6px;
  border-radius: 7px;
  color: var(--text-3);
  font-size: 12px;
}
.pw-sidebar-modes button:hover { color: var(--text-1); }
.pw-sidebar-modes button.is-active {
  color: var(--text-1);
  background: var(--bg-app);
  box-shadow: 0 1px 3px rgba(20, 18, 12, 0.08);
  font-weight: 600;
}
.pw-context-card {
  margin: 0 10px 8px;
  padding: 11px;
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-card) 84%, transparent);
  box-shadow: 0 5px 16px rgba(20, 18, 12, 0.04);
}
.pw-context-card-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
.pw-context-card-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.pw-context-card-title > span { margin-left: auto; flex: none; padding: 2px 7px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-size: 10px; font-weight: 600; }
.pw-context-card-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px; margin-top: 10px; }
.pw-context-card-actions button { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 32px; border-radius: 8px; background: var(--bg-card-2); color: var(--text-2); font-size: 11.5px; }
.pw-context-card-actions button.is-primary { background: var(--accent); color: #fff; }
```

- [ ] **Step 3: 限定唯一滚动区并统一项目切换行**

```css
.pw-sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
.pw-context-empty { margin: 2px 14px 8px; color: var(--text-4); font-size: 11.5px; }
.pw-context-empty:hover { color: var(--text-2); }
.pw-project-switch-row { position: relative; display: flex; align-items: center; margin: 1px 6px; border-radius: 8px; }
.pw-project-switch-row:hover { background: var(--bg-hover); }
.pw-project-switch-main { min-width: 0; flex: 1; display: flex; align-items: center; gap: 7px; padding: 7px 8px; color: var(--text-2); text-align: left; }
.pw-project-switch-main > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-project-switch-main small { margin-left: auto; color: var(--text-4); }
.pw-project-switch-row .pw-project-actions { padding-right: 4px; }
.pw-project-switch-row:hover .pw-project-actions { opacity: 1; }
```

- [ ] **Step 4: 增加固定快捷入口和可访问状态样式**

```css
.pw-sidebar-shortcuts {
  flex: none;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 5px;
  padding: 9px 10px 10px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-sidebar) 88%, transparent);
  backdrop-filter: blur(16px);
}
.pw-sidebar-shortcut {
  min-width: 0;
  min-height: 42px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--text-3);
  font-size: 10.5px;
}
.pw-sidebar-shortcut:hover { color: var(--text-1); background: var(--bg-hover); }
.pw-sidebar-shortcut.is-active { color: var(--text-1); background: var(--bg-active); border-color: var(--border-soft); }
.pw-sidebar-modes button:focus-visible,
.pw-context-card-actions button:focus-visible,
.pw-project-switch-main:focus-visible,
.pw-sidebar-shortcut:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .pw-sidebar-modes button,
  .pw-project-switch-row,
  .pw-sidebar-shortcut { transition: none; }
}
```

- [ ] **Step 5: 运行组件测试和静态检查**

Run:

```bash
pnpm --filter @cortex-work/views test -- PersonalSidebar.test.tsx SettingsMenu.test.tsx
pnpm --filter @cortex-work/views typecheck
pnpm --filter @cortex-work/views lint
git diff --check
```

Expected: 全部命令退出码为 0。

- [ ] **Step 6: 提交视觉样式**

```bash
git add packages/views/cortex-desktop/cortex-desktop.css
git commit -m "style(sidebar): 强化项目上下文层级"
```

### Task 6: 桌面端界面验收与回归

**Files:**
- Modify only if verification exposes a defect in the files listed above.

- [ ] **Step 1: 启动桌面端并打开个人工作区**

Run:

```bash
pnpm dev:desktop
```

Expected: Electron 窗口正常启动，个人工作区左侧栏显示新结构，无控制台渲染错误。

- [ ] **Step 2: 验证正常高度和矮窗口**

手动或通过桌面自动化检查：

- 当前模式、当前项目卡片和固定快捷入口始终可见。
- 项目/会话增多时只有 `.pw-sidebar-scroll` 滚动。
- 底部“设置”始终可点击，快捷入口没有文字裁切或重叠。

- [ ] **Step 3: 验证真实状态**

依次检查：0 个项目、多个项目、长项目名、当前项目超过 5 条会话、无项目会话、归档项目；确认项目切换、会话归档/删除、闪记、自动化、Loop、设置均可达。

- [ ] **Step 4: 验证主题和侧栏生命周期**

检查浅色、深色和现有调色板；折叠并恢复侧栏，确认 macOS 红绿灯与 `SidebarLeftControls` 对齐不回归。

- [ ] **Step 5: 运行最终回归**

Run:

```bash
pnpm --filter @cortex-work/views test
pnpm --filter @cortex-work/views typecheck
pnpm --filter @cortex-work/views lint
git diff --check
git status --short
```

Expected: 测试、类型检查、lint 和 diff 检查通过；`git status --short` 仅显示预期文件或为空，不包含 `.superpowers/` 视觉伴侣产物。

- [ ] **Step 6: 提交验收修正（仅有修正时）**

```bash
git add packages/views/cortex-desktop/personal/PersonalSidebar.tsx packages/views/cortex-desktop/personal/SettingsMenu.tsx packages/views/cortex-desktop/personal/PersonalSidebar.test.tsx packages/views/cortex-desktop/personal/SettingsMenu.test.tsx packages/views/cortex-desktop/cortex-desktop.css
git commit -m "fix(sidebar): 完成桌面界面验收修正"
```
