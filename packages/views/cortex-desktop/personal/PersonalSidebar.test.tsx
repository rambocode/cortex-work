// U2 侧栏顶部三入口（会话 / 写作 / 项目管理）与底部项目管理移除的门控测试（R1/R2/R3、KTD2）。
// - 会话=openHome、写作=openWriting（均以 store 状态断言真实行为）；
// - 项目管理=双门控 bridge.tasksListProjects + 注入的 onOpenProjectsWindow（views 不碰 window.desktopAPI）；
// - bridge=null（web/旧壳）时写作、项目管理降级隐藏，会话仍在；底部 footer 不再渲染项目管理。
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
  // 干净的项目/会话集与视图态,避免上一例残留影响渲染与断言。
  usePersonalStore.setState({ projects: [], sessions: [], homeOpen: true, writingOpen: false });
});

afterEach(() => cleanup());

describe("PersonalSidebar 顶部三入口（U2）", () => {
  it("bridge 完整时渲染会话 / 写作 / 项目管理三入口", () => {
    renderSidebar(bridgeWith(true), () => {});
    expect(screen.getByText("新会话")).toBeTruthy();
    expect(screen.getByText("写作")).toBeTruthy();
    expect(screen.getByText("项目管理")).toBeTruthy();
  });

  it("点击「会话」触发 openHome（homeOpen=true、writingOpen 复位）", () => {
    // 从写作态起步,验证点击会话确实切回首页并清写作态。
    usePersonalStore.setState({ homeOpen: false, writingOpen: true });
    renderSidebar(bridgeWith(true), () => {});
    fireEvent.click(screen.getByText("新会话"));
    expect(usePersonalStore.getState().homeOpen).toBe(true);
    expect(usePersonalStore.getState().writingOpen).toBe(false);
  });

  it("点击「写作」触发 openWriting（writingOpen=true、homeOpen 清空）", () => {
    renderSidebar(bridgeWith(true), () => {});
    fireEvent.click(screen.getByText("写作"));
    expect(usePersonalStore.getState().writingOpen).toBe(true);
    expect(usePersonalStore.getState().homeOpen).toBe(false);
  });

  it("点击「项目管理」调用注入的 onOpenProjectsWindow（不碰 window.desktopAPI）", () => {
    const open = vi.fn();
    renderSidebar(bridgeWith(true), open);
    fireEvent.click(screen.getByText("项目管理"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("bridge=null（web/旧壳）→ 写作、项目管理降级隐藏，会话仍在", () => {
    const { container } = renderSidebar(null, () => {});
    expect(screen.getByText("新会话")).toBeTruthy();
    expect(screen.queryByText("写作")).toBeNull();
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
    // bridge 缺失时整个「写作 + 项目管理」并排行都不渲染。
    expect(container.querySelector(".pw-top-nav-row")).toBeNull();
  });

  it("缺任务能力（bridge 无 tasksListProjects）→ 项目管理隐藏，写作仍在（双门控臂一）", () => {
    const { container } = renderSidebar(bridgeWith(false), () => {});
    expect(screen.getByText("写作")).toBeTruthy();
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
  });

  it("缺窗口回调（onOpenProjectsWindow 未注入）→ 项目管理隐藏，写作仍在（双门控臂二）", () => {
    const { container } = renderSidebar(bridgeWith(true), undefined);
    expect(screen.getByText("写作")).toBeTruthy();
    expect(container.querySelector(".pw-projects-entry")).toBeNull();
  });

  it("项目管理入口位于顶部（在底部「设置」之前的 DOM 先序）", () => {
    const { container } = renderSidebar(bridgeWith(true), () => {});
    const entry = container.querySelector(".pw-projects-entry")!;
    const foot = container.querySelector(".sb-foot")!;
    expect(entry.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 顶部三入口组:项目管理在「写作 + 项目管理」并排行内。
    expect(container.querySelector(".pw-top-nav-row")!.contains(entry)).toBe(true);
  });
});

describe("PersonalSidebar 底部 footer（U2）", () => {
  it("底部不再渲染项目管理，仍渲染设计入口与设置", () => {
    const { container } = renderSidebar(bridgeWith(true), () => {});
    const footer = container.querySelector(".pw-sidebar-footer")!;
    // 底部只剩设计与设置:项目管理入口不在 footer 内。
    expect(footer.querySelector(".pw-projects-entry")).toBeNull();
    expect(screen.getByText("设计")).toBeTruthy();
    expect(container.querySelector(".sb-foot")).toBeTruthy();
  });

  it("顶部旧「项目工作台」按钮已退役（不再渲染）", () => {
    renderSidebar(bridgeWith(true), () => {});
    expect(screen.queryByTitle(/项目工作台/)).toBeNull();
  });
});
