import { cleanup, render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, usePersonalStore, useCortexUIStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { HomeView } from "./HomeView";

const NOW = Date.now();

// 首页现在只需 Hero + 场景 chips：Hero 走 useDailyEncouragement（无默认 agent → 静态兜底文案），
// chips 的能力门控读桥子域。loadChat 是 CoreProvider 初始化的最小面。
function fakeBridge(): DesktopBridge {
  return {
    loadChat: async () => [],
    saveChat: async () => {},
  } as unknown as DesktopBridge;
}

function renderHome(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <HomeView />
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

  it("渲染 Hero + 场景 tab / 快捷 chips", () => {
    const { container } = renderHome(fakeBridge());
    // 顶部 Hero：文案为激励问候语（静态池兜底,动态,只断言结构与非空）。
    expect(container.querySelector(".pw-hero-title")?.textContent).toBeTruthy();
    expect(screen.getByRole("tab", { name: "日常办公" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "设计创意" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "演示文稿" })).toBeInTheDocument();
  });

  it("用量日历与一日总结已下线", () => {
    renderHome(fakeBridge());
    expect(screen.queryByLabelText("展开用量日历")).toBeNull();
    expect(screen.queryByText("一日总结 · 所有项目")).toBeNull();
    // 更早移除的 Tasks 区与「Agent 项目」检索也不应回归
    expect(screen.queryByText("Tasks · 所有项目")).toBeNull();
    expect(screen.queryByText("Agent 项目")).toBeNull();
  });

  it("工作区为空时仍渲染 Hero + 场景 chips", () => {
    usePersonalStore.setState({ projects: [], sessions: [] });
    const { container } = renderHome(fakeBridge());
    expect(container.querySelector(".pw-hero-title")?.textContent).toBeTruthy();
    expect(screen.getByRole("tab", { name: "日常办公" })).toBeInTheDocument();
  });
});
