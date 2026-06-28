import { describe, it, expect, vi, afterEach } from "vitest";
import {
  safeToolId,
  registerDelegateSession,
  unregisterDelegateSession,
  killAllDelegates,
  buildDelegateMcpServerConfig,
  startDelegateHost,
  stopDelegateHost,
  type DelegateSessionState,
} from "./server";

// 构造一个最小 DelegateSessionState（运行时回调用 noop / spy）。
function makeState(sessionId: string, abort: () => void = () => {}): DelegateSessionState {
  return {
    sessionId,
    runId: "run-" + sessionId,
    roles: [],
    signal: new AbortController().signal,
    abort,
    pushEvent: () => {},
    bumpWatchdog: () => {},
    callCounts: new Map(),
    runSubAgent: async () => ({ text: "", ok: true }),
  };
}

afterEach(() => {
  // 清空模块级 sessionStateMap，隔离测试间状态。
  killAllDelegates();
});

describe("safeToolId（ask_<id> 工具名安全化）", () => {
  it("转小写并保留字母数字与 -_", () => {
    expect(safeToolId("Codex")).toBe("codex");
    expect(safeToolId("my_role-1")).toBe("my_role-1");
  });

  it("非法字符（含中文/空格）折叠为 - 并去首尾", () => {
    // "设计师 A" → 连续非法折叠为一个 - → "-a" → 去首 - → "a"
    expect(safeToolId("设计师 A")).toBe("a");
  });

  it("空 / 全非法回退 role（避免空工具名）", () => {
    expect(safeToolId("")).toBe("role");
    expect(safeToolId("中文")).toBe("role");
  });
});

describe("buildDelegateMcpServerConfig（注入配置纯函数）", () => {
  it("sessionId 为空 → null", () => {
    expect(buildDelegateMcpServerConfig(undefined)).toBeNull();
  });

  it("host 未启动（getHandle=null）→ null，避免给 agent 连不上的 url", () => {
    expect(buildDelegateMcpServerConfig("s1")).toBeNull();
  });

  it("startDelegateHost 后返回 http config（桥接注入的前提：host 可用）", async () => {
    const handle = await startDelegateHost();
    try {
      expect(handle.serverAvailable).toBe(true);
      expect(handle.port).toBeGreaterThan(0);
      const cfg = buildDelegateMcpServerConfig("s1");
      expect(cfg).not.toBeNull();
      expect(cfg?.transport).toBe("http");
      expect(cfg?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(cfg?.headers?.["X-Cortex-Session"]).toBe("s1");
    } finally {
      stopDelegateHost();
    }
    expect(buildDelegateMcpServerConfig("s1")).toBeNull(); // stop 后回到 null
  });
});

describe("delegate session 注册与清理", () => {
  it("killAllDelegates 调用所有已注册 session 的 abort 并清空", () => {
    const a1 = vi.fn();
    const a2 = vi.fn();
    registerDelegateSession(makeState("s1", a1));
    registerDelegateSession(makeState("s2", a2));
    killAllDelegates();
    expect(a1).toHaveBeenCalledTimes(1);
    expect(a2).toHaveBeenCalledTimes(1);
    // 已清空：再次 kill 不重复触发。
    killAllDelegates();
    expect(a1).toHaveBeenCalledTimes(1);
  });

  it("unregisterDelegateSession 后 killAll 不再触发其 abort", () => {
    const a1 = vi.fn();
    registerDelegateSession(makeState("s1", a1));
    unregisterDelegateSession("s1");
    killAllDelegates();
    expect(a1).not.toHaveBeenCalled();
  });

  it("registerDelegateSession 幂等覆盖：同 sessionId 后注册覆盖前者", () => {
    const aOld = vi.fn();
    const aNew = vi.fn();
    registerDelegateSession(makeState("s1", aOld));
    registerDelegateSession(makeState("s1", aNew)); // 覆盖（每轮 run 更新 runId/roles/回调）
    killAllDelegates();
    expect(aOld).not.toHaveBeenCalled();
    expect(aNew).toHaveBeenCalledTimes(1);
  });
});
