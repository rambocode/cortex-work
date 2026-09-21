// 个人工作区侧栏项目上下文布局测试：
// - 顶部模式切换承载会话 / 写作 / 设计；
// - 模式行:对话/写作下拉 + 搜索 + 消息铃铛;其下「新对话」整行入口;上下文名直接做会话分组标题(无嵌套卡片);
//   项目管理收进「项目」分组标题的图标入口；
// - 闪记 / Loop / 自动化 入口在滚动区顶部,随会话滚动;底部固定用户行的头像菜单只剩 显示宠物 / 设置。
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore, usePetStore } from "@cortex-work/core";
import { i18nReady } from "@cortex-work/core/i18n";
import type { DesktopBridge, ProjectMeta, SessionMeta } from "@cortex-work/core";
import { PET_ENABLED_KEY } from "../../pet/prefs";
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

// 模式(对话 / 写作)收进顶部下拉:先点开下拉,选项才进 DOM。
function openModeMenu(container: HTMLElement) {
  fireEvent.click(container.querySelector(".pw-sidebar-mode-trigger")!);
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
    openModeMenu(container);
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes).toBeTruthy();
    expect(modes?.textContent).toContain("对话");
    expect(modes?.textContent).toContain("写作");
    expect(modes?.textContent).not.toContain("设计");
    expect(container.querySelector('.pw-project-switcher button[title*="项目管理"]')).toBeTruthy();
  });

  it("点击「会话」触发 openHome（homeOpen=true、writingOpen 复位）", () => {
    // 从写作态起步,验证点击会话确实切回首页并清写作态。
    usePersonalStore.setState({ homeOpen: false, writingOpen: true });
    const { container } = renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    // 写作态下拉标题显示「写作」,点开后选「对话」。
    expect(container.querySelector(".pw-sidebar-mode-trigger")?.textContent).toContain("写作");
    openModeMenu(container);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "对话" }));
    expect(usePersonalStore.getState().homeOpen).toBe(true);
    expect(usePersonalStore.getState().writingOpen).toBe(false);
  });

  it("点击「写作」触发 openWriting（writingOpen=true、homeOpen 清空）", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    openModeMenu(container);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "写作" }));
    expect(usePersonalStore.getState().writingOpen).toBe(true);
    expect(usePersonalStore.getState().homeOpen).toBe(false);
  });

  it("点击「项目管理」调用注入的 onOpenProjectsWindow（不碰 window.desktopAPI）", () => {
    const open = vi.fn();
    renderSidebar(bridgeWith(), { onOpenProjectsWindow: open });
    fireEvent.click(screen.getByTitle(/项目管理/));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("bridge=null（web/旧壳）→ 写作、设计和项目管理降级隐藏，会话仍在", () => {
    const { container } = renderSidebar(null, { onOpenProjectsWindow: () => {} });
    // 只剩「对话」一个模式 → 退化为纯标题,没有下拉触发钮。
    expect(container.querySelector(".pw-sidebar-mode-title")?.textContent).toBe("对话");
    expect(container.querySelector(".pw-sidebar-mode-trigger")).toBeNull();
    expect(screen.queryByText("写作")).toBeNull();
    expect(screen.queryByText("设计")).toBeNull();
    expect(container.querySelector('button[title*="项目管理"]')).toBeNull();
  });

  it("缺任务能力（bridge 无 tasksListProjects）→ 项目管理隐藏，写作仍在（双门控臂一）", () => {
    const { container } = renderSidebar(bridgeWith({ projects: false }), { onOpenProjectsWindow: () => {} });
    openModeMenu(container);
    expect(screen.getByRole("menuitemradio", { name: "写作" })).toBeTruthy();
    expect(container.querySelector('button[title*="项目管理"]')).toBeNull();
  });

  it("缺窗口回调（onOpenProjectsWindow 未注入）→ 项目管理隐藏，写作仍在（双门控臂二）", () => {
    const { container } = renderSidebar(bridgeWith());
    openModeMenu(container);
    expect(screen.getByRole("menuitemradio", { name: "写作" })).toBeTruthy();
    expect(container.querySelector('button[title*="项目管理"]')).toBeNull();
  });

  it("搜索对话在模式行右侧,红绿灯后的侧栏头不再有搜索;新对话为整行入口", () => {
    const { container } = renderSidebar(bridgeWith());
    const head = container.querySelector(".pw-sidebar-head");
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(head?.querySelector('[aria-label="搜索对话"]')).toBeNull();
    expect(modes?.querySelector('[aria-label="搜索对话"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "搜索对话" }));
    expect(useCortexUIStore.getState().sessionSearchOpen).toBe(true);
    useCortexUIStore.setState({ sessionSearchOpen: false });
    expect(container.querySelector(".pw-sidebar-new")?.textContent).toContain("新对话");
  });

  it("项目管理入口位于「项目」分组标题行内", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenProjectsWindow: () => {} });
    const entry = container.querySelector('button[title*="项目管理"]');
    const switcherHead = container.querySelector(".pw-project-switcher .pw-section-h");
    expect(entry).toBeTruthy();
    expect(switcherHead).toBeTruthy();
    expect(switcherHead?.contains(entry)).toBe(true);
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
    openModeMenu(container);
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes).toBeTruthy();
    expect(modes?.textContent).toContain("对话");
    expect(modes?.textContent).toContain("写作");
    expect(modes?.textContent).not.toContain("设计");
  });

  // 闪记 / Loop / 自动化 放在滚动区顶部(对齐 ChatGPT「图像 / 定时任务」),随会话列表滚动;
  // 头像菜单只剩 显示宠物 / 设置,用户行仍固定在滚动区外。
  it("功能入口在滚动区内,头像菜单只留宠物与设置", () => {
    const { container } = renderSidebar(bridgeWith(), { onOpenFlashNote: vi.fn() });
    const scroll = container.querySelector(".pw-sidebar-scroll");
    const nav = container.querySelector(".pw-sidebar-nav");
    expect(scroll?.contains(nav)).toBe(true);
    expect(nav?.textContent).toContain("闪记");
    expect(nav?.textContent).toContain("Loop");
    expect(nav?.textContent).toContain("自动化");

    const userbar = container.querySelector(".pw-sb-userbar");
    expect(scroll?.contains(userbar)).toBe(false);
    fireEvent.click(container.querySelector(".pw-sb-user")!);
    const menu = container.querySelector(".pw-sb-user-menu");
    expect(menu?.textContent).not.toContain("自动化");
    expect(menu?.textContent).toContain("设置");
    expect(menu?.textContent).toContain("显示宠物");
  });

  it("缺能力时隐藏对应功能入口", () => {
    const { container } = renderSidebar(bridgeWith({ automation: false, workflow: false }));
    expect(container.querySelector(".pw-sidebar-nav")?.textContent).toBe("");
  });

  it("点自动化入口打开自动化工作区", () => {
    const { container } = renderSidebar(bridgeWith());
    fireEvent.click(screen.getByRole("button", { name: "自动化" }));
    expect(usePersonalStore.getState().automationOpen).toBe(true);
    expect(container.querySelector(".pw-sidebar-nav .is-active")?.textContent).toBe("自动化");
  });

  // 回归：头像菜单里切「显示宠物」曾只改 petStore 不落盘，重启后被 loadPetEnabled 覆盖回旧值。
  it("头像菜单切换显示宠物时持久化到 localStorage", () => {
    localStorage.removeItem(PET_ENABLED_KEY);
    usePetStore.setState({ enabled: true });
    const { container } = renderSidebar(bridgeWith());

    fireEvent.click(container.querySelector(".pw-sb-user")!);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /显示宠物/ }));
    expect(usePetStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(PET_ENABLED_KEY)).toBe("0");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /显示宠物/ }));
    expect(localStorage.getItem(PET_ENABLED_KEY)).toBe("1");
  });

  // 铃铛切活动视图(对齐 Codex),不依赖消息中心桥能力,缺桥时也可用。
  it("点铃铛切到活动视图:优先级 / 今天分组、两行归属;再点回到项目树", () => {
    const unreadSession = { ...sessionA, id: "unread", title: "未读对话", unread: true, updatedAt: 3 };
    const todaySession = {
      ...sessionA,
      id: "today",
      projectId: undefined,
      title: "今天的聊天",
      updatedAt: Date.now(),
    };
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [unreadSession, todaySession],
      activeProjectId: projectA.id,
      activeSessionId: undefined,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    fireEvent.click(screen.getByRole("button", { name: /查看活动/ }));
    expect(container.querySelector(".pw-project-switcher")).toBeNull();
    const priority = screen.getByRole("region", { name: "优先级" });
    expect(priority.textContent).toContain("未读对话");
    expect(priority.textContent).toContain("cortex-work");
    const today = screen.getByRole("region", { name: "今天" });
    expect(today.textContent).toContain("今天的聊天");
    expect(today.textContent).toContain("聊天");
    fireEvent.click(screen.getByRole("button", { name: /关闭活动视图/ }));
    expect(container.querySelector(".pw-project-switcher")).toBeTruthy();
  });

  it("⌥⌘U / ⌥Ctrl+U 切换活动视图", () => {
    const { container } = renderSidebar(bridgeWith());
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
    fireEvent.keyDown(window, { code: "KeyU", key: "u", altKey: true, metaKey: isMac, ctrlKey: !isMac });
    expect(container.querySelector(".pw-activity-view")).toBeTruthy();
    fireEvent.keyDown(window, { code: "KeyU", key: "u", altKey: true, metaKey: isMac, ctrlKey: !isMac });
    expect(container.querySelector(".pw-activity-view")).toBeNull();
  });

  it("项目树:活动对话所属项目自动展开并显示其对话,其它项目收起", () => {
    usePersonalStore.setState({
      projects: [projectA, projectB],
      sessions: [sessionA],
      activeProjectId: projectB.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    const switcher = container.querySelector(".pw-project-switcher");
    expect(switcher?.textContent).toContain("cortex-work");
    expect(switcher?.textContent).toContain("Tandem");
    expect(switcher?.textContent).toContain("当前项目会话");
    expect(screen.getByRole("button", { name: /cortex-work/, expanded: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tandem/, expanded: false })).toBeTruthy();
    // 旧的「当前项目」顶部分组已并入项目树。
    expect(container.querySelector(".pw-context-sessions")).toBeNull();
  });

  it("点击项目展开 / 收起其下对话,不切换当前对话", () => {
    const tandemSession = { ...sessionA, id: "session-b", projectId: projectB.id, title: "Tandem 对话", updatedAt: 4 };
    usePersonalStore.setState({
      projects: [projectA, projectB],
      sessions: [sessionA, tandemSession],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    renderSidebar(bridgeWith());
    expect(screen.queryByText("Tandem 对话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Tandem/ }));
    expect(screen.getByText("Tandem 对话")).toBeTruthy();
    expect(usePersonalStore.getState().activeSessionId).toBe(sessionA.id);
    // 展开后对话行也含「Tandem」字样,按展开态精确定位项目行。
    fireEvent.click(screen.getByRole("button", { name: /Tandem/, expanded: true }));
    expect(screen.queryByText("Tandem 对话")).toBeNull();
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

    // 删除在「⋯」菜单里,菜单内二次确认。
    fireEvent.click(screen.getByRole("button", { name: /更多操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "确认删除？" }));

    const state = usePersonalStore.getState();
    expect(state.activeSessionId).toBeUndefined();
    expect(state.activeProjectId).toBe(projectA.id);
    // 所属项目仍展开(空态提示新建第一条对话)。
    expect(container.querySelector(".pw-project-switcher")?.textContent).toContain("新建第一条对话");
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

    fireEvent.click(screen.getByRole("button", { name: "待删除无项目会话 更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "确认删除？" }));

    const state = usePersonalStore.getState();
    expect(state.activeSessionId).toBeUndefined();
    expect(state.activeProjectId).toBeUndefined();
    expect(state.sessions.map((session) => session.id)).toEqual([remaining.id]);
    expect(container.querySelector(".pw-project-switcher")?.textContent).toContain("无项目");
    expect(container.querySelector(".pw-project-switcher")?.textContent).toContain("保留无项目会话");
  });

  it("项目行保留「更多」操作入口", () => {
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    const row = container.querySelector(".pw-project-switch-row");
    expect(row?.querySelector('button[title="更多"]')).toBeTruthy();
  });

  it("侧栏不显示已归档对话(也没有显示已归档的切换)", () => {
    const archivedSession = { ...sessionA, id: "archived-session", title: "已归档会话", archivedAt: 10 };
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA, archivedSession],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    renderSidebar(bridgeWith());
    expect(screen.getByText("当前项目会话")).toBeTruthy();
    expect(screen.queryByText("已归档会话")).toBeNull();
    expect(screen.queryByRole("button", { name: /已归档会话/ })).toBeNull();
  });

  it("已归档项目收在底部「已归档」分组,展开后可再展开看对话", () => {
    const archivedProject = { ...projectB, archivedAt: 10 };
    const tandemSession = { ...sessionA, id: "session-b", projectId: projectB.id, title: "Tandem 对话", updatedAt: 4 };
    usePersonalStore.setState({
      projects: [projectA, archivedProject],
      sessions: [sessionA, tandemSession],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    renderSidebar(bridgeWith());
    expect(screen.queryByRole("button", { name: /Tandem/ })).toBeNull();
    fireEvent.click(screen.getByText("已归档 (1)"));
    fireEvent.click(screen.getByRole("button", { name: /Tandem/ }));
    expect(screen.getByText("Tandem 对话")).toBeTruthy();
  });

  it("点击「无项目」展开无项目对话,点对话切换为当前对话", () => {
    const noProject = { ...sessionA, id: "no-project", projectId: undefined, title: "临时会话", updatedAt: 5 };
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA, noProject],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    renderSidebar(bridgeWith());
    expect(screen.queryByText("临时会话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /无项目/ }));
    fireEvent.click(screen.getByText("临时会话"));
    expect(usePersonalStore.getState().activeSessionId).toBe(noProject.id);
  });
});

describe("PersonalSidebar 对话「⋯」菜单 / 置顶 / 未读", () => {
  afterEach(() => cleanup());

  it("悬停操作只有「⋯」与置顶图钉;菜单含 重命名 / 置顶 / 标记为未读 / 归档 / 删除", () => {
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    const actions = container.querySelector(".pw-session-actions");
    expect(actions?.querySelectorAll("button").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "当前项目会话 更多操作" }));
    const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(labels).toEqual(["重命名", "置顶", "标记为未读", "归档", "删除"]);
  });

  it("置顶对话进顶部「置顶」分区且不在项目树重复;取消置顶后回到项目下", () => {
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    fireEvent.click(screen.getByRole("button", { name: "置顶 当前项目会话" }));
    const pinned = container.querySelector(".pw-pinned-section");
    expect(pinned?.textContent).toContain("当前项目会话");
    expect(container.querySelector(".pw-project-switcher")?.textContent).not.toContain("当前项目会话");
    fireEvent.click(screen.getByRole("button", { name: "取消置顶 当前项目会话" }));
    expect(container.querySelector(".pw-pinned-section")).toBeNull();
    expect(container.querySelector(".pw-project-switcher")?.textContent).toContain("当前项目会话");
  });

  it("「置顶」分区只放对话:置顶项目仍在「项目」列表(带图钉),不进置顶分区", () => {
    usePersonalStore.setState({
      projects: [projectA, { ...projectB, pinnedAt: 5 }],
      sessions: [sessionA],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    expect(container.querySelector(".pw-pinned-section")).toBeNull();
    expect(container.querySelector(".pw-project-switcher")?.textContent).toContain("Tandem");
    expect(container.querySelector(".pw-project-switcher .pw-project-pin")).toBeTruthy();
  });

  it("标记为未读显示蓝点;打开该对话后清除", () => {
    const other = { ...sessionA, id: "other", title: "另一个对话", updatedAt: 1 };
    usePersonalStore.setState({
      projects: [projectA],
      sessions: [sessionA, other],
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      homeOpen: false,
    });
    const { container } = renderSidebar(bridgeWith());
    fireEvent.click(screen.getByRole("button", { name: "另一个对话 更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标记为未读" }));
    expect(container.querySelectorAll(".pw-session-unread").length).toBe(1);
    fireEvent.click(screen.getByText("另一个对话"));
    expect(usePersonalStore.getState().sessions.find((x) => x.id === "other")?.unread).toBeUndefined();
    expect(container.querySelector(".pw-session-unread")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: /新对话/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /新对话/ }));
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
    openModeMenu(container);
    const modes = container.querySelector(".pw-sidebar-modes");
    expect(modes?.textContent).not.toContain("研究");
    // 其余模式不受影响。
    expect(modes?.textContent).toContain("对话");
    expect(modes?.textContent).toContain("写作");
  });
});
