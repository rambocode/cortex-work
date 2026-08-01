// 个人工作区侧栏项目上下文布局测试：
// - 顶部模式切换承载会话 / 写作 / 设计；
// - 当前项目卡片承载新建会话 / 项目管理；
// - 底部固定用户行承载头像菜单（闪记 / 自动化 / Loop / 显示宠物 / 设置）与消息铃铛。
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    automationOpen: false,
    workflowOpen: false,
    settingsOpen: false,
  });
});

afterEach(() => cleanup());

describe("PersonalSidebar 模式切换与项目管理", () => {
  it("bridge 完整时渲染会话 / 写作模式且不再暴露独立设计入口", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes).toBeTruthy();
    expect(modes?.textContent).toContain("会话");
    expect(modes?.textContent).toContain("写作");
    expect(modes?.textContent).not.toContain("设计");
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
  it("把会话 / 写作渲染在模式切换区", () => {
    const { container } = renderSidebar(bridgeWith());
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes).toBeTruthy();
    expect(modes?.textContent).toContain("会话");
    expect(modes?.textContent).toContain("写作");
    expect(modes?.textContent).not.toContain("设计");
  });

  // 四个入口已从底部平铺改为收进头像菜单，但「不随会话列表滚走」这条原意图不变：
  // 承载它们的用户行仍须固定在滚动区外。
  it("把用户行固定在滚动区外，四个入口收进头像菜单", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenFlashNote: vi.fn() });
    const userbar = container.querySelector(".pw-sb-userbar");
    expect(userbar).toBeTruthy();
    expect(container.querySelector(".pw-sidebar-scroll")?.contains(userbar)).toBe(false);

    // 收起态不该有这些项（否则等于没收进去）。
    expect(userbar?.textContent).not.toContain("自动化");

    fireEvent.click(container.querySelector(".pw-sb-user")!);
    const menu = container.querySelector(".pw-sb-user-menu");
    expect(menu?.textContent).toContain("闪记");
    expect(menu?.textContent).toContain("自动化");
    expect(menu?.textContent).toContain("Loop");
    expect(menu?.textContent).toContain("设置");
    expect(menu?.textContent).toContain("显示宠物");
  });

  // 铃铛是 desktop-only 能力：桥缺 notificationCenterList（web / 旧壳）时整体隐藏，
  // 而不是渲染一个点了没反应的按钮。
  it("无消息中心桥能力时不渲染铃铛", () => {
    const { container } = renderSidebar(bridgeWith());
    expect(container.querySelector(".pw-sb-bell")).toBeNull();
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

  it("删除当前会话后仍停留在该会话所属项目", () => {
    usePersonalStore.setState({
      projects: [projectA, projectB],
      sessions: [sessionA],
      // 复现状态分叉：侧栏当前上下文以活动会话所属项目 A 为准，
      // activeProjectId 仍保留此前的项目 B。
      activeProjectId: projectB.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());

    fireEvent.click(screen.getByTitle("删除"));
    fireEvent.click(screen.getByTitle("再点确认删除"));

    const state = usePersonalStore.getState();
    expect(state.activeSessionId).toBeUndefined();
    expect(state.activeProjectId).toBe(projectA.id);
    expect(container.querySelector(".pw-context-card")?.textContent).toContain("cortex-work");
  });

  it("删除当前无项目会话后仍停留在无项目会话列表", () => {
    const deleting = {
      ...sessionA,
      id: "no-project-deleting",
      projectId: undefined,
      title: "待删除无项目会话",
      updatedAt: 4,
    };
    const remaining = {
      ...sessionA,
      id: "no-project-remaining",
      projectId: undefined,
      title: "保留无项目会话",
      updatedAt: 3,
    };
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [deleting, remaining],
      // 从项目切到无项目会话时 activeProjectId 会保留，供浮层默认归属使用。
      activeProjectId: projectA.id,
      activeSessionId: deleting.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());

    fireEvent.click(screen.getAllByTitle("删除")[0]!);
    fireEvent.click(screen.getByTitle("再点确认删除"));

    const state = usePersonalStore.getState();
    expect(state.activeSessionId).toBeUndefined();
    expect(state.activeProjectId).toBeUndefined();
    expect(state.sessions.map((session) => session.id)).toEqual([remaining.id]);
    expect(container.querySelector(".pw-context-card")?.textContent).toContain("无项目会话");
    expect(container.querySelector(".pw-context-sessions")?.textContent).toContain("保留无项目会话");
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

// 无项目会话必须带上 noProjectDir —— 它就是 agent 进程的 cwd。漏了的话渲染端算出的 cwd 是空串,
// spawn 便继承 Electron 自己的工作目录:dev 下产物直接写进 apps/desktop/（用户实测：合同审查
// 报告落到了程序目录）。落地页那条创建路径一直有传，侧栏这条漏了。
describe("PersonalSidebar 新建无项目会话带 noProjectDir", () => {
  afterEach(() => cleanup());

  function bridgeWithNoProjectDir(dir = "/Users/me/Documents/cortex/2026-07-28"): DesktopBridge {
    return {
      ...bridgeWith(),
      ensureNoProjectDir: vi.fn(async () => dir),
    } as unknown as DesktopBridge;
  }

  it("无项目上下文点「新建会话」→ 会话带上 ensureNoProjectDir 返回的目录", async () => {
    usePersonalStore.setState({
      projects: [],
      sessions: [],
      activeProjectId: undefined,
      activeSessionId: undefined,
      homeOpen: false,
    });
    const dir = "/Users/me/Documents/cortex/2026-07-28";
    renderSidebar(bridgeWithNoProjectDir(dir));
    fireEvent.click(screen.getByRole("button", { name: /新建会话/ }));
    await waitFor(() => expect(usePersonalStore.getState().sessions).toHaveLength(1));
    const created = usePersonalStore.getState().sessions[0]!;
    expect(created.projectId).toBeUndefined();
    expect(created.noProjectDir).toBe(dir);
  });

  // 有项目时 cwd 用项目 path,不该去建无项目目录。
  it("项目上下文点「新建会话」→ 不调 ensureNoProjectDir", async () => {
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [],
      activeProjectId: projectA.id,
      activeSessionId: undefined,
      homeOpen: false,
    });
    const bridge = bridgeWithNoProjectDir();
    renderSidebar(bridge);
    fireEvent.click(screen.getByRole("button", { name: /新建会话/ }));
    await waitFor(() => expect(usePersonalStore.getState().sessions).toHaveLength(1));
    expect(usePersonalStore.getState().sessions[0]!.projectId).toBe(projectA.id);
    expect(bridge.ensureNoProjectDir).not.toHaveBeenCalled();
  });
});

// 深度研究**已不再是左栏模式**：入口改为会话内的 `/skill:research`（落地页 skill chip + slash 菜单），
// 进度与报告在会话右栏。这里只留一条防回归断言——把按钮加回来是件很顺手的事，
// 而它一旦回来，用户就又有了两条语义不同的研究入口（整窗覆盖层 vs 会话产物）。
describe("PersonalSidebar 不再有深度研究入口", () => {
  /// 造一个带 research 子域的桥（曾经的门控条件之一，现在有它也不该出现按钮）。
  function bridgeWithResearch(): DesktopBridge {
    return { ...bridgeWith(), research: {} } as unknown as DesktopBridge;
  }

  afterEach(() => {
    usePersonalStore.setState((s) => ({
      generalSettings: { ...s.generalSettings, researchEngine: undefined },
    }));
  });

  it("桥有 research 子域且两个研究开关全开时，模式条里也没有「研究」", () => {
    usePersonalStore.setState((s) => ({
      generalSettings: {
        ...s.generalSettings,
        researchEngine: {
          enabled: true,
          deepResearchEnabled: true,
          chatAutoRetrieve: false,
          writingEnabled: false,
          memoryEnabled: false,
          searchBackend: "direct",
        },
      },
    }));
    const { container } = renderSidebar(bridgeWithResearch());
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes?.textContent).not.toContain("研究");
    // 其余模式不受影响。
    expect(modes?.textContent).toContain("会话");
    expect(modes?.textContent).toContain("写作");
  });
});
