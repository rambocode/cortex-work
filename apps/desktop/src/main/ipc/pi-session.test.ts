// pi-session.ts 单测:pi:* IPC 注册表 / 命令转发 / 事件回推 / 生命周期。
// electron(ipcMain)、pi-gateway(openPiGatewaySession)、provider 解析、cli 全 mock,
// 纯逻辑校验:引擎已收敛,pi:open 无条件走 gateway,不存在任何选路分支。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

import type { PiOpenRequest, PiOpenResult } from "./types";

// 共享 mock 状态(被 vi.mock 工厂引用,必须经 vi.hoisted 提前求值)。
const h = vi.hoisted(() => {
  const makeSession = () => ({
    ready: vi.fn().mockResolvedValue({ sessionId: "sess-x" }),
    // 斜杠命令表缓存:pi:open 在 ready 后 fire-and-forget 调用（不 await,失败也不该影响开会话）。
    loadSlashCommands: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ success: true, data: { accepted: true } }),
    steer: vi.fn().mockResolvedValue({ success: true }),
    followUp: vi.fn().mockResolvedValue({ success: true }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    fork: vi.fn().mockResolvedValue({ success: true, data: { forked: true } }),
    getForkMessages: vi.fn().mockResolvedValue({ success: true, data: { messages: [] } }),
    setModel: vi.fn().mockResolvedValue({ success: true }),
    setThinkingLevel: vi.fn().mockResolvedValue({ success: true }),
    compact: vi.fn().mockResolvedValue({ success: true }),
    switchSession: vi.fn().mockResolvedValue({ success: true, data: { cancelled: false } }),
    getState: vi.fn().mockResolvedValue({ success: true, data: { sessionId: "sess-x" } }),
    getSessionStats: vi.fn().mockResolvedValue({ success: true, data: { messageCount: 3 } }),
    stop: vi.fn(),
    respondUi: vi.fn(),
    onEvent: (_ev: unknown) => {}, // 构造时由 openPiGatewaySession mock 覆盖为真实回调（按实例存,支持多会话路由验证）
    onUiRequest: (_req: unknown) => {}, // 同上,UI 请求路由用例据此 fire
  });
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const onEventRef: { current: ((ev: unknown) => void) | null } = { current: null };
  const instances: ReturnType<typeof makeSession>[] = [];
  /** 每次 pi:open 传给 gateway 的 request（就是 prepared 后的 req 对象本身）。 */
  const openRequests: PiOpenRequest[] = [];
  const openPiGatewaySession = vi.fn(
    async (options: {
      request: PiOpenRequest;
      onEvent: (ev: unknown, runId?: string) => void;
      onUiRequest?: (req: unknown) => void;
    }) => {
      onEventRef.current = options.onEvent; // 末个会话的回调（单会话用例用）
      const inst = makeSession();
      inst.onEvent = options.onEvent; // 按实例存,多会话路由用例据此分别 fire
      if (options.onUiRequest) inst.onUiRequest = options.onUiRequest;
      instances.push(inst);
      openRequests.push(options.request);
      return inst;
    },
  );
  return {
    handlers,
    onEventRef,
    instances,
    openRequests,
    makeSession,
    openPiGatewaySession,
    // 供应商解析:pi-session 只用它把 Catalog+prefs 的 endpoint 覆盖挂上 request.provider。
    resolvePiProviderInput: vi.fn(async (_id: string): Promise<unknown> => undefined),
    assertSpawnCwd: vi.fn(),
    // cwd 归一(空串 → 当天无项目工作目录)。桩按「有值原样返回」实现,
    // 让既有用例断言的 cwd 不被改写;空值兜底本身由 cli.test.ts 覆盖。
    resolveSpawnCwd: vi.fn((cwd?: string) => cwd?.trim() || "/tmp/cortex-no-project"),
    readImageBytes: vi.fn(async () => ({ mimeType: "image/png", base64: "AAAA" })),
    recordAgentTrace: vi.fn(),
    recordStreamDelta: vi.fn(),
    getPersistedState: vi.fn(async () => ({ generalSettings: {} as Record<string, unknown> })),
    buildBrowserMcpServerConfig: vi.fn((): unknown => null),
    resolveAgentBrowserBinary: vi.fn(() => "/app/agent-browser" as string | null),
    buildAgentBrowserMcpServerConfig: vi.fn((): unknown => ({
      id: "agent-browser",
      transport: "stdio",
      command: "/app/agent-browser",
      args: ["mcp", "--tools", "all"],
    })),
    migrateLegacyAgentBrowserMcp: vi.fn((settings: unknown) => settings),
    collectBridgeServers: vi.fn((_servers?: unknown[], _browser?: unknown): unknown[] => []),
    // Computer Use 注入决策（五门控本身在 capabilities/computer-use/inject.test.ts 里测,
    // 这里只验「决策结果如何流进 inProcExtensionPaths + computerUseEnv」）。
    resolveComputerUse: vi.fn(async (): Promise<{ path: string | null; env: Record<string, string> }> => ({
      path: null,
      env: {},
    })),
  };
});

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", isPackaged: false },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
}));
vi.mock("../agents/pi-gateway/client", () => ({ openPiGatewaySession: h.openPiGatewaySession }));
vi.mock("../providers/pi-provider-input", () => ({ resolvePiProviderInput: h.resolvePiProviderInput }));
vi.mock("./cli", () => ({
  assertSpawnCwd: h.assertSpawnCwd,
  resolveSpawnCwd: h.resolveSpawnCwd,
}));
vi.mock("./image", () => ({ readImageBytes: h.readImageBytes }));
vi.mock("./agent-trace", () => ({ recordAgentTrace: h.recordAgentTrace, recordStreamDelta: h.recordStreamDelta }));
vi.mock("./store", () => ({ getPersistedState: h.getPersistedState }));
vi.mock("../capabilities/browser/inject", () => ({ buildBrowserMcpServerConfig: h.buildBrowserMcpServerConfig }));
vi.mock("../capabilities/agent-browser/locate", () => ({ resolveAgentBrowserBinary: h.resolveAgentBrowserBinary }));
vi.mock("../capabilities/agent-browser/inject", () => ({
  buildAgentBrowserMcpServerConfig: h.buildAgentBrowserMcpServerConfig,
  migrateLegacyAgentBrowserMcp: h.migrateLegacyAgentBrowserMcp,
}));
vi.mock("../agents/pi-mcp-bridge", () => ({ collectBridgeServers: h.collectBridgeServers }));
vi.mock("../capabilities/computer-use/inject", () => ({
  resolveComputerUse: h.resolveComputerUse,
  GROUNDING_MODEL_ENV: "PI_COMPUSE_GROUNDING_MODEL",
}));

import {
  registerPiSessionHandlers,
  killAllPiSessions,
  piSessionCount,
  filterLoadableExtensionPaths,
  __setPiExtStoreRootForTest,
  registerTransientPiUiRequest,
  clearTransientPiUiRequestsForSession,
} from "./pi-session";

// renderer 替身:可控的 isDestroyed + 记录 send + once(pi:open 监听 sender 'destroyed' 回收会话)。
function fakeEvent() {
  return { sender: { isDestroyed: vi.fn(() => false), send: vi.fn(), once: vi.fn() } };
}

// 调 pi:open handler,返回 { event, result }。
async function open(req: Partial<PiOpenRequest> = {}) {
  const event = fakeEvent();
  const full: PiOpenRequest = { uiSessionId: "u1", cwd: "/proj", ...req };
  const result = (await h.handlers.get("pi:open")!(event, full)) as PiOpenResult;
  return { event, result };
}

beforeEach(() => {
  killAllPiSessions();
  h.handlers.clear();
  h.instances.length = 0;
  h.openRequests.length = 0;
  h.onEventRef.current = null;
  h.openPiGatewaySession.mockClear();
  h.resolvePiProviderInput.mockReset().mockResolvedValue(undefined);
  h.readImageBytes.mockClear();
  h.recordAgentTrace.mockClear();
  h.recordStreamDelta.mockClear();
  h.getPersistedState.mockReset().mockResolvedValue({ generalSettings: {} });
  h.buildBrowserMcpServerConfig.mockReset().mockReturnValue(null);
  h.resolveAgentBrowserBinary.mockReset().mockReturnValue("/app/agent-browser");
  h.buildAgentBrowserMcpServerConfig.mockReset().mockReturnValue({
    id: "agent-browser",
    transport: "stdio",
    command: "/app/agent-browser",
    args: ["mcp", "--tools", "all"],
  });
  h.migrateLegacyAgentBrowserMcp.mockReset().mockImplementation((settings) => settings);
  h.collectBridgeServers.mockReset().mockReturnValue([]);
  h.resolveComputerUse.mockReset().mockResolvedValue({ path: null, env: {} });
  registerPiSessionHandlers();
});

describe("registerPiSessionHandlers", () => {
  it("注册全部 pi:* handler", () => {
    for (const ch of [
      "pi:open",
      "pi:prompt",
      "pi:steer",
      "pi:followUp",
      "pi:abort",
      "pi:fork",
      "pi:getForkMessages",
      "pi:setModel",
      "pi:setThinking",
      "pi:compact",
      "pi:getState",
      "pi:getStats",
      "pi:close",
    ]) {
      expect(h.handlers.has(ch)).toBe(true);
    }
  });
});

describe("pi:open MCP 桥接（结构化 bridgeServers 交给 worker,引擎收敛后不落盘 .js）", () => {
  it("有桥接 server → 收进 request.bridgeServers 随 open 参数进 worker", async () => {
    h.getPersistedState.mockResolvedValue({
      generalSettings: { browserControl: { enabled: true }, mcp: { enabled: true, servers: [{ id: "fs" }] } },
    });
    const browser = { id: "cortex-browser", transport: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } };
    h.buildBrowserMcpServerConfig.mockReturnValue(browser);
    const bridges = [{ id: "fs", transport: "stdio", command: "/bin/fs" }, browser];
    h.collectBridgeServers.mockReturnValue(bridges);
    await open({ uiSessionId: "ub", cwd: "/proj" });
    // 汇总用户 server(总开关开)+ 浏览器 server 交给 collectBridgeServers。
    expect(h.collectBridgeServers).toHaveBeenCalledWith(
      [
        { id: "fs" },
        expect.objectContaining({ id: "agent-browser" }),
        expect.objectContaining({ id: "cortex-voice-assistant" }),
      ],
      browser,
    );
    expect(h.openRequests[0]!.bridgeServers).toEqual(bridges);
  });

  it("内置 agent-browser 不可用且无其它 server → bridgeServers 为空数组", async () => {
    h.buildAgentBrowserMcpServerConfig.mockReturnValue(null);
    await open({ uiSessionId: "ub2", cwd: "/proj" }); // 默认 collectBridgeServers→[]
    expect(h.openRequests[0]!.bridgeServers).toEqual([]);
  });

  it("默认把内置 agent-browser 加入 Pi MCP 桥接", async () => {
    h.collectBridgeServers.mockImplementation((servers: unknown[] = []) => servers);
    await open({ uiSessionId: "ub3", cwd: "/proj" });

    expect(h.buildAgentBrowserMcpServerConfig).toHaveBeenCalledWith(undefined, "ub3", "/app/agent-browser");
    expect(h.collectBridgeServers).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: "agent-browser" }),
        expect.objectContaining({ id: "cortex-voice-assistant" }),
      ],
      null,
    );
    expect(h.openRequests[0]!.bridgeServers).toEqual([
      expect.objectContaining({ id: "agent-browser" }),
      expect.objectContaining({ id: "cortex-voice-assistant" }),
    ]);
  });
});

describe("pi:open", () => {
  it("记录 pi open/prompt trace;text/reasoning 增量走合并段,其它事件走普通 trace", async () => {
    await open();
    await h.handlers.get("pi:prompt")!({}, "u1", "你好", "run-1");
    h.onEventRef.current?.({ type: "reasoning", delta: "想" });
    h.onEventRef.current?.({ type: "text", delta: "hi" });
    h.onEventRef.current?.({ type: "turn-end" });

    expect(h.recordAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi", phase: "open", sessionId: "u1", agent: "pi" }),
    );
    expect(h.recordAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi", phase: "command", runId: "run-1", sessionId: "u1", agent: "pi" }),
    );
    // text 与 reasoning 各自走合并段(R6),互不混合。
    expect(h.recordStreamDelta).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi", segmentType: "reasoning", delta: "想", sessionId: "u1", agent: "pi" }),
    );
    expect(h.recordStreamDelta).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi", segmentType: "text", delta: "hi", sessionId: "u1", agent: "pi" }),
    );
    // 非增量事件(turn-end)仍走普通 trace。
    expect(h.recordAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi", phase: "event", summary: "pi turn-end", sessionId: "u1", agent: "pi" }),
    );
  });

  it("无条件走 gateway:openPiGatewaySession 建会话,askquestion sentinel 常驻注入,回 sessionId,注册表 +1", async () => {
    const { result } = await open();
    expect(h.openPiGatewaySession).toHaveBeenCalledTimes(1);
    const req = h.openRequests[0]!;
    expect(req).toMatchObject({ uiSessionId: "u1", cwd: "/proj" });
    // askquestion 借道的会话级高熵 sentinel 恒注入（worker 侧 native-hooks 消费）。
    expect(req.askQuestionSentinel).toContain("@@CORTEX_ASKQ");
    expect(h.instances[0].ready).toHaveBeenCalled();
    expect(result).toEqual({ uiSessionId: "u1", sessionId: "sess-x" });
    expect(piSessionCount()).toBe(1);
    // trace 里的引擎恒为 gateway。
    expect(h.recordAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "open", data: expect.objectContaining({ engine: "gateway" }) }),
    );
  });

  it("providerId → resolvePiProviderInput 合成 endpoint 覆盖挂上 request.provider（baseUrl 覆盖通道）", async () => {
    const provider = { id: "anthropic", baseUrl: "https://gw.example.com", models: [] };
    h.resolvePiProviderInput.mockResolvedValue(provider);
    await open({ uiSessionId: "u1", providerId: "anthropic" });
    expect(h.resolvePiProviderInput).toHaveBeenCalledWith("anthropic");
    expect(h.openRequests[0]!.provider).toBe(provider);
  });

  it("providerId 解析不出（自定义供应商）→ provider 留空,由 worker 侧模型解析响亮失败", async () => {
    h.resolvePiProviderInput.mockResolvedValue(undefined);
    await open({ uiSessionId: "u1", providerId: "my-custom" });
    expect(h.openRequests[0]!.provider).toBeUndefined();
    // providerId 原样透传给 worker。
    expect(h.openRequests[0]!.providerId).toBe("my-custom");
  });

  it("调用方（编排子会话）直接给定 provider 时原样沿用,不再解析", async () => {
    const provider = { id: "deepseek", baseUrl: "https://api.deepseek.com", models: [] };
    await open({ uiSessionId: "u1", provider });
    expect(h.resolvePiProviderInput).not.toHaveBeenCalled();
    expect(h.openRequests[0]!.provider).toBe(provider);
  });

  it("ready 失败 → stop 会话 + 不留注册表条目 + 抛错", async () => {
    const bad = { ...h.makeSession(), ready: vi.fn().mockRejectedValue(new Error("pi 会话就绪超时")) };
    h.openPiGatewaySession.mockImplementationOnce(async (options) => {
      h.onEventRef.current = options.onEvent;
      h.instances.push(bad);
      h.openRequests.push(options.request);
      return bad;
    });
    await expect(open()).rejects.toThrow(/就绪超时/);
    expect(bad.stop).toHaveBeenCalled();
    expect(piSessionCount()).toBe(0);
  });

  it("同 uiSessionId 重开:先停旧会话再建新,数量仍为 1", async () => {
    await open();
    const first = h.instances[0];
    await open();
    const second = h.instances[1];
    expect(first.stop).toHaveBeenCalled();
    expect(second).not.toBe(first);
    expect(piSessionCount()).toBe(1);
  });

  it("安全:renderer 传来的 computerUseEnv / customProviderEnv 在边界上被清空", async () => {
    const req: PiOpenRequest = {
      uiSessionId: "u1",
      cwd: "/proj",
      computerUseEnv: { PATH: "/tmp/evil" },
      customProviderEnv: { NODE_OPTIONS: "--require /tmp/x.js" },
    };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.openRequests[0]!.customProviderEnv).toBeUndefined();
    // computerUseEnv 只可能由主进程的 Computer Use 决策重新填充（本用例门控未过 → 保持空）。
    expect(h.openRequests[0]!.computerUseEnv).toBeUndefined();
  });
});

describe("命令转发", () => {
  it("pi:prompt 转发到 session.prompt 并回 data", async () => {
    await open();
    const data = await h.handlers.get("pi:prompt")!({}, "u1", "你好", "run-1");
    expect(h.instances[0].prompt).toHaveBeenCalledWith("你好", "run-1");
    expect(data).toEqual({ accepted: true });
  });

  it("pi:prompt 带 imagePaths → 读盘转 base64 注入 images,转发 s.prompt(message,runId,images)", async () => {
    await open();
    await h.handlers.get("pi:prompt")!({}, "u1", "看图", "run-2", ["/img/a.png", "/img/b.png"]);
    expect(h.readImageBytes).toHaveBeenCalledTimes(2);
    expect(h.instances[0].prompt).toHaveBeenCalledWith("看图", "run-2", [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("pi:prompt 某张图读失败 → 整轮 reject(不静默丢图)", async () => {
    await open();
    h.readImageBytes.mockRejectedValueOnce(new Error("路径不在允许范围内"));
    await expect(h.handlers.get("pi:prompt")!({}, "u1", "看图", "r", ["/img/x.png"])).rejects.toThrow(/允许范围/);
  });

  it("各命令路由到对应方法,参数透传", async () => {
    await open();
    const s = h.instances[0];
    await h.handlers.get("pi:steer")!({}, "u1", "等一下");
    await h.handlers.get("pi:followUp")!({}, "u1", "接着说");
    await h.handlers.get("pi:abort")!({}, "u1");
    await h.handlers.get("pi:fork")!({}, "u1", "entry-3");
    await h.handlers.get("pi:getForkMessages")!({}, "u1");
    await h.handlers.get("pi:setModel")!({}, "u1", "anthropic", "claude");
    await h.handlers.get("pi:setThinking")!({}, "u1", "high");
    await h.handlers.get("pi:compact")!({}, "u1", "保留要点");
    await h.handlers.get("pi:getState")!({}, "u1");
    await h.handlers.get("pi:getStats")!({}, "u1");
    expect(s.steer).toHaveBeenCalledWith("等一下");
    expect(s.followUp).toHaveBeenCalledWith("接着说");
    expect(s.abort).toHaveBeenCalled();
    expect(s.fork).toHaveBeenCalledWith("entry-3");
    expect(s.getForkMessages).toHaveBeenCalled();
    expect(s.setModel).toHaveBeenCalledWith("anthropic", "claude");
    expect(s.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(s.compact).toHaveBeenCalledWith("保留要点");
    expect(s.getState).toHaveBeenCalled();
    expect(s.getSessionStats).toHaveBeenCalled();
  });

  it("会话不存在 → 抛错", async () => {
    await expect(h.handlers.get("pi:abort")!({}, "missing")).rejects.toThrow(/不存在/);
  });

  it("底层方法 reject（worker 崩溃/超时）→ IPC handler 原样 rejection 传播给调用方", async () => {
    await open();
    h.instances[0].prompt.mockRejectedValueOnce(new Error("pi 进程退出 (code=1)"));
    await expect(h.handlers.get("pi:prompt")!({}, "u1", "x")).rejects.toThrow(/退出/);
  });

  it("命令级失败(success:false) → 抛错并带 error 文本", async () => {
    await open();
    h.instances[0].abort.mockResolvedValueOnce({ success: false, error: "无进行中的 run" });
    await expect(h.handlers.get("pi:abort")!({}, "u1")).rejects.toThrow(/无进行中的 run/);
  });
});

describe("事件回推与生命周期", () => {
  it("普通事件 → sender.send('pi:event', {uiSessionId, event})", async () => {
    const { event } = await open();
    h.onEventRef.current!({ type: "text", delta: "你好" });
    expect(event.sender.send).toHaveBeenCalledWith("pi:event", {
      uiSessionId: "u1",
      event: { type: "text", delta: "你好" },
    });
  });

  it("并发多会话:事件按 uiSessionId 路由到各自 sender,互不串台", async () => {
    const e1 = fakeEvent();
    await h.handlers.get("pi:open")!(e1, { uiSessionId: "u1", cwd: "/p" });
    const e2 = fakeEvent();
    await h.handlers.get("pi:open")!(e2, { uiSessionId: "u2", cwd: "/p" });
    h.instances[0].onEvent({ type: "text", delta: "a" });
    h.instances[1].onEvent({ type: "text", delta: "b" });
    expect(e1.sender.send).toHaveBeenCalledWith("pi:event", { uiSessionId: "u1", event: { type: "text", delta: "a" } });
    expect(e2.sender.send).toHaveBeenCalledWith("pi:event", { uiSessionId: "u2", event: { type: "text", delta: "b" } });
    // 互不串台:各 sender 只收到自己 uiSessionId 的事件
    expect(e1.sender.send).not.toHaveBeenCalledWith("pi:event", expect.objectContaining({ uiSessionId: "u2" }));
    expect(e2.sender.send).not.toHaveBeenCalledWith("pi:event", expect.objectContaining({ uiSessionId: "u1" }));
  });

  it("crashed 事件 → 摘除注册表条目,但仍把 crashed 推给 renderer", async () => {
    const { event } = await open();
    expect(piSessionCount()).toBe(1);
    h.onEventRef.current!({ type: "crashed", error: "退出码 1" });
    expect(piSessionCount()).toBe(0);
    expect(event.sender.send).toHaveBeenCalledWith("pi:event", {
      uiSessionId: "u1",
      event: { type: "crashed", error: "退出码 1" },
    });
  });

  it("sender 已销毁 → 不 send(不抛)", async () => {
    const event = fakeEvent();
    event.sender.isDestroyed = vi.fn(() => true);
    await h.handlers.get("pi:open")!(event, { uiSessionId: "u1", cwd: "/p" });
    event.sender.send.mockClear();
    expect(() => h.onEventRef.current!({ type: "text", delta: "x" })).not.toThrow();
    expect(event.sender.send).not.toHaveBeenCalled();
  });

  it("pi:close → stop 会话 + 摘除注册表", async () => {
    await open();
    const s = h.instances[0];
    await h.handlers.get("pi:close")!({}, "u1");
    expect(s.stop).toHaveBeenCalled();
    expect(piSessionCount()).toBe(0);
  });

  it("pi:close 不存在的会话 → 静默不抛", () => {
    expect(() => h.handlers.get("pi:close")!({}, "missing")).not.toThrow();
    expect(h.handlers.get("pi:close")!({}, "missing")).toBeUndefined();
  });

  it("killAllPiSessions → 所有会话 stop + 清空", async () => {
    await h.handlers.get("pi:open")!(fakeEvent(), { uiSessionId: "u1", cwd: "/p" });
    await h.handlers.get("pi:open")!(fakeEvent(), { uiSessionId: "u2", cwd: "/p" });
    expect(piSessionCount()).toBe(2);
    const insts = [...h.instances];
    killAllPiSessions();
    insts.forEach((i) => expect(i.stop).toHaveBeenCalled());
    expect(piSessionCount()).toBe(0);
  });
});

describe("extension UI channel（阶段3 U2）", () => {
  it("会话吐 UI 请求 → pi:uiRequest 推给该会话的 sender", async () => {
    const { event } = await open({ uiSessionId: "u1" });
    const inst = h.instances[h.instances.length - 1]!;
    const req = { type: "extension_ui_request", id: "x1", method: "confirm", title: "T", message: "M" };
    inst.onUiRequest(req);
    expect(event.sender.send).toHaveBeenCalledWith("pi:uiRequest", { uiSessionId: "u1", request: req });
  });

  it("pi:uiResponse → 对应会话 respondUi(id,payload)", async () => {
    await open({ uiSessionId: "u1" });
    const inst = h.instances[h.instances.length - 1]!;
    await h.handlers.get("pi:uiResponse")!({}, "u1", "x1", { confirmed: true });
    expect(inst.respondUi).toHaveBeenCalledWith("x1", { confirmed: true });
  });

  it("临时编排 UI response 按真实会话 + request id 路由,避免并行会话串台", async () => {
    await open({ uiSessionId: "uA" });
    const instA = h.instances[h.instances.length - 1]!;
    await open({ uiSessionId: "uB" });
    const instB = h.instances[h.instances.length - 1]!;
    registerTransientPiUiRequest("uA", "same-id", instA);
    registerTransientPiUiRequest("uB", "same-id", instB);

    await h.handlers.get("pi:uiResponse")!({}, "uA", "same-id", { confirmed: true });
    await h.handlers.get("pi:uiResponse")!({}, "uB", "same-id", { cancelled: true });

    expect(instA.respondUi).toHaveBeenCalledWith("same-id", { confirmed: true });
    expect(instB.respondUi).toHaveBeenCalledWith("same-id", { cancelled: true });
    clearTransientPiUiRequestsForSession(instA);
    clearTransientPiUiRequestsForSession(instB);
  });

  it("多会话:A 的 UI 请求只推给 A 的 sender", async () => {
    const { event: eA } = await open({ uiSessionId: "uA" });
    const instA = h.instances[h.instances.length - 1]!;
    const { event: eB } = await open({ uiSessionId: "uB" });
    instA.onUiRequest({ type: "extension_ui_request", id: "a1", method: "confirm", title: "T", message: "M" });
    expect(eA.sender.send).toHaveBeenCalledWith("pi:uiRequest", expect.objectContaining({ uiSessionId: "uA" }));
    expect(eB.sender.send).not.toHaveBeenCalledWith("pi:uiRequest", expect.anything());
  });

  it("会话已销毁后 pi:uiResponse → 抛「会话不存在」(不崩)", async () => {
    await open({ uiSessionId: "u1" });
    await h.handlers.get("pi:close")!({}, "u1");
    await expect(h.handlers.get("pi:uiResponse")!({}, "u1", "x", { cancelled: true })).rejects.toThrow(/不存在/);
  });
});

describe("能力字段透传（原生组装在 worker 侧,主进程只准备结构化请求）", () => {
  it("审批/样例开关与 askquestion sentinel 原样进 open request,不再生成任何 .js 文件", async () => {
    const req: PiOpenRequest = {
      uiSessionId: "u1",
      cwd: "/p",
      enableToolApproval: true,
      approvalTools: ["bash"],
      enableSampleTools: true,
      enableSampleCommands: true,
    };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    const sent = h.openRequests[0]!;
    expect(sent).toMatchObject({
      enableToolApproval: true,
      approvalTools: ["bash"],
      enableSampleTools: true,
      enableSampleCommands: true,
    });
    expect(sent.askQuestionSentinel).toContain("@@CORTEX_ASKQ");
  });

  it("调用方已带 askQuestionSentinel 时沿用,不重新生成（编排子会话复用主会话 sentinel）", async () => {
    await open({ askQuestionSentinel: "@@CORTEX_ASKQ:fixed@@" });
    expect(h.openRequests[0]!.askQuestionSentinel).toBe("@@CORTEX_ASKQ:fixed@@");
  });
});

// Computer Use 只在这条聊天会话路径注入（单发路径无审批 UI,刻意不给）。五门控判定本身在
// capabilities/computer-use/inject.test.ts,这里只守「决策 → inProcExtensionPaths + computerUseEnv」这段接线。
describe("pi:open Computer Use 注入（gateway 语义）", () => {
  const PKG = "/home/u/.pi/agent/npm/node_modules/pi-computer-use";

  it("门控通过 → 包路径进 inProcExtensionPaths,grounding 键显式携带（缺省空串 = 删除语义）", async () => {
    h.resolveComputerUse.mockResolvedValue({ path: PKG, env: {} });
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/p" };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    const sent = h.openRequests[0]!;
    expect(sent.inProcExtensionPaths).toEqual([PKG]);
    // ⚠️ 常驻 worker 的 env 跨会话残留:注入轮必须显式带 grounding 键,空串 = worker 侧删除。
    expect(sent.computerUseEnv).toEqual({ PI_COMPUSE_GROUNDING_MODEL: "" });
  });

  it("grounding 模型有值 → 原样进 computerUseEnv 交 worker 落地", async () => {
    h.resolveComputerUse.mockResolvedValue({ path: PKG, env: { PI_COMPUSE_GROUNDING_MODEL: "qwen-vl-max" } });
    await h.handlers.get("pi:open")!(fakeEvent(), { uiSessionId: "u1", cwd: "/p" });
    expect(h.openRequests[0]!.computerUseEnv).toEqual({ PI_COMPUSE_GROUNDING_MODEL: "qwen-vl-max" });
  });

  it("门控不通过 → 两个字段都缺省（一个字节不碰 worker 的 env）", async () => {
    h.resolveComputerUse.mockResolvedValue({ path: null, env: {} });
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/p" };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.openRequests[0]!.inProcExtensionPaths).toBeUndefined();
    expect(h.openRequests[0]!.computerUseEnv).toBeUndefined();
  });

  // 决策失败不该拖垮开会话——最坏是这一轮没有 GUI 工具。
  it("决策抛错 → 会话照常开起来,只是不注入", async () => {
    h.resolveComputerUse.mockRejectedValue(new Error("probe boom"));
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/p" };
    const res = (await h.handlers.get("pi:open")!(fakeEvent(), req)) as PiOpenResult;
    expect(res.sessionId).toBe("sess-x");
    expect(h.openRequests[0]!.inProcExtensionPaths).toBeUndefined();
  });

  // 库存根闸只管市场扩展（settings 可被外部篡改）;内置能力的路径来自主进程自己的 marker,
  // 不经该闸——这条用例把这个刻意的差异钉住,避免日后有人"顺手统一"掉它而让内置能力失效。
  it("包路径不经 filterLoadableExtensionPaths 的库存根闸（与市场扩展的威胁模型不同）", async () => {
    __setPiExtStoreRootForTest("/nonexistent-store-root");
    h.resolveComputerUse.mockResolvedValue({ path: PKG, env: {} });
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/p" };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.openRequests[0]!.inProcExtensionPaths).toEqual([PKG]);
    __setPiExtStoreRootForTest(null);
  });
});

describe("emitUiRequest 渲染端销毁兜底（U6 加固）", () => {
  it("sender 已销毁 → respondUi{cancelled} 解锁 pi,不 send pi:uiRequest", async () => {
    const event = fakeEvent();
    await h.handlers.get("pi:open")!(event, { uiSessionId: "u1", cwd: "/p" });
    const inst = h.instances[0];
    (event.sender.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    // 模拟 pi 经 onUiRequest 发来一条待答请求(窗口此刻已销毁)。
    inst.onUiRequest({ type: "extension_ui_request", id: "aq1", method: "askquestion", envelope: { groups: [] } });
    expect(inst.respondUi).toHaveBeenCalledWith("aq1", { cancelled: true });
    expect(event.sender.send).not.toHaveBeenCalledWith("pi:uiRequest", expect.anything());
  });
});

describe("阶段4 恢复:pi:switchSession + ready sessionFile", () => {
  it("pi:open 回带 ready 取得的 sessionFile", async () => {
    const sess = h.makeSession();
    sess.ready = vi.fn().mockResolvedValue({ sessionId: "s1", sessionFile: "/sessions/a.jsonl" });
    h.openPiGatewaySession.mockImplementationOnce(async (options) => {
      h.instances.push(sess);
      h.openRequests.push(options.request);
      return sess;
    });
    const result = (await h.handlers.get("pi:open")!(fakeEvent(), { uiSessionId: "u1", cwd: "/p" })) as {
      sessionFile?: string;
    };
    expect(result.sessionFile).toBe("/sessions/a.jsonl");
  });

  it("pi:switchSession → 转发到 session.switchSession(path)", async () => {
    await open({ uiSessionId: "u1" });
    const inst = h.instances[h.instances.length - 1]!;
    await h.handlers.get("pi:switchSession")!({}, "u1", "/sessions/old.jsonl");
    expect(inst.switchSession).toHaveBeenCalledWith("/sessions/old.jsonl");
  });
});

describe("filterLoadableExtensionPaths（U7 坏/越界 -e 隔离）", () => {
  let root: string;
  let goodPath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-ext-root-"));
    __setPiExtStoreRootForTest(root); // 把库存根指到临时目录(CI 无 ~/.pi)
    goodPath = join(root, "npm-foo", "index.js");
    mkdirSync(dirname(goodPath), { recursive: true });
    writeFileSync(goodPath, "// ext");
  });
  afterEach(() => {
    __setPiExtStoreRootForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("保留库存根内存在的绝对路径", () => {
    expect(filterLoadableExtensionPaths([goodPath])).toEqual([goodPath]);
  });
  it("剔除不存在/相对路径（防 fail-hard 拖垮会话）", () => {
    expect(filterLoadableExtensionPaths([goodPath, join(root, "missing.js"), "rel/x.js"])).toEqual([goodPath]);
  });
  it("剔除库存根外的存在路径（防被篡改 settings/pi list 把 -e 指向 ~/.ssh 等注入逃逸）", () => {
    // process.execPath 必为存在的绝对路径,但在 pi 库存根外 → 须被根收敛拒绝。
    expect(filterLoadableExtensionPaths([process.execPath])).toEqual([]);
  });
  it("剔除以 `..` 逃逸出库存根的路径", () => {
    const escape = join(root, "..", "evil.js"); // resolve 后跳出根
    expect(filterLoadableExtensionPaths([escape])).toEqual([]);
  });
  it("空 / undefined → []", () => {
    expect(filterLoadableExtensionPaths(undefined)).toEqual([]);
    expect(filterLoadableExtensionPaths([])).toEqual([]);
  });
});
