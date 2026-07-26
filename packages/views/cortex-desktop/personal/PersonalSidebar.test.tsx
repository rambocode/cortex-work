// 个人工作区侧栏项目上下文布局测试：
// - 顶部模式切换承载会话 / 写作 / 设计；
// - 当前项目卡片承载新建会话 / 项目管理；
// - 底部固定快捷入口承载闪记 / 自动化 / Loop / 设置。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import { i18nReady } from "@cortex-work/core/i18n";
import type { DesktopBridge, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { PersonalSidebar } from "./PersonalSidebar";

// 侧栏渲染只需最小 bridge：探测 editors 用 listEditors（缺则空），其余方法只用于能力门控。
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

beforeAll(async () => {
  await i18nReady;
});

beforeEach(() => {
  // 干净的项目/会话集与视图态,避免上一例残留影响渲染与断言。
  usePersonalStore.setState({
    projects: [],
    sessions: [],
    activeProjectId: undefined,
    activeSessionId: undefined,
    homeOpen: true,
    writingOpen: false,
    designOpen: false,
    // 深度研究整窗覆盖层（P8）：与其它视图同为互斥标志，逐例复位避免串场。
    researchOpen: false,
    automationOpen: false,
    workflowOpen: false,
    settingsOpen: false,
  });
});

afterEach(() => cleanup());

describe("PersonalSidebar 模式切换与项目管理", () => {
  it("bridge 完整时渲染会话 / 写作 / 设计三种模式和项目管理", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes).toBeTruthy();
    expect(modes?.textContent).toContain("会话");
    expect(modes?.textContent).toContain("写作");
    expect(modes?.textContent).toContain("设计");
    expect(container.querySelector(".pw-context-card")?.textContent).toContain("项目管理");
  });

  it("点击「会话」触发 openHome（homeOpen=true、writingOpen 复位）", () => {
    // 从写作态起步,验证点击会话确实切回首页并清写作态。
    usePersonalStore.setState({ homeOpen: false, writingOpen: true });
    renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    fireEvent.click(screen.getByText("会话"));
    expect(usePersonalStore.getState().homeOpen).toBe(true);
    expect(usePersonalStore.getState().writingOpen).toBe(false);
  });

  it("点击「写作」触发 openWriting（writingOpen=true、homeOpen 清空）", () => {
    renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    fireEvent.click(screen.getByText("写作"));
    expect(usePersonalStore.getState().writingOpen).toBe(true);
    expect(usePersonalStore.getState().homeOpen).toBe(false);
  });

  it("点击「项目管理」调用注入的 onOpenProjectsWindow（不碰 window.desktopAPI）", () => {
    const open = vi.fn();
    renderSidebar(bridgeWith(), { onOpenProjectsWindow: open });
    fireEvent.click(screen.getByText("项目管理"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("bridge=null（web/旧壳）→ 写作、设计和项目管理降级隐藏，会话仍在", () => {
    const { container } = renderSidebar(null, { onOpenProjectsWindow: () => {} });
    expect(screen.getByText("会话")).toBeTruthy();
    expect(screen.queryByText("写作")).toBeNull();
    expect(screen.queryByText("设计")).toBeNull();
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes).toBeTruthy();
    expect(modes?.querySelectorAll("button").length).toBe(1);
  });

  it("缺任务能力（bridge 无 tasksListProjects）→ 项目管理隐藏，写作仍在（双门控臂一）", () => {
    const { container } = renderSidebar(bridgeWith({ projects: false }), { onOpenProjectsWindow: () => {} });
    expect(screen.getByText("写作")).toBeTruthy();
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
  });

  it("缺窗口回调（onOpenProjectsWindow 未注入）→ 项目管理隐藏，写作仍在（双门控臂二）", () => {
    const { container } = renderSidebar(bridgeWith());
    expect(screen.getByText("写作")).toBeTruthy();
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
  });

  it("项目管理入口位于当前项目卡片内并早于滚动内容", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    const entry = container.querySelector(".pw-projects-entry");
    const scroll = container.querySelector(".pw-sidebar-scroll");
    const card = container.querySelector(".pw-context-card");
    expect(entry).toBeTruthy();
    expect(scroll).toBeTruthy();
    expect(card).toBeTruthy();
    expect(card?.contains(entry)).toBe(true);
    expect(entry && scroll ? entry.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
  });
});

describe("PersonalSidebar 退役入口", () => {
  it("顶部旧「项目工作台」按钮已退役（不再渲染）", () => {
    renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    expect(screen.queryByTitle(/项目工作台/)).toBeNull();
  });
});

describe("PersonalSidebar 项目上下文结构", () => {
  it("把会话 / 写作 / 设计渲染在模式切换区", () => {
    const { container } = renderSidebar(bridgeWith());
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes).toBeTruthy();
    expect(modes?.textContent).toContain("会话");
    expect(modes?.textContent).toContain("写作");
    expect(modes?.textContent).toContain("设计");
  });

  it("把闪记 / 自动化 / Loop / 设置固定在滚动区外", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenFlashNote: vi.fn() });
    const shortcuts = container.querySelector(".pw-sidebar-shortcuts");
    expect(shortcuts).toBeTruthy();
    expect(shortcuts?.textContent).toContain("闪记");
    expect(shortcuts?.textContent).toContain("自动化");
    expect(shortcuts?.textContent).toContain("Loop");
    expect(shortcuts?.textContent).toContain("设置");
    expect(container.querySelector(".pw-sidebar-scroll")?.contains(shortcuts)).toBe(false);
  });

  it("从活动会话派生当前项目且不在切换列表重复显示", () => {
    usePersonalStore.setState({
      projects: [projectA, projectB],
      sessions: [sessionA],
      activeProjectId: projectB.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    const card = container.querySelector(".pw-context-card");
    const contextSessions = container.querySelector(".pw-context-sessions");
    expect(card).toBeTruthy();
    expect(contextSessions).toBeTruthy();
    expect(card?.textContent).toContain("cortex-work");
    expect(contextSessions?.textContent).toContain("当前项目会话");
    const switcher = container.querySelector(".pw-project-switcher");
    expect(switcher).toBeTruthy();
    expect(switcher?.textContent).toContain("Tandem");
    expect(switcher?.textContent).not.toContain("cortex-work");
  });

  it("当前项目卡片保留项目更多操作入口", () => {
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    const card = container.querySelector(".pw-context-card");
    expect(card).toBeTruthy();
    expect(card?.querySelector('button[title="更多项目操作"]')).toBeTruthy();
  });

  it("当前项目可展开和隐藏已归档会话", () => {
    const archivedSession = { ...sessionA, id: "archived-session", title: "已归档会话", archivedAt: 10 };
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA, archivedSession],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    renderSidebar(bridgeWith());
    expect(screen.queryByText("已归档会话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "显示已归档会话 (1)" }));
    expect(screen.getByText("已归档会话")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "隐藏已归档会话" }));
    expect(screen.queryByText("已归档会话")).toBeNull();
  });

  it("当前项目本身已归档时不在已归档切换组重复出现", () => {
    const archivedProject = { ...projectA, archivedAt: 10 };
    usePersonalStore.setState({
      projects: [archivedProject],
      sessions: [sessionA],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    renderSidebar(bridgeWith());
    expect(screen.queryByText("已归档 (1)")).toBeNull();
  });

  it("点击项目切换项选择该项目最近更新的会话", () => {
    const older = { ...sessionA, id: "session-b-old", projectId: projectB.id, title: "旧 Tandem 会话", updatedAt: 3 };
    const latest = { ...sessionA, id: "session-b-latest", projectId: projectB.id, title: "新 Tandem 会话", updatedAt: 4 };
    usePersonalStore.setState({
      projects: [projectA, projectB],
      sessions: [sessionA, older, latest],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    renderSidebar(bridgeWith());
    fireEvent.click(screen.getByRole("button", { name: /Tandem/ }));
    expect(usePersonalStore.getState().activeSessionId).toBe(latest.id);
  });

  it("点击无项目入口后切换为无项目会话上下文", () => {
    const noProject = { ...sessionA, id: "no-project", projectId: undefined, title: "临时会话", updatedAt: 5 };
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA, noProject],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    fireEvent.click(screen.getByRole("button", { name: /无项目/ }));
    expect(usePersonalStore.getState().activeSessionId).toBe(noProject.id);
    expect(container.querySelector(".pw-context-card")?.textContent).toContain("无项目会话");
  });
});

// 深度研究入口（P8 接线）：双门控 —— 桥有 research 子域 **且** 设置里开了研究引擎。
// 任一不满足都不显示，避免用户点进一个后端没起 Worker 的空壳。
describe("PersonalSidebar 深度研究入口", () => {
  /// 造一个带 research 子域的桥（只需存在性，方法体不会被侧栏调用）。
  function bridgeWithResearch(): DesktopBridge {
    return { ...bridgeWith(), research: {} } as unknown as DesktopBridge;
  }

  /// 写入 researchEngine 设置切片；enabled 决定入口是否出现。
  function setResearchEnabled(enabled: boolean): void {
    usePersonalStore.setState((s) => ({
      generalSettings: {
        ...s.generalSettings,
        researchEngine: {
          enabled,
          deepResearchEnabled: true,
          chatAutoRetrieve: false,
          slidesEnabled: false,
          writingEnabled: false,
          memoryEnabled: false,
          searchBackend: "direct",
        },
      },
    }));
  }

  afterEach(() => {
    usePersonalStore.setState((s) => ({
      generalSettings: { ...s.generalSettings, researchEngine: undefined },
    }));
  });

  it("桥有 research 且设置已启用 → 显示「研究」按钮", () => {
    setResearchEnabled(true);
    const { container } = renderSidebar(bridgeWithResearch());
    expect(container.querySelector(".pw-sidebar-modes")?.textContent).toContain("研究");
  });

  it("桥无 research 子域（旧壳）→ 不显示入口", () => {
    setResearchEnabled(true);
    const { container } = renderSidebar(bridgeWith());
    expect(container.querySelector(".pw-sidebar-modes")?.textContent).not.toContain("研究");
  });

  it("设置未启用研究引擎 → 不显示入口", () => {
    setResearchEnabled(false);
    const { container } = renderSidebar(bridgeWithResearch());
    expect(container.querySelector(".pw-sidebar-modes")?.textContent).not.toContain("研究");
  });

  it("点击「研究」触发 openResearch（researchOpen=true、homeOpen 清空）", () => {
    setResearchEnabled(true);
    renderSidebar(bridgeWithResearch());
    fireEvent.click(screen.getByText("研究"));
    expect(usePersonalStore.getState().researchOpen).toBe(true);
    expect(usePersonalStore.getState().homeOpen).toBe(false);
  });

  it("researchOpen 时「会话」不再高亮（整窗覆盖层已接管主区）", () => {
    setResearchEnabled(true);
    usePersonalStore.setState({ researchOpen: true, homeOpen: false });
    renderSidebar(bridgeWithResearch());
    expect(screen.getByText("会话").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("研究").getAttribute("aria-pressed")).toBe("true");
  });
});
