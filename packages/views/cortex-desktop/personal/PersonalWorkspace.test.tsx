// useCloseRightPanelOnHome:进入落地页(homeOpen 转真,含首屏挂载)即收起右栏。
// 验收点对应计划 U2 的 R3/R4/R5/R6 回归:无项目默认隐藏、选项目不自动弹出、
// 显式打开不被复关、离开落地页不强制开关右栏。

import type { ReactNode } from "react";
import { render, renderHook, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import type { RoleConfig } from "@cortex-work/core/desktop/types";
import { PersonalWorkspace, useCloseRightPanelOnHome, usePersonalRolesLibrary } from "./PersonalWorkspace";

describe("个人工作区右栏默认状态", () => {
  it("默认不展开右栏,避免启动后挤压新会话页", () => {
    expect(useCortexUIStore.getInitialState().rightOpen).toBe(false);
  });
});

describe("usePersonalRolesLibrary 工作区入口角色加载", () => {
  beforeEach(() => {
    usePersonalStore.setState({ roles: [] });
  });
  afterEach(() => cleanup());

  it("挂载 Personal workspace 时加载持久化角色并订阅变更", async () => {
    let rolesChanged: ((roles: RoleConfig[]) => void) | undefined;
    const off = vi.fn();
    const bridge = {
      listRoles: vi.fn(async () => [
        {
          id: "code-reviewer",
          label: "Code Reviewer",
          agent: "codex",
          systemPrompt: "review",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ]),
      onRolesChanged: vi.fn((cb) => {
        rolesChanged = cb;
        return off;
      }),
    } as unknown as DesktopBridge;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        {children}
      </CoreProvider>
    );

    const { unmount } = renderHook(() => usePersonalRolesLibrary(), { wrapper });
    await vi.waitFor(() => {
      expect(usePersonalStore.getState().roles.map((r) => r.id)).toEqual(["code-reviewer"]);
    });

    rolesChanged?.([
      {
        id: "designer",
        label: "Designer",
        agent: "claude",
        systemPrompt: "design",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ]);
    expect(usePersonalStore.getState().roles.map((r) => r.id)).toEqual(["designer"]);

    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("useCloseRightPanelOnHome 进入落地页收起右栏", () => {
  beforeEach(() => {
    // 每例从「右栏打开」起步,验证 hook 是否按预期关闭。
    useCortexUIStore.setState({ rightOpen: true });
  });
  afterEach(() => cleanup());

  it("挂载时 homeOpen 为真 → 关闭右栏(R3 无项目默认隐藏)", () => {
    renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: true },
    });
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
  });

  it("homeOpen 假→真 → 关闭右栏;假态挂载不关闭", () => {
    const { rerender } = renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: false },
    });
    // 非落地页挂载不应动右栏。
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    rerender({ homeOpen: true });
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
  });

  it("homeOpen 持真期间显式重开不被复关(R4/R5)", () => {
    const { rerender } = renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: true },
    });
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
    // 用户显式打开(点 Task / 顶栏开关):rightOpen=true 且 homeOpen 不变。
    useCortexUIStore.setState({ rightOpen: true });
    rerender({ homeOpen: true }); // 无关重渲染,effect 依赖未变不应复跑。
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("离开落地页(homeOpen 真→假)不改动右栏(R6)", () => {
    const { rerender } = renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: true },
    });
    // 关闭后用户在别处把右栏打开。
    useCortexUIStore.setState({ rightOpen: true });
    rerender({ homeOpen: false });
    // 离开落地页不强制开/关,交还原有门控。
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });
});

// 深度研究整窗覆盖层的接线（P8）：与设计/写作同构 —— researchOpen 且未打开设置页才渲染。
// settingsOpen 时必须让位，否则 z-40 覆盖层会盖住设置页把「返回」按钮拦掉。
describe("PersonalWorkspace 深度研究覆盖层接线", () => {
  // 个人工作区整体渲染依赖若干无条件调用的桥方法与 matchMedia（响应式左栏），逐一给最小替身。
  const stubBridge = (): DesktopBridge =>
    ({
      listEditors: async () => [],
      pickDirectory: async () => null,
      loadState: async () => ({}),
      saveState: async () => {},
      onCliEvent: () => () => {},
      onCliExit: () => () => {},
      onCliKeepalive: () => () => {},
      research: { list: async () => [], onEvent: () => () => {} },
    }) as unknown as DesktopBridge;

  beforeEach(() => {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    usePersonalStore.setState({
      projects: [],
      sessions: [],
      homeOpen: false,
      researchOpen: false,
      settingsOpen: false,
    });
  });
  afterEach(() => cleanup());

  function renderWorkspace(bridge: DesktopBridge) {
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <PersonalWorkspace onToast={() => {}} />
      </CoreProvider>,
    );
  }

  it("researchOpen 时渲染 ResearchWorkspace 覆盖层", () => {
    usePersonalStore.setState({ researchOpen: true });
    const { container } = renderWorkspace(stubBridge());
    expect(container.querySelector(".pw-res-root")).toBeTruthy();
    expect(container.textContent).toContain("深度研究");
  });

  it("researchOpen=false 时不渲染", () => {
    const { container } = renderWorkspace(stubBridge());
    expect(container.querySelector(".pw-res-root")).toBeNull();
  });

  it("settingsOpen 时让位（不与设置页叠加）", () => {
    usePersonalStore.setState({ researchOpen: true, settingsOpen: true });
    const { container } = renderWorkspace(stubBridge());
    expect(container.querySelector(".pw-res-root")).toBeNull();
  });
});
