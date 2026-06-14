import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, usePersonalStore, useCortexUIStore } from "@cortex-work/core";
import type { DesktopBridge, TaskFilesResult, TimelineEvent } from "@cortex-work/core";
import { HomeView } from "./HomeView";

const NOW = Date.now();

// 只实现 HomeBoard 数据路径用到的桥方法。
// - loadTimeline：热力图/一日总结聚合（backfilledAt 已置位 → 不触发历史回填）。
// - listTaskFiles：跨项目 Tasks 聚合（useAllProjectsTasks 按 project.path 并行拉取）。
function fakeBridge(
  eventsByProject: Record<string, TimelineEvent[]>,
  tasksByPath: Record<string, TaskFilesResult> = {},
): DesktopBridge {
  return {
    loadTimeline: async (projectId: string) => ({
      version: 1,
      backfilledAt: 1,
      events: eventsByProject[projectId] ?? [],
    }),
    saveTimeline: async () => {},
    loadChat: async () => [],
    listTaskFiles: async (root: string) => tasksByPath[root] ?? { files: [], archived: [] },
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
      activeProjectId: undefined,
      taskDetailRequest: undefined,
      rightView: "files",
      projects: [
        { id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW - 86400_000 },
        { id: "p2", name: "beta", path: "/code/beta", addedAt: NOW - 86400_000 },
      ],
      sessions: [
        { id: "s1", projectId: "p1", title: "Session 1", agent: "claude", createdAt: NOW, updatedAt: NOW },
      ],
    });
    useCortexUIStore.setState({ rightOpen: false });
  });

  it("渲染三个区块,不再有「Agent 项目」检索", async () => {
    renderHome(fakeBridge({}));
    expect(screen.getByText("活动热力图")).toBeInTheDocument();
    expect(screen.getByText("一日总结 · 所有项目")).toBeInTheDocument();
    expect(screen.getByText("Tasks · 所有项目")).toBeInTheDocument();
    // 「Agent 项目」检索区已移除。
    expect(screen.queryByText("Agent 项目")).toBeNull();
    expect(screen.queryByPlaceholderText(/检索项目/)).toBeNull();
    // flush 跨项目 tasks 的异步 query。
    await screen.findByText("还没有 Task");
  });

  it("热力图/一日总结聚合所有可见项目当天统计", async () => {
    renderHome(
      fakeBridge({
        p1: [{ id: "e1", projectId: "p1", ts: NOW, kind: "run", title: "修复登录" }],
        p2: [{ id: "e2", projectId: "p2", ts: NOW, kind: "run", title: "加测试" }],
      }),
    );
    // 两个项目的事件都聚合进当天统计（chips 在 bridge 数据 resolve 后出现）。
    expect(await screen.findByText("2 个项目")).toBeInTheDocument();
    expect(screen.getByText("2 轮交互")).toBeInTheDocument();
  });

  it("Tasks 区列出跨项目 md 文件,按 mtime 全局降序", async () => {
    renderHome(
      fakeBridge(
        {},
        {
          "/code/alpha": {
            files: [{ name: "older.md", path: "/code/alpha/tasks/older.md", mtimeMs: NOW - 10_000 }],
            archived: [],
          },
          "/code/beta": {
            files: [{ name: "newest.md", path: "/code/beta/tasks/newest.md", mtimeMs: NOW }],
            archived: [],
          },
        },
      ),
    );
    // 两个文件都出现（去掉 .md 后缀）。
    expect(await screen.findByText("newest")).toBeInTheDocument();
    expect(screen.getByText("older")).toBeInTheDocument();
    // 在 Tasks 区内按行断言文件名 + 所属项目名（弱化展示）;不用 getByText 查项目名,
    // 因「一日总结」的项目 chips 也含项目名会歧义。全局按 mtime 降序：
    // newest（beta, NOW）排在 older（alpha, NOW-10s）之前。
    const rows = document.querySelectorAll(".pw-home-todo-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("newest");
    expect(rows[0]?.textContent).toContain("beta");
    expect(rows[1]?.textContent).toContain("older");
    expect(rows[1]?.textContent).toContain("alpha");
  });

  it("只取活跃 tasks/（不含 archived）", async () => {
    renderHome(
      fakeBridge(
        {},
        {
          "/code/alpha": {
            files: [{ name: "live.md", path: "/code/alpha/tasks/live.md", mtimeMs: NOW }],
            archived: [{ name: "gone.md", path: "/code/alpha/tasks/archive/gone.md", mtimeMs: NOW }],
          },
        },
      ),
    );
    expect(await screen.findByText("live")).toBeInTheDocument();
    expect(screen.queryByText("gone")).toBeNull();
  });

  it("点击 Task 行请求在右栏打开该 task 详情", async () => {
    renderHome(
      fakeBridge(
        {},
        {
          "/code/beta": {
            files: [{ name: "task-x.md", path: "/code/beta/tasks/task-x.md", mtimeMs: NOW }],
            archived: [],
          },
        },
      ),
    );
    fireEvent.click(await screen.findByText("task-x"));
    // 点击不切走首页(不 activateProject),而是请求右栏打开该 task 文件详情。
    expect(usePersonalStore.getState().taskDetailRequest).toEqual({
      projectId: "p2",
      path: "/code/beta/tasks/task-x.md",
      name: "task-x.md",
    });
    expect(usePersonalStore.getState().rightView).toBe("todos");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("无 Task 时展示空态", async () => {
    renderHome(fakeBridge({}));
    expect(await screen.findByText("还没有 Task")).toBeInTheDocument();
  });

  it("工作区为空时仍渲染三个区块", async () => {
    usePersonalStore.setState({ projects: [], sessions: [] });
    renderHome(fakeBridge({}));
    expect(screen.getByText("活动热力图")).toBeInTheDocument();
    expect(screen.getByText("Tasks · 所有项目")).toBeInTheDocument();
    await screen.findByText("还没有 Task");
  });
});
