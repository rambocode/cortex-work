import { afterEach, describe, expect, it, vi } from "vitest";
import { usePersonalStore } from "../store/personal";
import { waitForSessionIdle } from "./sessionIdle";

function setRunning(sessionId: string, runId: string | undefined): void {
  usePersonalStore.setState((s) => ({
    runningBySession: { ...s.runningBySession, [sessionId]: runId },
  }));
}

describe("waitForSessionIdle", () => {
  afterEach(() => {
    usePersonalStore.setState({ runningBySession: {} });
    vi.useRealTimers();
  });

  it("会话本来就空闲时立即 true", async () => {
    await expect(waitForSessionIdle("s1")).resolves.toBe(true);
  });

  it("运行中时挂起,直到该会话的 run 结束才 true", async () => {
    setRunning("s1", "run-1");
    let settled: boolean | undefined;
    const pending = waitForSessionIdle("s1").then((ok) => (settled = ok));

    // 别的会话结束不算数:同一时刻多个会话在跑是常态。
    setRunning("s2", "run-2");
    setRunning("s2", undefined);
    await Promise.resolve();
    expect(settled).toBeUndefined();

    setRunning("s1", undefined);
    await pending;
    expect(settled).toBe(true);
  });

  it("超时返回 false(run 卡死时不能永远挂着不给用户反馈)", async () => {
    vi.useFakeTimers();
    setRunning("s1", "run-1");
    const pending = waitForSessionIdle("s1", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);

    // 超时后订阅必须已解除:此后的状态变化不应再触发任何回调。
    setRunning("s1", undefined);
  });
});
