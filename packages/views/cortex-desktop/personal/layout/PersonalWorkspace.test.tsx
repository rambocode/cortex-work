// useCloseRightPanelOnHome:进入落地页(homeOpen 转真,含首屏挂载)即收起右栏。
// 验收点对应计划 U2 的 R3/R4/R5/R6 回归:无项目默认隐藏、选项目不自动弹出、
// 显式打开不被复关、离开落地页不强制开关右栏。

import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CoreProvider,
  useCortexUIStore,
  usePersonalStore,
  type DesktopBridge,
  type PiUiRequest,
} from "@cortex-work/core";
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

// 深度研究整窗覆盖层已移除（入口统一为会话 /skill:research,展示在右栏 ResearchArtifactPanel）。
// 本块是防回归：确保覆盖层不会被谁「顺手加回来」——工作区任何状态下都不得出现 .pw-res-root。
describe("PersonalWorkspace 深度研究覆盖层已移除", () => {
  // 个人工作区整体渲染依赖若干无条件调用的桥方法与 matchMedia（响应式左栏），逐一给最小替身。
  const stubBridge = (over: Partial<DesktopBridge> = {}): DesktopBridge =>
    ({
      listEditors: async () => [],
      pickDirectory: async () => null,
      loadState: async () => ({}),
      saveState: async () => {},
      onCliEvent: () => () => {},
      onCliExit: () => () => {},
      onCliKeepalive: () => () => {},
      research: { list: async () => [], onEvent: () => () => {} },
      ...over,
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
      settingsOpen: false,
      piUiPending: [],
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

  it("任何状态下都不再渲染研究整窗覆盖层(.pw-res-root)", () => {
    const { container } = renderWorkspace(stubBridge());
    expect(container.querySelector(".pw-res-root")).toBeNull();
  });

  it("Pi 子会话审批请求会在主工作区显示确认框，并把拒绝响应原路回写", () => {
    const listeners = new Set<(uiSessionId: string, request: PiUiRequest) => void>();
    const piUiResponse = vi.fn(async () => undefined);
    const bridge = stubBridge({
      onPiUiRequest: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      piUiResponse,
    });
    renderWorkspace(bridge);

    const request: PiUiRequest = {
      type: "extension_ui_request",
      id: "delegate:approve-bash",
      method: "confirm",
      title: "允许执行工具 bash?",
      message: '{"command":"rm -rf /tmp/x"}',
    };
    // PersonalWorkspace 同时有审批与 jsrepl 两个订阅者；真实 preload 会向全部 listener 广播。
    act(() => {
      for (const listener of listeners) listener("parent-session", request);
    });

    expect(screen.getByRole("dialog", { name: "工具执行确认" })).toBeInTheDocument();
    expect(screen.getByText("允许执行工具 bash?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(piUiResponse).toHaveBeenCalledWith("parent-session", "delegate:approve-bash", { confirmed: false });
    expect(screen.queryByRole("dialog", { name: "工具执行确认" })).toBeNull();
  });

  it("Pi child 结束时主进程撤销待审批请求，主界面不留无效弹窗", () => {
    const requestListeners = new Set<(uiSessionId: string, request: PiUiRequest) => void>();
    const cancelListeners = new Set<(uiSessionId: string, requestId: string) => void>();
    const piUiResponse = vi.fn(async () => undefined);
    const bridge = stubBridge({
      onPiUiRequest: vi.fn((listener) => {
        requestListeners.add(listener);
        return () => requestListeners.delete(listener);
      }),
      onPiUiCancel: vi.fn((listener) => {
        cancelListeners.add(listener);
        return () => cancelListeners.delete(listener);
      }),
      piUiResponse,
    });
    renderWorkspace(bridge);
    const request: PiUiRequest = {
      type: "extension_ui_request",
      id: "delegate:expired-approval",
      method: "confirm",
      title: "允许执行工具 write?",
      message: "{}",
    };
    act(() => {
      for (const listener of requestListeners) listener("parent-session", request);
    });
    expect(screen.getByRole("dialog", { name: "工具执行确认" })).toBeInTheDocument();

    act(() => {
      for (const listener of cancelListeners) listener("parent-session", request.id);
    });
    expect(screen.queryByRole("dialog", { name: "工具执行确认" })).toBeNull();
    expect(piUiResponse).not.toHaveBeenCalled();
  });
});
