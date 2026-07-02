// @vitest-environment jsdom
// U3 委派跨窗口中继测试。core 通例是 node 纯函数测试，但本模块全是 hook（依赖 React context +
// bridge 注入），故本文件用 per-file jsdom + renderHook（照 TaskFieldsPanel.test 的 CoreProvider/
// fakeBridge 写法）。usePersonalActions.send 走 vi.mock 打桩，避免真实 CLI 派发。

import { renderHook, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { CoreProvider } from "../provider";
import { usePersonalStore } from "../store/personal";
import { tasksKeys } from "./tasks";
import type { DesktopBridge } from "../desktop/bridge";
import type { TaskMeta, TaskDelegateIntent } from "../desktop/types";

// send 打桩：断言「主窗口执行器确实发了首条消息」，且不触发真实 CLI。
const sendMock = vi.fn(async (..._args: unknown[]) => true);
vi.mock("./messages", () => ({
  usePersonalActions: () => ({ send: sendMock }),
}));

import { useDelegateTaskRelay, useDelegateIntentListener, useDelegateTask } from "./taskDelegate";

function task(extra: Partial<TaskMeta> = {}): TaskMeta {
  return { id: "t1", title: "写周报", status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra };
}

// 委派意图中继两端桥：send 记录调用；on 捕获监听器供测试手动 fire（模拟 main 转发）。
function fakeBridge(over: Partial<DesktopBridge> = {}) {
  const calls = {
    sendIntent: [] as TaskDelegateIntent[],
    update: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  };
  let intentCb: ((i: TaskDelegateIntent) => void) | null = null;
  const bridge = {
    tasksList: async () => [],
    tasksListProjects: async () => [],
    onTasksChanged: () => () => {},
    ensureNoProjectDir: async () => "/tmp/no-project",
    tasksUpdate: async (id: string, patch: Record<string, unknown>) => {
      calls.update.push({ id, patch });
      return null;
    },
    sendTaskDelegateIntent: (intent: TaskDelegateIntent) => {
      calls.sendIntent.push(intent);
    },
    onTaskDelegateIntent: (cb: (i: TaskDelegateIntent) => void) => {
      intentCb = cb;
      return () => {
        intentCb = null;
      };
    },
    ...over,
  } as unknown as DesktopBridge;
  return { bridge, calls, fireIntent: (i: TaskDelegateIntent) => intentCb?.(i) };
}

function wrapper(bridge: DesktopBridge, queryClient: QueryClient) {
  const W = ({ children }: { children: ReactNode }) => (
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={queryClient}>
      {children}
    </CoreProvider>
  );
  W.displayName = "TestWrapper";
  return W;
}

beforeEach(() => {
  sendMock.mockClear();
  // 每例复位 store 到干净会话集（createSession 会往里加）。
  usePersonalStore.setState({ sessions: [], activeProjectId: undefined, activeSessionId: undefined });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDelegateTaskRelay（项目管理窗口侧）", () => {
  it("只发委派意图 IPC + toast，不在本地 createSession", () => {
    const qc = new QueryClient();
    const { bridge, calls } = fakeBridge();
    const toast = vi.fn();
    const { result } = renderHook(() => useDelegateTaskRelay(), { wrapper: wrapper(bridge, qc) });

    act(() => result.current(task(), toast));

    expect(calls.sendIntent).toEqual([{ taskId: "t1" }]);
    expect(toast).toHaveBeenCalledTimes(1);
    // 关键：项目窗口不本地起会话（sessions 不跨窗口，KTD10）。
    expect(usePersonalStore.getState().sessions).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("再委派守卫：已有 agent 在跑 → 不发意图、toast 提示", () => {
    const qc = new QueryClient();
    const { bridge, calls } = fakeBridge();
    const toast = vi.fn();
    const { result } = renderHook(() => useDelegateTaskRelay(), { wrapper: wrapper(bridge, qc) });

    act(() => result.current(task({ delegation: { sessionId: "s0", state: "running" } }), toast));

    expect(calls.sendIntent).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith("该任务已有 agent 在跑");
  });
});

describe("useDelegateIntentListener（主窗口侧）", () => {
  it("收到委派意图 → 据 taskId 从缓存解析任务并本地 createSession+send+导航", async () => {
    const qc = new QueryClient();
    // 主窗口 React Query 缓存（main-owned，跨窗口广播一致）里有该任务。
    qc.setQueryData(tasksKeys.all, [task()]);
    const { bridge, calls, fireIntent } = fakeBridge();
    const toast = vi.fn();
    renderHook(() => useDelegateIntentListener(toast), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      fireIntent({ taskId: "t1" });
      await Promise.resolve();
    });

    const st = usePersonalStore.getState();
    // 主窗口本地起会话并导航到它（setActiveSession 语义）。
    expect(st.sessions).toHaveLength(1);
    expect(st.activeSessionId).toBe(st.sessions[0]!.id);
    // 任务转 waiting + 记 delegation。
    expect(calls.update.some((u) => u.patch.status === "waiting")).toBe(true);
    // 发出首条消息（上下文含标题）。
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]![2]).toContain("写周报");
  });

  it("意图指向缓存中不存在的任务 → toast 报错、不起会话", async () => {
    const qc = new QueryClient();
    qc.setQueryData(tasksKeys.all, [] as TaskMeta[]);
    const { bridge, fireIntent } = fakeBridge();
    const toast = vi.fn();
    renderHook(() => useDelegateIntentListener(toast), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      fireIntent({ taskId: "missing" });
      await Promise.resolve();
    });

    expect(usePersonalStore.getState().sessions).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith("未找到要委派的任务");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("useDelegateTask（主窗口本地执行器）", () => {
  it("委派：createSession + 任务转 waiting + send + 导航到会话（无 keepView/prevNav）", async () => {
    const qc = new QueryClient();
    const { bridge, calls } = fakeBridge();
    const toast = vi.fn();
    const { result } = renderHook(() => useDelegateTask(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current(task(), toast);
    });

    const st = usePersonalStore.getState();
    expect(st.sessions).toHaveLength(1);
    expect(st.activeSessionId).toBe(st.sessions[0]!.id);
    expect(calls.update.some((u) => u.patch.status === "waiting")).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("再委派守卫：已在跑 → 不起会话、toast", async () => {
    const qc = new QueryClient();
    const { bridge } = fakeBridge();
    const toast = vi.fn();
    const { result } = renderHook(() => useDelegateTask(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current(task({ delegation: { sessionId: "s0", state: "running" } }), toast);
    });

    expect(usePersonalStore.getState().sessions).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith("该任务已有 agent 在跑");
    expect(sendMock).not.toHaveBeenCalled();
  });
});
