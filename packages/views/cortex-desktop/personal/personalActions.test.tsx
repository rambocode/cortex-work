// usePersonalActions 的 send/stop/editResend「单发 vs pi RPC」分叉回归（计划 U3）。
// 重点:claude/codex 仍走 startCli/killCli/trimAgentSession（R10 零回归）;pi 走
// piOpen+piPrompt / piAbort / piFork。jsdom + renderHook（core 是 node env,放此处）。

import type { ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoreProvider,
  personalChatKeys,
  usePersonalActions,
  usePersonalPiEvents,
  usePersonalPiUi,
  usePersonalStore,
  __resetPersonalMessageRunsForTest,
  __resetPiSessionsForTest,
  type DesktopBridge,
  type Message,
  type SessionMeta,
} from "@cortex-work/core";

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    loadChat: vi.fn(async () => []),
    saveChat: vi.fn(async () => undefined),
    startCli: vi.fn(async () => undefined),
    killCli: vi.fn(async () => undefined),
    agentSessionExists: vi.fn(async () => true),
    trimAgentSession: vi.fn(async () => true),
    oneshotCli: vi.fn(async () => ""),
    piOpen: vi.fn(async (req: { uiSessionId: string }) => ({ uiSessionId: req.uiSessionId, sessionId: "pi-1" })),
    piPrompt: vi.fn(async () => undefined),
    piSteer: vi.fn(async () => undefined),
    piAbort: vi.fn(async () => undefined),
    piFork: vi.fn(async () => undefined),
    piGetForkMessages: vi.fn(async () => ({ messages: [{ entryId: "e1", text: "原问题" }] })),
    piSetModel: vi.fn(async () => undefined),
    onPiEvent: vi.fn(() => () => undefined),
    onPiUiRequest: vi.fn(() => () => undefined),
    piUiResponse: vi.fn(async () => undefined),
    ...over,
  } as unknown as DesktopBridge;
}

function wrapper(bridge: DesktopBridge, qc: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge} queryClient={qc}>
      {children}
    </CoreProvider>
  );
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

const claudeSession: SessionMeta = {
  id: "s-claude",
  projectId: "p1",
  title: "Session 1",
  agent: "claude",
  agentSessionIds: { claude: "c1" },
  createdAt: 1,
  updatedAt: 1,
};
const piSession: SessionMeta = { id: "s-pi", projectId: "p1", title: "Session 2", agent: "pi", createdAt: 1, updatedAt: 1 };

function userMsgUid(qc: QueryClient, sessionId: string, text: string): string {
  const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
  const hit = msgs.find((m) => m.kind === "text" && m.who === "me" && m.text === text);
  return hit?.uid ?? "";
}

beforeEach(() => {
  __resetPersonalMessageRunsForTest();
  __resetPiSessionsForTest();
  usePersonalStore.setState({
    sessions: [claudeSession, piSession],
    projects: [],
    runningBySession: {},
    piRuntimeBySession: {},
  });
});

afterEach(() => {
  cleanup();
  __resetPersonalMessageRunsForTest();
  __resetPiSessionsForTest();
});

describe("send 分叉", () => {
  it("pi 走 piOpen+piPrompt,不走 startCli", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piPrompt).toHaveBeenCalledTimes(1);
    expect((bridge.piPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("s-pi");
    expect(bridge.startCli).not.toHaveBeenCalled();
  });

  it("同会话并发两次 send:同步锁挡掉第二次,只起一轮", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await Promise.all([
        result.current.send(piSession, "/proj", "一", []),
        result.current.send(piSession, "/proj", "二", []),
      ]);
    });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piPrompt).toHaveBeenCalledTimes(1); // 第二次被发送在途锁/ running 挡掉
  });

  it("pi 复用已开会话:第二轮不再 piOpen", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "第一轮", []);
    });
    usePersonalStore.getState().setRunning(piSession.id, undefined);
    await act(async () => {
      await result.current.send(piSession, "/proj", "第二轮", []);
    });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piPrompt).toHaveBeenCalledTimes(2);
  });

  it("piCustomization 设置经 send 塞进 piOpen（深度定制开关接通,阶段3 U10）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    usePersonalStore.setState({
      generalSettings: {
        ...usePersonalStore.getState().generalSettings,
        piCustomization: { toolApproval: true, sampleTools: true, sampleCommands: false },
      },
    });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    const req = (bridge.piOpen as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req).toMatchObject({ enableToolApproval: true, enableSampleTools: true });
    expect(req.enableSampleCommands).toBeUndefined(); // false → undefined（不传,不生成）
  });

  it("claude 仍走 startCli,不碰任何 pi 方法（R10）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(claudeSession, "/proj", "你好", []);
    });
    expect(bridge.startCli).toHaveBeenCalledTimes(1);
    const req = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req).toMatchObject({ agent: "claude", prompt: "你好" });
    expect(bridge.piOpen).not.toHaveBeenCalled();
    expect(bridge.piPrompt).not.toHaveBeenCalled();
  });
});

describe("stop 分叉", () => {
  it("pi running 中 stop → piAbort,不 killCli", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    // 先发一轮开启会话并置 running（真实流程:stop 只在运行中可达）。
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    await act(async () => {
      await result.current.stop(piSession.id);
    });
    expect(bridge.piAbort).toHaveBeenCalledWith("s-pi");
    expect(bridge.killCli).not.toHaveBeenCalled();
  });

  it("claude running 中 stop → killCli,不 piAbort（R10）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    usePersonalStore.getState().setRunning(claudeSession.id, "run-y");
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.stop(claudeSession.id);
    });
    expect(bridge.killCli).toHaveBeenCalledWith("run-y");
    expect(bridge.piAbort).not.toHaveBeenCalled();
  });
});

describe("usePersonalPiEvents 订阅生命周期（U4）", () => {
  it("挂载订阅一次 onPiEvent,卸载退订", () => {
    const off = vi.fn();
    const onPiEvent = vi.fn(() => off);
    const bridge = makeBridge({ onPiEvent });
    const qc = new QueryClient();
    const { unmount } = renderHook(() => usePersonalPiEvents(), { wrapper: wrapper(bridge, qc) });
    expect(onPiEvent).toHaveBeenCalledTimes(1);
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("bridge 无 onPiEvent（web/旧壳）时空转,不抛错", () => {
    const bridge = makeBridge({ onPiEvent: undefined });
    const qc = new QueryClient();
    expect(() => renderHook(() => usePersonalPiEvents(), { wrapper: wrapper(bridge, qc) })).not.toThrow();
  });

  it("usePersonalPiUi 挂载订阅 onPiUiRequest,回调入队 store + 卸载退订", () => {
    let emit: ((uiSessionId: string, request: unknown) => void) | undefined;
    const off = vi.fn();
    const onPiUiRequest = vi.fn((cb: (uiSessionId: string, request: unknown) => void) => {
      emit = cb;
      return off;
    });
    const bridge = makeBridge({ onPiUiRequest });
    const qc = new QueryClient();
    usePersonalStore.setState({ piUiPending: [] });
    const { unmount } = renderHook(() => usePersonalPiUi(), { wrapper: wrapper(bridge, qc) });
    expect(onPiUiRequest).toHaveBeenCalledTimes(1);
    emit!("s-pi", { type: "extension_ui_request", id: "z1", method: "confirm", title: "T", message: "M" });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(1);
    expect(usePersonalStore.getState().piUiPending[0]).toMatchObject({ uiSessionId: "s-pi" });
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("usePersonalPiUi:select/input/editor 不入队,立即回 cancelled（避免 pi 永久卡死）", () => {
    let emit: ((uiSessionId: string, request: unknown) => void) | undefined;
    const onPiUiRequest = vi.fn((cb: (uiSessionId: string, request: unknown) => void) => {
      emit = cb;
      return () => undefined;
    });
    const piUiResponse = vi.fn(async () => undefined);
    const bridge = makeBridge({ onPiUiRequest, piUiResponse });
    const qc = new QueryClient();
    usePersonalStore.setState({ piUiPending: [] });
    renderHook(() => usePersonalPiUi(), { wrapper: wrapper(bridge, qc) });
    emit!("s-pi", { type: "extension_ui_request", id: "sel1", method: "select", title: "T", options: ["a", "b"] });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(0); // 不入队
    expect(piUiResponse).toHaveBeenCalledWith("s-pi", "sel1", { cancelled: true }); // 立即取消
  });
});

describe("editResend 分叉", () => {
  it("pi → piFork 到分支点 + 重发,不走 trimAgentSession", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    // 先发一轮以开启 pi 会话并写入用户消息「原问题」。
    await act(async () => {
      await result.current.send(piSession, "/proj", "原问题", []);
    });
    usePersonalStore.getState().setRunning(piSession.id, undefined); // 模拟本轮结束
    const uid = userMsgUid(qc, piSession.id, "原问题");
    await act(async () => {
      await result.current.editResend(piSession, "/proj", uid, "改后的问题", []);
    });
    expect(bridge.piGetForkMessages).toHaveBeenCalledWith("s-pi");
    expect(bridge.piFork).toHaveBeenCalledWith("s-pi", "e1");
    expect(bridge.trimAgentSession).not.toHaveBeenCalled();
    expect(bridge.piPrompt).toHaveBeenCalledTimes(2); // 原轮 + 重发
  });

  it("claude editResend 不碰任何 pi 方法,经 startCli 重发（R10）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(claudeSession, "/proj", "原问题", []);
    });
    usePersonalStore.getState().setRunning(claudeSession.id, undefined);
    const uid = userMsgUid(qc, claudeSession.id, "原问题");
    await act(async () => {
      await result.current.editResend(claudeSession, "/proj", uid, "改后的问题", []);
    });
    expect(bridge.piFork).not.toHaveBeenCalled();
    expect(bridge.piOpen).not.toHaveBeenCalled();
    expect(bridge.startCli).toHaveBeenCalledTimes(2); // 原轮 + 重发
  });
});

describe("steer / setPiModel（U6）", () => {
  it("pi steer:回显用户气泡 + 调 piSteer", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "原问题", []);
    });
    await act(async () => {
      await result.current.steer(piSession.id, "往左走");
    });
    expect(bridge.piSteer).toHaveBeenCalledWith("s-pi", "往左走");
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(piSession.id)) ?? [];
    expect(msgs.some((m) => m.kind === "text" && m.who === "me" && m.text === "往左走")).toBe(true);
  });

  it("claude steer no-op:不调 piSteer", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.steer(claudeSession.id, "x");
    });
    expect(bridge.piSteer).not.toHaveBeenCalled();
  });

  it("会话未就绪（冷启窗口）steer:不回显气泡也不 steerPi（避免孤立气泡）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    // 未先 send 开会话 → isPiSessionOpen 为假。
    await act(async () => {
      await result.current.steer(piSession.id, "插话");
    });
    expect(bridge.piSteer).not.toHaveBeenCalled();
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(piSession.id)) ?? [];
    expect(msgs.some((m) => m.kind === "text" && m.text === "插话")).toBe(false);
  });

  it("setPiModel:会话已开 → updateSession + 实时 piSetModel", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "hi", []);
    });
    await act(async () => {
      result.current.setPiModel(piSession, "deepseek", "deepseek-chat");
    });
    expect(bridge.piSetModel).toHaveBeenCalledWith("s-pi", "deepseek", "deepseek-chat");
    expect(usePersonalStore.getState().sessions.find((s) => s.id === "s-pi")).toMatchObject({
      providerId: "deepseek",
      model: "deepseek-chat",
    });
  });

  it("setPiModel:会话未开 → 仅 updateSession,不 piSetModel", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      result.current.setPiModel(piSession, "deepseek", "m1");
    });
    expect(bridge.piSetModel).not.toHaveBeenCalled();
    expect(usePersonalStore.getState().sessions.find((s) => s.id === "s-pi")).toMatchObject({
      providerId: "deepseek",
      model: "m1",
    });
  });
});
