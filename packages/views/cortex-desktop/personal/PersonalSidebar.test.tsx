// U3 侧栏「项目管理」独立窗口入口的门控与定位测试（R1/R6，KTD2）。
// 入口双门控：bridge.tasksListProjects（任务能力）+ onOpenProjectsWindow（壳注入窗口能力）；
// 位置在底部「设置」（.sb-foot）正上方；点击调用注入的 onOpenProjectsWindow（views 不碰 window.desktopAPI）。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import { i18nReady } from "@cortex-work/core/i18n";
import type { DesktopBridge } from "@cortex-work/core";
import { PersonalSidebar } from "./PersonalSidebar";

// 侧栏渲染只需最小 bridge：探测 editors 用 listEditors（缺则空），门控用 tasksListProjects 存在与否。
function bridgeWith(tasksListProjects: boolean): DesktopBridge {
  return {
    listEditors: async () => [],
    ...(tasksListProjects ? { tasksListProjects: async () => [] } : {}),
  } as unknown as DesktopBridge;
}

function renderSidebar(bridge: DesktopBridge | null, onOpenProjectsWindow?: () => void) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PersonalSidebar onToast={() => {}} onOpenProjectsWindow={onOpenProjectsWindow} />
    </CoreProvider>,
  );
}

beforeAll(async () => {
  await i18nReady;
});

beforeEach(() => {
  // 干净的项目/会话集，避免上一例残留影响渲染。
  usePersonalStore.setState({ projects: [], sessions: [] });
});

afterEach(() => cleanup());

describe("PersonalSidebar 「项目管理」入口（U3）", () => {
  it("有任务能力 + 注入窗口回调 → 渲染「项目管理」，位于底部「设置」正上方", () => {
    const { container } = renderSidebar(bridgeWith(true), () => {});
    const entry = container.querySelector(".pw-projects-entry");
    expect(entry).toBeTruthy();
    expect(entry!.textContent).toContain("项目管理");
    // 定位：入口在 .sb-foot（设置）之前（DOM 先序 → 视觉在上方）。
    const foot = container.querySelector(".sb-foot")!;
    expect(entry!.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("点击入口调用注入的 onOpenProjectsWindow（不碰 window.desktopAPI）", () => {
    const open = vi.fn();
    renderSidebar(bridgeWith(true), open);
    fireEvent.click(screen.getByText("项目管理"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("缺窗口能力回调（web/旧壳）→ 隐藏入口", () => {
    const { container } = renderSidebar(bridgeWith(true), undefined);
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
  });

  it("缺任务能力（bridge 无 tasksListProjects）→ 隐藏入口", () => {
    const { container } = renderSidebar(bridgeWith(false), () => {});
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
  });

  it("顶部旧「项目工作台」按钮已退役（不再渲染）", () => {
    renderSidebar(bridgeWith(true), () => {});
    expect(screen.queryByTitle(/项目工作台/)).toBeNull();
  });
});
