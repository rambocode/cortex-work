import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { AgentProjectInfo, DesktopBridge, TimelineEvent } from "@cortex-work/core";
import { HomeView } from "./HomeView";

const NOW = Date.now();

// 只实现 HomeView 数据路径用到的桥方法;backfilledAt 已置位 → 不触发历史回填。
function fakeBridge(
  eventsByProject: Record<string, TimelineEvent[]>,
  scanned: AgentProjectInfo[] = [],
): DesktopBridge {
  return {
    loadTimeline: async (projectId: string) => ({
      version: 1,
      backfilledAt: 1,
      events: eventsByProject[projectId] ?? [],
    }),
    saveTimeline: async () => {},
    loadChat: async () => [],
    scanAgentProjects: async () => scanned,
  } as unknown as DesktopBridge;
}

function renderHome(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <HomeView onToast={() => {}} />
    </CoreProvider>,
  );
}

describe("HomeView", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: true,
      timelineProjectId: undefined,
      activeSessionId: undefined,
      projects: [
        { id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW - 86400_000 },
        { id: "p2", name: "beta", path: "/code/beta", addedAt: NOW - 86400_000 },
      ],
      sessions: [
        { id: "s1", projectId: "p1", title: "Session 1", agent: "claude", createdAt: NOW, updatedAt: NOW },
      ],
    });
  });

  it("渲染三个区块,聚合所有项目当天统计", async () => {
    renderHome(
      fakeBridge({
        p1: [{ id: "e1", projectId: "p1", ts: NOW, kind: "run", title: "修复登录" }],
        p2: [{ id: "e2", projectId: "p2", ts: NOW, kind: "run", title: "加测试" }],
      }),
    );

    expect(screen.getByText("活动热力图")).toBeInTheDocument();
    expect(screen.getByText("一日总结 · 所有项目")).toBeInTheDocument();
    // 两个项目的事件都聚合进当天统计（chips 在 bridge 数据 resolve 后出现）。
    expect(await screen.findByText("2 个项目")).toBeInTheDocument();
    expect(screen.getByText("2 轮交互")).toBeInTheDocument();
    // 项目列表两行都在（标题 chips 区域也会出现项目名,用 row 类断言列表）。
    expect(screen.getByTitle("/code/alpha")).toBeInTheDocument();
    expect(screen.getByTitle("/code/beta")).toBeInTheDocument();
  });

  it("检索框按名称过滤项目", async () => {
    renderHome(fakeBridge({}));
    await screen.findByTitle("/code/alpha");

    fireEvent.change(screen.getByPlaceholderText(/检索项目/), { target: { value: "beta" } });
    expect(screen.queryByTitle("/code/alpha")).toBeNull();
    expect(screen.getByTitle("/code/beta")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/检索项目/), { target: { value: "zzz" } });
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
  });

  it("点击有 Session 的项目跳到最近 Session,无 Session 的打开时间线", async () => {
    renderHome(fakeBridge({}));

    fireEvent.click(await screen.findByTitle("/code/alpha"));
    expect(usePersonalStore.getState().activeSessionId).toBe("s1");
    expect(usePersonalStore.getState().homeOpen).toBe(false);

    usePersonalStore.setState({ homeOpen: true });
    fireEvent.click(screen.getByTitle("/code/beta"));
    expect(usePersonalStore.getState().timelineProjectId).toBe("p2");
  });

  it("系统扫描项目并入列表:带 agent 圆点与未添加徽标,与工作区项目按 path 去重", async () => {
    renderHome(
      fakeBridge({}, [
        // /code/alpha 已在工作区 → 合并不重复,agents 并集补 codex
        { path: "/code/alpha", name: "alpha", agents: ["codex"], lastActive: NOW },
        { path: "/code/gamma", name: "gamma", agents: ["claude", "codex"], lastActive: NOW - 60_000 },
      ]),
    );

    // 扫描行出现且带未添加徽标。
    expect(await screen.findByTitle(/\/code\/gamma/)).toBeInTheDocument();
    expect(screen.getByText("未添加")).toBeInTheDocument();
    // alpha 不重复（仍只有一行,title 为工作区形态的纯路径）。
    expect(screen.getAllByTitle(/\/code\/alpha/)).toHaveLength(1);
    // gamma 行有两个 agent 圆点。
    const gammaRow = screen.getByTitle(/\/code\/gamma/);
    expect(gammaRow.querySelectorAll(".pw-agent-dot")).toHaveLength(2);
    expect(gammaRow.querySelector('.pw-agent-dot[data-agent="codex"]')).not.toBeNull();
  });

  it("点击未添加的扫描项目将其加入工作区", async () => {
    renderHome(fakeBridge({}, [{ path: "/code/gamma", name: "gamma", agents: ["claude"], lastActive: NOW }]));

    fireEvent.click(await screen.findByTitle(/\/code\/gamma/));
    const added = usePersonalStore.getState().projects.find((p) => p.path === "/code/gamma");
    expect(added).toBeTruthy();
    expect(added?.name).toBe("gamma");
  });

  it("工作区为空时仍渲染首页,列出扫描项目供添加", async () => {
    usePersonalStore.setState({ projects: [], sessions: [] });
    renderHome(fakeBridge({}, [{ path: "/code/gamma", name: "gamma", agents: ["claude"], lastActive: NOW }]));
    expect(screen.getByText("活动热力图")).toBeInTheDocument();
    expect(await screen.findByTitle(/\/code\/gamma/)).toBeInTheDocument();
  });
});
