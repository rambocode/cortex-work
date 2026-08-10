// @vitest-environment jsdom
// 个人工作区持久化竞态回归：renderer/HMR 重新挂载时，personal store 尚未从 main hydrate，
// 但其它持久化分片可能仍是已 hydrate 状态。此时任何分片变化都不能把空 projects/sessions
// 作为全量快照写回，否则会直接清空左侧会话历史。

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { DesktopBridge } from "./bridge";
import type { PersistedState } from "./types";
import { CoreProvider } from "../provider";
import { usePersonalStore } from "../store/personal";
import { useReplyStore } from "../store/reply";
import { usePersonalPersistence } from "./usePersonalPersistence";

const personalInitial = usePersonalStore.getInitialState();
const replyInitial = useReplyStore.getInitialState();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function wrapper(bridge: DesktopBridge) {
  function PersistenceWrapper({ children }: { children: ReactNode }) {
    return (
      <CoreProvider wsId="test" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        {children}
      </CoreProvider>
    );
  }
  return PersistenceWrapper;
}

describe("usePersonalPersistence hydrate 竞态", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePersonalStore.setState(personalInitial, true);
    useReplyStore.setState(replyInitial, true);
  });

  afterEach(() => {
    vi.useRealTimers();
    usePersonalStore.setState(personalInitial, true);
    useReplyStore.setState(replyInitial, true);
  });

  it("personal 尚未加载时，已 hydrate 的 reply 分片变化不能用空快照覆盖磁盘", async () => {
    const pendingLoad = deferred<PersistedState>();
    const saveState = vi.fn<DesktopBridge["saveState"]>(async () => {});
    const bridge = {
      loadState: vi.fn(() => pendingLoad.promise),
      saveState,
    } as unknown as DesktopBridge;

    renderHook(() => usePersonalPersistence(), { wrapper: wrapper(bridge) });

    // 模拟 HMR 后两个 Zustand 模块生命周期不同步：reply 仍处于已 hydrate 状态，personal
    // 已回到空初始态；reply 设置变化会触发共享的全量保存管线。
    act(() => {
      useReplyStore.setState({ hydrated: true });
      useReplyStore.getState().setSettings({ historyEnabled: false });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(saveState).not.toHaveBeenCalled();

    pendingLoad.resolve({
      version: 1,
      projects: [{ id: "project-1", name: "项目", path: "/workspace", addedAt: 1 }],
      sessions: [{ id: "session-1", title: "历史会话", agent: "pi", projectId: "project-1", createdAt: 1, updatedAt: 1 }],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(usePersonalStore.getState().sessions).toHaveLength(1);
  });

  it("恢复索引把 UUID 子代理误标为普通会话时自动修正为 side 并保存", async () => {
    const childSessionId = "f342dab9-1dc3-4f6a-9f0c-1aa92fc3015b";
    const callId = "call-recovered-child";
    const saveState = vi.fn<DesktopBridge["saveState"]>(async () => {});
    const bridge = {
      loadState: vi.fn(async () => ({
        version: 1,
        projects: [],
        sessions: [
          {
            id: "sess-parent",
            title: "父会话",
            agent: "pi" as const,
            createdAt: 1_000,
            updatedAt: 4_000,
          },
          {
            id: childSessionId,
            title: "误恢复到左栏的子会话",
            agent: "pi" as const,
            createdAt: 2_000,
            updatedAt: 3_000,
          },
        ],
      })),
      loadChat: vi.fn(async (sessionId: string) =>
        sessionId === childSessionId
          ? [
              { kind: "text", who: "me", time: "10:00", text: "检查项目", uid: `subagent-task-${callId}` },
              { kind: "text", who: "pi", time: "10:01", text: "检查完成", uid: `subagent-reply-${callId}` },
            ]
          : [],
      ),
      saveState,
    } as unknown as DesktopBridge;

    renderHook(() => usePersonalPersistence(), { wrapper: wrapper(bridge) });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const child = usePersonalStore.getState().sessions.find((session) => session.id === childSessionId);
    expect(child).toMatchObject({
      relation: "side",
      parentSessionId: "sess-parent",
      parentSubagentCallId: callId,
    });
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: childSessionId, relation: "side" }),
      ]),
    }));
  });
});
