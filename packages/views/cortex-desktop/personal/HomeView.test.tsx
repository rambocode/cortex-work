import { cleanup, render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, usePersonalStore, useCortexUIStore } from "@cortex-work/core";
import type { DesktopBridge, TimelineEvent } from "@cortex-work/core";
import { HomeView } from "./HomeView";

const NOW = Date.now();

// 只实现 HomeBoard 数据路径用到的桥方法：loadTimeline（热力图/一日总结聚合，
// backfilledAt 已置位 → 不触发历史回填）。
function fakeBridge(eventsByProject: Record<string, TimelineEvent[]> = {}): DesktopBridge {
  return {
    loadTimeline: async (projectId: string) => ({
      version: 1,
      backfilledAt: 1,
      events: eventsByProject[projectId] ?? [],
    }),
    saveTimeline: async () => {},
    loadChat: async () => [],
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

  it("渲染 Hero + 用量日历卡片 + 一日总结,不再有 Tasks 区与「Agent 项目」检索", () => {
    renderHome(fakeBridge());
    // 顶部 Hero
    expect(screen.getByText("开始你的智能体节奏")).toBeInTheDocument();
    // 用量日历卡片：默认折叠,只露出展开按钮
    expect(screen.getByLabelText("展开用量日历")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "活动" })).toBeNull();
    expect(screen.queryByText("活动热力图")).toBeNull();
    // 保留一日总结
    expect(screen.getByText("一日总结 · 所有项目")).toBeInTheDocument();
    // Tasks 区已从落地页移除
    expect(screen.queryByText("Tasks · 所有项目")).toBeNull();
    // 「Agent 项目」检索区已移除
    expect(screen.queryByText("Agent 项目")).toBeNull();
    expect(screen.queryByPlaceholderText(/检索项目/)).toBeNull();
  });

  it("一日总结聚合所有可见项目当天统计", async () => {
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

  it("工作区为空时仍渲染 Hero + 用量日历卡片 + 一日总结", () => {
    usePersonalStore.setState({ projects: [], sessions: [] });
    renderHome(fakeBridge());
    expect(screen.getByText("开始你的智能体节奏")).toBeInTheDocument();
    expect(screen.getByLabelText("展开用量日历")).toBeInTheDocument();
    expect(screen.getByText("一日总结 · 所有项目")).toBeInTheDocument();
  });
});
