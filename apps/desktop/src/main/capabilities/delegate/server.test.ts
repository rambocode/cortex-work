import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
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

// 端到端：模拟 pi 桥接的 HTTP 握手（initialize → tools/list），验证无状态 host（每请求新建
// server/transport）是否真能返回 ask_<id>。这是 pi 找不到 ask_codex 的关键验证点。
describe("delegate host HTTP 端到端（pi 桥接握手）", () => {
  function post(cfg: { url: string; headers?: Record<string, string> }, body: unknown) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(cfg.url);
      const r = http.request(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname,
          method: "POST",
          headers: { ...(cfg.headers ?? {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
        },
        (res) => {
          let d = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode || 0, body: d }));
        },
      );
      r.on("error", reject);
      r.write(JSON.stringify(body));
      r.end();
    });
  }

  it("register session 后 initialize→tools/list 返回 ask_<id>", async () => {
    await startDelegateHost();
    const sid = "e2e-session";
    registerDelegateSession({
      sessionId: sid,
      runId: "r-e2e",
      roles: [{ id: "codex", label: "Codex", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" }],
      signal: new AbortController().signal,
      abort: () => {},
      pushEvent: () => {},
      bumpWatchdog: () => {},
      callCounts: new Map(),
      runSubAgent: async () => ({ text: "", ok: true }),
    });
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const init = await post(cfg, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
      expect(init.status).toBe(200);
      const list = await post(cfg, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(list.status).toBe(200);
      // 真实 host 返回 SSE，body 含注册的工具名（端到端验证 tools/list 真返回 ask_codex）。
      expect(list.body).toContain("ask_codex");
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });
});
