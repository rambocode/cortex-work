// pi-session.ts 单测:pi:* IPC 注册表 / 命令转发 / 事件回推 / 生命周期。
// electron(ipcMain)、pi-gateway(openPiGatewaySession)、provider 解析、cli 全 mock,
// 纯逻辑校验:引擎已收敛,pi:open 无条件走 gateway,不存在任何选路分支。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

import {
  PI_PLAN_TOOL_WHITELIST,
  type ConversationArtifactRef,
  type PiOpenRequest,
  type PiOpenResult,
  type RoleConfig,
} from "./types";
import type { DesignDelegateSessionState } from "../capabilities/design-delegate/server";
import type { DelegateSessionState } from "../capabilities/delegate/server";
import type { SlidesSessionState } from "../capabilities/slides/session";

// 共享 mock 状态(被 vi.mock 工厂引用,必须经 vi.hoisted 提前求值)。
const h = vi.hoisted(() => {
  const makeSender = () => ({
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  });
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
  // Electron invoke 永远带 event.sender。既有测试大量用 `{}` 省略该样板，本表由成功的
  // pi:open 记录 owner，并由 ipcMain mock 为这些调用补回真实形状；显式 sender 则原样保留，
  // 供跨 renderer 权限测试使用。
  const owners = new Map<string, ReturnType<typeof makeSender>>();
  const openPiGatewaySession = vi.fn(
    async (options: {
      request: PiOpenRequest;
      onEvent: (ev: unknown, runId?: string) => void;
      onUiRequest?: (req: unknown) => void;
      onSessionCreated?: (session: ReturnType<typeof makeSession>) => void;
    }) => {
      onEventRef.current = options.onEvent; // 末个会话的回调（单会话用例用）
      const inst = makeSession();
      inst.onEvent = options.onEvent; // 按实例存,多会话路由用例据此分别 fire
      if (options.onUiRequest) inst.onUiRequest = options.onUiRequest;
      instances.push(inst);
      openRequests.push(options.request);
      options.onSessionCreated?.(inst);
      return inst;
    },
  );
  const delegateStates = new Map<string, DelegateSessionState>();
  const designStates = new Map<string, DesignDelegateSessionState>();
  const slidesStates = new Map<string, SlidesSessionState>();
  const customProviders: Array<{ id: string; json: string }> = [];
  return {
    handlers,
    onEventRef,
    instances,
    openRequests,
    owners,
    makeSession,
    makeSender,
    openPiGatewaySession,
    delegateStates,
    designStates,
    slidesStates,
    customProviders,
    ensureDelegateMcpServerConfig: vi.fn(async (_sessionId?: string): Promise<unknown> => null),
    registerDelegateSession: vi.fn((state: DelegateSessionState) => delegateStates.set(state.sessionId, state)),
    unregisterDelegateSession: vi.fn((sessionId: string, expectedState?: DelegateSessionState) => {
      if (expectedState && delegateStates.get(sessionId) !== expectedState) return false;
      return delegateStates.delete(sessionId);
    }),
    ensureDesignDelegateMcpServerConfig: vi.fn(async (_sessionId?: string): Promise<unknown> => null),
    registerDesignDelegateSession: vi.fn((state: DesignDelegateSessionState) => {
      designStates.set(state.sessionId, state);
    }),
    unregisterDesignDelegateSession: vi.fn(
      (sessionId: string, expectedState?: DesignDelegateSessionState) => {
        if (expectedState && designStates.get(sessionId) !== expectedState) return false;
        return designStates.delete(sessionId);
      },
    ),
    ensureSlidesMcpServerConfig: vi.fn(async (_sessionId?: string): Promise<unknown> => null),
    registerSlidesSession: vi.fn((state: SlidesSessionState) => {
      slidesStates.set(state.sessionId, state);
    }),
    unregisterSlidesSession: vi.fn((sessionId: string, expectedState?: SlidesSessionState) => {
      if (expectedState && slidesStates.get(sessionId) !== expectedState) return false;
      return slidesStates.delete(sessionId);
    }),
    isKnownConversationArtifactRoot: vi.fn(() => true),
    validateConversationArtifact: vi.fn(async (artifact: ConversationArtifactRef) => artifact),
    assertAllowed: vi.fn(async () => undefined),
    // 供应商解析:pi-session 只用它把 Catalog+prefs 的 endpoint 覆盖挂上 request.provider。
    resolvePiProviderInput: vi.fn(async (_id: string): Promise<unknown> => undefined),
    assertCustomProviderReady: vi.fn(async () => undefined),
    assertSpawnCwd: vi.fn(),
    // cwd 归一(空串 → 当天无项目工作目录)。桩按「有值原样返回」实现,
    // 让既有用例断言的 cwd 不被改写;空值兜底本身由 cli.test.ts 覆盖。
    resolveSpawnCwd: vi.fn((cwd?: string) => cwd?.trim() || "/tmp/cortex-no-project"),
    readImageBytes: vi.fn(async () => ({ mimeType: "image/png", base64: "AAAA" })),
    recordAgentTrace: vi.fn(),
    recordStreamDelta: vi.fn(),
    getPersistedState: vi.fn(async () => ({ generalSettings: {} as Record<string, unknown> })),
    buildBrowserMcpServerConfig: vi.fn((): unknown => null),
    buildResearchMcpServerConfig: vi.fn((): unknown => null),
    resolveAgentBrowserBinary: vi.fn(() => "/app/agent-browser" as string | null),
    buildAgentBrowserMcpServerConfig: vi.fn((): unknown => ({
      id: "agent-browser",
      transport: "stdio",
      command: "/app/agent-browser",
      args: ["mcp", "--tools", "all"],
    })),
    migrateLegacyAgentBrowserMcp: vi.fn((settings: unknown) => settings),
    collectBridgeServers: vi.fn((_servers?: unknown[], _browser?: unknown): unknown[] => []),
    mcpServerToBridge: vi.fn((server: unknown): unknown => server),
    // Computer Use 注入决策（五门控本身在 capabilities/computer-use/inject.test.ts 里测,
    // 这里只验「决策结果如何流进 inProcExtensionPaths + computerUseEnv」）。
    resolveComputerUse: vi.fn(async (): Promise<{ path: string | null; env: Record<string, string> }> => ({
      path: null,
      env: {},
    })),
  };
});

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/fake/app",
    getPath: (name: string) => name === "documents" ? "/fake/documents" : "/fake/app-data",
    isPackaged: false,
  },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(
      ch,
      (event: unknown, ...args: unknown[]) => {
        const explicitEvent = event as { sender?: ReturnType<typeof h.makeSender> };
        const sessionId = ch === "pi:open"
          ? (args[0] as { uiSessionId?: string } | undefined)?.uiSessionId
          : typeof args[0] === "string" ? args[0] : undefined;
        const invokeEvent = explicitEvent?.sender || !sessionId
          ? explicitEvent
          : { sender: h.owners.get(sessionId) };
        const result = fn(invokeEvent, ...args);
        const sender = explicitEvent?.sender;
        if (ch === "pi:open" && sessionId && sender) {
          return Promise.resolve(result).then((value) => {
            h.owners.set(sessionId, sender);
            return value;
          });
        }
        return result;
      },
    ),
  },
}));
vi.mock("../agents/pi-gateway/client", () => ({ openPiGatewaySession: h.openPiGatewaySession }));
vi.mock("../capabilities/delegate/server", () => ({
  ensureDelegateMcpServerConfig: h.ensureDelegateMcpServerConfig,
  registerDelegateSession: h.registerDelegateSession,
  unregisterDelegateSession: h.unregisterDelegateSession,
}));
vi.mock("../capabilities/design-delegate/server", () => ({
  ensureDesignDelegateMcpServerConfig: h.ensureDesignDelegateMcpServerConfig,
  registerDesignDelegateSession: h.registerDesignDelegateSession,
  unregisterDesignDelegateSession: h.unregisterDesignDelegateSession,
}));
vi.mock("../capabilities/slides/server", () => ({
  ensureSlidesMcpServerConfig: h.ensureSlidesMcpServerConfig,
}));
vi.mock("../capabilities/slides/session", () => ({
  registerSlidesSession: h.registerSlidesSession,
  unregisterSlidesSession: h.unregisterSlidesSession,
}));
vi.mock("./artifact-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artifact-workspace")>();
  return {
    ...actual,
    isKnownConversationArtifactRoot: h.isKnownConversationArtifactRoot,
    validateConversationArtifact: h.validateConversationArtifact,
  };
});
vi.mock("./fs", () => ({ assertAllowed: h.assertAllowed }));
vi.mock("../providers/pi-provider-input", () => ({ resolvePiProviderInput: h.resolvePiProviderInput }));
vi.mock("../providers/pi-inproc-models", () => ({ assertCustomProviderReady: h.assertCustomProviderReady }));
vi.mock("../providers/custom-providers", () => ({ listCustomProviders: async () => h.customProviders }));
vi.mock("./cli", () => ({
  assertSpawnCwd: h.assertSpawnCwd,
  resolveSpawnCwd: h.resolveSpawnCwd,
}));
vi.mock("./image", () => ({ readImageBytes: h.readImageBytes }));
vi.mock("./agent-trace", () => ({ recordAgentTrace: h.recordAgentTrace, recordStreamDelta: h.recordStreamDelta }));
vi.mock("./store", () => ({ getPersistedState: h.getPersistedState }));
vi.mock("../capabilities/browser/inject", () => ({ buildBrowserMcpServerConfig: h.buildBrowserMcpServerConfig }));
vi.mock("../capabilities/research/inject", () => ({
  buildResearchMcpServerConfig: h.buildResearchMcpServerConfig,
}));
vi.mock("../capabilities/agent-browser/locate", () => ({ resolveAgentBrowserBinary: h.resolveAgentBrowserBinary }));
vi.mock("../capabilities/agent-browser/inject", () => ({
  buildAgentBrowserMcpServerConfig: h.buildAgentBrowserMcpServerConfig,
  migrateLegacyAgentBrowserMcp: h.migrateLegacyAgentBrowserMcp,
}));
vi.mock("../agents/pi-mcp-bridge", () => ({
  collectBridgeServers: h.collectBridgeServers,
  mcpServerToBridge: h.mcpServerToBridge,
}));
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
  return { sender: h.makeSender() };
}

// 调 pi:open handler,返回 { event, result }。
async function open(req: Partial<PiOpenRequest> = {}) {
  const full: PiOpenRequest = { uiSessionId: "u1", cwd: "/proj", ...req };
  const existingOwner = h.owners.get(full.uiSessionId);
  // 同 owner 重开时 production 会留下一个受 entry identity 守卫的旧 destroyed listener；
  // mock 不会真的派发全部 listener，清调用记录让用例取得本代 handler。
  existingOwner?.once.mockClear();
  const event = existingOwner ? { sender: existingOwner } : fakeEvent();
  const result = (await h.handlers.get("pi:open")!(event, full)) as PiOpenResult;
  return { event, result };
}

beforeEach(() => {
  killAllPiSessions();
  h.handlers.clear();
  h.instances.length = 0;
  h.openRequests.length = 0;
  h.owners.clear();
  h.onEventRef.current = null;
  h.openPiGatewaySession.mockClear();
  h.delegateStates.clear();
  h.designStates.clear();
  h.slidesStates.clear();
  h.ensureDelegateMcpServerConfig.mockReset().mockResolvedValue(null);
  h.registerDelegateSession.mockClear();
  h.unregisterDelegateSession.mockClear();
  h.ensureDesignDelegateMcpServerConfig.mockReset().mockResolvedValue(null);
  h.registerDesignDelegateSession.mockClear();
  h.unregisterDesignDelegateSession.mockClear();
  h.ensureSlidesMcpServerConfig.mockReset().mockResolvedValue(null);
  h.registerSlidesSession.mockClear();
  h.unregisterSlidesSession.mockClear();
  h.isKnownConversationArtifactRoot.mockReset().mockReturnValue(true);
  h.validateConversationArtifact.mockReset().mockImplementation(async (artifact) => artifact);
  h.assertAllowed.mockReset().mockResolvedValue(undefined);
  h.resolvePiProviderInput.mockReset().mockResolvedValue(undefined);
  h.assertCustomProviderReady.mockReset().mockResolvedValue(undefined);
  h.customProviders.length = 0;
  h.readImageBytes.mockClear();
  h.recordAgentTrace.mockClear();
  h.recordStreamDelta.mockClear();
  h.getPersistedState.mockReset().mockResolvedValue({ generalSettings: {} });
  h.buildBrowserMcpServerConfig.mockReset().mockReturnValue(null);
  h.buildResearchMcpServerConfig.mockReset().mockReturnValue(null);
  h.resolveAgentBrowserBinary.mockReset().mockReturnValue("/app/agent-browser");
  h.buildAgentBrowserMcpServerConfig.mockReset().mockReturnValue({
    id: "agent-browser",
    transport: "stdio",
    command: "/app/agent-browser",
    args: ["mcp", "--tools", "all"],
  });
  h.migrateLegacyAgentBrowserMcp.mockReset().mockImplementation((settings) => settings);
  h.collectBridgeServers.mockReset().mockReturnValue([]);
  h.mcpServerToBridge.mockReset().mockImplementation((server) => server);
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
      "pi:switchSession",
      "pi:getState",
      "pi:snapshotSession",
      "pi:getStats",
      "pi:uiResponse",
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
    expect(h.openRequests[0]!.requiredBridgeServerIds).toEqual([]);
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

  it("providerId 解析不出且没有自定义定义 → provider 保持为空，worker 侧响亮失败", async () => {
    h.resolvePiProviderInput.mockResolvedValue(undefined);
    await open({ uiSessionId: "u1", providerId: "my-custom" });
    expect(h.openRequests[0]!.provider).toBeUndefined();
    // providerId 原样透传给 worker。
    expect(h.openRequests[0]!.providerId).toBe("my-custom");
  });

  it("自定义 Provider → 只把主进程已保存定义交给 worker，renderer 伪造值被丢弃", async () => {
    const stored = { id: "ollama", json: '{"baseUrl":"http://127.0.0.1:8000/v1","models":[]}' };
    h.customProviders.push(stored);
    await open({
      uiSessionId: "u1",
      providerId: "ollama",
      customProvider: { id: "attacker", json: '{"baseUrl":"http://attacker.invalid","models":[]}' },
    });
    expect(h.assertCustomProviderReady).toHaveBeenCalledWith("ollama");
    expect(h.openRequests[0]!.customProvider).toEqual(stored);
  });

  it("调用方自带 provider 被丢弃，仅按 providerId 在主进程重解", async () => {
    const forged = { id: "deepseek", baseUrl: "http://attacker.invalid", models: [] };
    const resolved = { id: "deepseek", baseUrl: "https://api.deepseek.com", models: [] };
    h.resolvePiProviderInput.mockResolvedValue(resolved);
    await open({ uiSessionId: "u1", providerId: "deepseek", provider: forged });
    expect(h.resolvePiProviderInput).toHaveBeenCalledWith("deepseek");
    expect(h.openRequests[0]!.provider).toBe(resolved);
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
    const { event } = await open();
    const first = h.instances[0];
    const oldDestroyedHandler = event.sender.once.mock.calls.find(([name]) => name === "destroyed")?.[1];
    await open();
    const second = h.instances[1];
    expect(first.stop).toHaveBeenCalled();
    expect(event.sender.removeListener).toHaveBeenCalledWith("destroyed", oldDestroyedHandler);
    expect(second).not.toBe(first);
    expect(piSessionCount()).toBe(1);
  });

  it.each([
    ["pi:setModel", "setModel", ["anthropic", "model-a"], { providerId: "openai", model: "model-b" }],
    ["pi:setThinking", "setThinkingLevel", ["low"], { thinkingLevel: "high" }],
  ] as const)("%s 的旧代迟到响应不得污染已重开的新代请求", async (
    channel,
    method,
    args,
    nextConfig,
  ) => {
    const { event } = await open({
      uiSessionId: "runtime-generation",
      providerId: "openai",
      model: "model-a",
      thinkingLevel: "low",
    });
    const oldSession = h.instances[0]!;
    let releaseCommand: (() => void) | undefined;
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    oldSession[method].mockImplementationOnce(async () => {
      await commandGate;
      return { success: true };
    });

    const staleCommand = Promise.resolve(h.handlers.get(channel)!(event, "runtime-generation", ...args));
    await vi.waitFor(() => expect(oldSession[method]).toHaveBeenCalledTimes(1));
    await open({ uiSessionId: "runtime-generation", ...nextConfig });
    const currentRequest = h.openRequests[1]!;

    releaseCommand?.();
    await staleCommand;
    expect(currentRequest).toMatchObject(nextConfig);
  });

  it("安全:renderer 传来的内部 env / required bridge 标记在边界上被清空", async () => {
    const req: PiOpenRequest = {
      uiSessionId: "u1",
      cwd: "/proj",
      computerUseEnv: { PATH: "/tmp/evil" },
      customProviderEnv: { NODE_OPTIONS: "--require /tmp/x.js" },
      customProvider: { id: "attacker", json: '{"baseUrl":"http://attacker.invalid","models":[]}' },
      requiredBridgeServerIds: ["renderer-controlled"],
    };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.openRequests[0]!.customProviderEnv).toBeUndefined();
    expect(h.openRequests[0]!.customProvider).toBeUndefined();
    // computerUseEnv 只可能由主进程的 Computer Use 决策重新填充（本用例门控未过 → 保持空）。
    expect(h.openRequests[0]!.computerUseEnv).toBeUndefined();
    expect(h.openRequests[0]!.requiredBridgeServerIds).toEqual([]);
  });

  it("异 renderer 不能替换或操纵已有会话的任一 pi:* 入口", async () => {
    const { event: ownerEvent } = await open({ uiSessionId: "owned" });
    const session = h.instances[0]!;
    const foreignEvent = fakeEvent();

    await expect(h.handlers.get("pi:open")!(foreignEvent, {
      uiSessionId: "owned",
      cwd: "/attacker",
    })).rejects.toThrow("不属于当前 renderer");

    const foreignCalls: Array<[string, ...unknown[]]> = [
      ["pi:prompt", "owned", "越权 prompt", "run-x"],
      ["pi:steer", "owned", "越权 steer"],
      ["pi:followUp", "owned", "越权 follow-up"],
      ["pi:abort", "owned"],
      ["pi:fork", "owned", "entry-x"],
      ["pi:getForkMessages", "owned"],
      ["pi:setModel", "owned", "openai", "model-x"],
      ["pi:setThinking", "owned", "high"],
      ["pi:compact", "owned", "越权 compact"],
      ["pi:switchSession", "owned", "/tmp/foreign.jsonl"],
      ["pi:getState", "owned"],
      ["pi:snapshotSession", "owned", "branch-x"],
      ["pi:getStats", "owned"],
      ["pi:uiResponse", "owned", "approval-x", { confirmed: true }],
      ["pi:close", "owned"],
    ];
    for (const [channel, ...args] of foreignCalls) {
      await expect(Promise.resolve().then(() => h.handlers.get(channel)!(foreignEvent, ...args))).rejects.toThrow(
        "不属于当前 renderer",
      );
    }

    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.respondUi).not.toHaveBeenCalled();
    expect(session.stop).not.toHaveBeenCalled();
    // owner 仍可继续操作，证明失败的替换没有抢走所有权。
    await h.handlers.get("pi:prompt")!(ownerEvent, "owned", "合法 prompt", "run-owner");
    expect(session.prompt).toHaveBeenCalledWith("合法 prompt", "run-owner");
  });
});

describe("Pi RPC delegate 子 Agent", () => {
  const provider = { id: "openai", baseUrl: "https://gateway.example.com", models: [] };
  const codexRole: RoleConfig = {
    id: "reviewer",
    label: "Reviewer",
    agent: "codex",
    model: "gpt-5-codex",
    systemPrompt: "只报告可复现的问题。",
    createdAt: "",
    updatedAt: "",
  };

  async function openDelegateParent(role: RoleConfig = codexRole) {
    h.resolvePiProviderInput.mockImplementation(async (providerId) =>
      providerId === "openai" ? provider : undefined,
    );
    h.ensureDelegateMcpServerConfig.mockResolvedValue({
      id: "cortex-delegate",
      transport: "http",
      url: "http://127.0.0.1:4242/mcp",
    });
    h.collectBridgeServers.mockImplementation((servers: unknown[] = []) => servers);
    const opened = await open({
      uiSessionId: "parent-ui",
      cwd: "/project",
      model: "parent-model",
      providerId: "openai",
      provider,
      thinkingLevel: "high",
      enableToolApproval: true,
      approvalTools: ["bash", "write", "edit"],
      delegateRoles: [role],
      delegatePolicy: { maxParallel: 2, maxChildRuns: 4 },
    });
    const state = h.delegateStates.get("parent-ui");
    expect(state).toBeDefined();
    return { ...opened, state: state! };
  }

  it("prepare 前注册父 delegate state，并把 delegate MCP 交给 gateway", async () => {
    await openDelegateParent();

    expect(h.registerDelegateSession).toHaveBeenCalledTimes(1);
    expect(h.ensureDelegateMcpServerConfig).toHaveBeenCalledWith("parent-ui");
    expect(h.registerDelegateSession.mock.invocationCallOrder[0]).toBeLessThan(
      h.ensureDelegateMcpServerConfig.mock.invocationCallOrder[0]!,
    );
    expect(h.openRequests[0]!.bridgeServers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "cortex-delegate" })]),
    );
    expect(h.openRequests[0]!.requiredBridgeServerIds).toEqual(["cortex-delegate"]);
  });

  it.each([
    ["返回 null", () => h.ensureDelegateMcpServerConfig.mockResolvedValue(null), /delegate MCP 不可用/i],
    ["启动 reject", () => h.ensureDelegateMcpServerConfig.mockRejectedValue(new Error("bind EADDRINUSE")), /delegate MCP 启动失败.*EADDRINUSE/i],
  ])("required delegate host %s 时 pi:open 响亮失败且注销 state", async (_label, arrange, expected) => {
    arrange();
    await expect(open({ uiSessionId: "required-fail", delegateRoles: [codexRole] })).rejects.toThrow(expected);
    expect(h.openPiGatewaySession).not.toHaveBeenCalled();
    expect(h.unregisterDelegateSession).toHaveBeenCalledWith("required-fail", expect.any(Object));
    expect(h.delegateStates.has("required-fail")).toBe(false);
  });

  it("普通 MCP 状态读取失败时仍把已验证的 required delegate bridge 交给 gateway", async () => {
    h.ensureDelegateMcpServerConfig.mockResolvedValue({
      id: "cortex-delegate",
      transport: "http",
      url: "http://127.0.0.1:4242/mcp",
    });
    h.getPersistedState.mockRejectedValue(new Error("store unavailable"));

    await open({ uiSessionId: "delegate-only", delegateRoles: [codexRole] });

    expect(h.openRequests[0]!.bridgeServers).toEqual([
      expect.objectContaining({ id: "cortex-delegate" }),
    ]);
    expect(h.openRequests[0]!.requiredBridgeServerIds).toEqual(["cortex-delegate"]);
  });

  it("无论角色原 agent 都用短生命周期 gateway，继承父 provider/model/审批并在完成后 stop", async () => {
    const { state } = await openDelegateParent();
    const childEvents: unknown[] = [];
    const pending = state.runSubAgent(state.roles[0]!, "检查实现", (event) => childEvents.push(event), "child-1");

    await vi.waitFor(() => expect(h.openPiGatewaySession).toHaveBeenCalledTimes(2));
    const childIndex = h.openRequests.findIndex((request) => request.uiSessionId === "child-1");
    const childRequest = h.openRequests[childIndex]!;
    const child = h.instances[childIndex]!;
    expect(state.roles[0]).toMatchObject({ agent: "pi", model: undefined });
    expect(childRequest).toMatchObject({
      uiSessionId: "child-1",
      cwd: "/project",
      model: "parent-model",
      providerId: "openai",
      provider,
      thinkingLevel: "high",
      enableToolApproval: true,
      approvalTools: ["bash", "write", "edit"],
      appendSystemPrompt: "只报告可复现的问题。",
      requiredBridgeServerIds: [],
    });
    expect(childRequest.delegateRoles).toBeUndefined();

    child.onEvent({ type: "text", delta: "发现" });
    child.onEvent({ type: "result", willRetry: false });
    // message_end/agent_end 的 result 之后仍可能有 extension follow-up；必须等 settled 才能 stop。
    expect(child.stop).not.toHaveBeenCalled();
    child.onEvent({ type: "text", delta: "问题" });
    child.onEvent({ type: "settled" });
    await expect(pending).resolves.toEqual({ text: "发现问题", ok: true });
    expect(childEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", delta: "发现" }),
      expect.objectContaining({ type: "text", delta: "问题" }),
    ]));
    expect(child.stop).toHaveBeenCalledTimes(1);
  });

  it("原生 Pi 角色保留自身 model/effort override，未覆盖字段才继承父会话", async () => {
    const piRole: RoleConfig = {
      ...codexRole,
      id: "pi-specialist",
      agent: "pi",
      model: "child-model",
      effort: "xhigh",
    };
    const { state } = await openDelegateParent(piRole);
    const pending = state.runSubAgent(state.roles[0]!, "专项分析", () => {}, "child-pi-override");
    await vi.waitFor(() => expect(h.openRequests.some((request) => request.uiSessionId === "child-pi-override")).toBe(true));
    const childIndex = h.openRequests.findIndex((request) => request.uiSessionId === "child-pi-override");
    const childRequest = h.openRequests[childIndex]!;
    const child = h.instances[childIndex]!;
    expect(state.roles[0]).toMatchObject({ agent: "pi", model: "child-model", effort: "xhigh" });
    expect(childRequest.model).toBe("child-model");
    expect(childRequest.thinkingLevel).toBe("xhigh");
    expect(childRequest.provider).toBe(provider);

    child.onEvent({ type: "result", willRetry: false });
    child.onEvent({ type: "settled" });
    await expect(pending).resolves.toEqual({ text: "", ok: true });
  });

  it("父会话运行时切换 model/thinking 后，未覆盖的 child 继承最新值", async () => {
    const { state } = await openDelegateParent();
    await h.handlers.get("pi:setModel")!({}, "parent-ui", "anthropic", "parent-model-v2");
    await h.handlers.get("pi:setThinking")!({}, "parent-ui", "max");

    const pending = state.runSubAgent(state.roles[0]!, "读取最新父配置", () => {}, "child-live-config");
    await vi.waitFor(() => expect(h.openRequests.some((request) => request.uiSessionId === "child-live-config")).toBe(true));
    const childIndex = h.openRequests.findIndex((request) => request.uiSessionId === "child-live-config");
    const childRequest = h.openRequests[childIndex]!;
    const child = h.instances[childIndex]!;
    expect(childRequest.model).toBe("parent-model-v2");
    expect(childRequest.thinkingLevel).toBe("max");
    expect(childRequest.providerId).toBe("anthropic");
    expect(childRequest.provider).toBeUndefined(); // 不得把 open 时的旧 OpenAI endpoint 快照带给新 provider。

    child.onEvent({ type: "result", willRetry: false });
    child.onEvent({ type: "settled" });
    await expect(pending).resolves.toEqual({ text: "", ok: true });
  });

  it("每次 pi:prompt 都重建 delegate 代际，childRunCount 不跨轮累积", async () => {
    const { state: initial } = await openDelegateParent();
    initial.childRunCount = 3;

    await h.handlers.get("pi:prompt")!({}, "parent-ui", "第一轮", "run-1");
    const firstTurn = h.delegateStates.get("parent-ui")!;
    expect(firstTurn).not.toBe(initial);
    expect(initial.signal.aborted).toBe(true);
    expect(firstTurn.runId).toBe("run-1");
    expect(firstTurn.childRunCount).toBe(0);
    firstTurn.childRunCount = 4;

    await h.handlers.get("pi:prompt")!({}, "parent-ui", "第二轮", "run-2");
    const secondTurn = h.delegateStates.get("parent-ui")!;
    expect(secondTurn).not.toBe(firstTurn);
    expect(firstTurn.signal.aborted).toBe(true);
    expect(secondTurn.runId).toBe("run-2");
    expect(secondTurn.childRunCount).toBe(0);
  });

  it("图片准备期间 abort 会撤销本轮 delegate 代际，且迟到 continuation 不启动父 prompt", async () => {
    const { state: initial } = await openDelegateParent();
    let releaseImage!: () => void;
    h.readImageBytes.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseImage = () => resolve({ mimeType: "image/png", base64: "AAAA" });
      }),
    );

    const pendingPrompt = h.handlers.get("pi:prompt")!(
      {},
      "parent-ui",
      "慢图片委派",
      "run-delegate-slow",
      ["/img/slow.png"],
    );
    await vi.waitFor(() => expect(h.readImageBytes).toHaveBeenCalledTimes(1));
    const promptState = h.delegateStates.get("parent-ui")!;
    expect(promptState).not.toBe(initial);

    await h.handlers.get("pi:abort")!({}, "parent-ui");
    expect(promptState.signal.aborted).toBe(true);
    expect(h.delegateStates.has("parent-ui")).toBe(false);
    releaseImage();

    await expect(pendingPrompt).resolves.toEqual({ accepted: false, cancelled: true });
    expect(h.instances[0]!.prompt).not.toHaveBeenCalled();
  });

  it("readOnly 角色强制使用 Pi plan 白名单并关闭写工具审批入口", async () => {
    const { state } = await openDelegateParent({ ...codexRole, toolPolicy: "readOnly" });
    const pending = state.runSubAgent(state.roles[0]!, "只读检查", () => {}, "child-readonly");

    await vi.waitFor(() => expect(h.openRequests.some((request) => request.uiSessionId === "child-readonly")).toBe(true));
    const childIndex = h.openRequests.findIndex((request) => request.uiSessionId === "child-readonly");
    const childRequest = h.openRequests[childIndex]!;
    const child = h.instances[childIndex]!;
    expect(childRequest.toolWhitelist).toEqual(PI_PLAN_TOOL_WHITELIST);
    expect(childRequest.enableToolApproval).toBe(false);
    expect(childRequest.approvalTools).toBeUndefined();

    child.onEvent({ type: "result", willRetry: false });
    child.onEvent({ type: "settled" });
    await expect(pending).resolves.toEqual({ text: "", ok: true });
  });

  it("两个 child 的相同 native UI request id 路由为不同父 id，响应不串 engine", async () => {
    const { event, state } = await openDelegateParent();
    const first = state.runSubAgent(state.roles[0]!, "任务 A", () => {}, "child-a");
    const second = state.runSubAgent(state.roles[0]!, "任务 B", () => {}, "child-b");
    await vi.waitFor(() => expect(h.openPiGatewaySession).toHaveBeenCalledTimes(3));

    const indexA = h.openRequests.findIndex((request) => request.uiSessionId === "child-a");
    const indexB = h.openRequests.findIndex((request) => request.uiSessionId === "child-b");
    const childA = h.instances[indexA]!;
    const childB = h.instances[indexB]!;
    const nativeRequest = {
      type: "extension_ui_request",
      id: "same-native-id",
      method: "confirm",
      title: "执行命令",
      message: "确认吗？",
    };
    childA.onUiRequest(nativeRequest);
    childB.onUiRequest(nativeRequest);

    const routed = event.sender.send.mock.calls
      .filter(([channel]) => channel === "pi:uiRequest")
      .map(([, payload]) => payload as { uiSessionId: string; request: { id: string } });
    expect(routed).toHaveLength(2);
    expect(routed[0]!.uiSessionId).toBe("parent-ui");
    expect(routed[1]!.uiSessionId).toBe("parent-ui");
    expect(routed[0]!.request.id).not.toBe("same-native-id");
    expect(routed[1]!.request.id).not.toBe("same-native-id");
    expect(routed[0]!.request.id).not.toBe(routed[1]!.request.id);

    await h.handlers.get("pi:uiResponse")!({}, "parent-ui", routed[0]!.request.id, { confirmed: true });
    await h.handlers.get("pi:uiResponse")!({}, "parent-ui", routed[1]!.request.id, { cancelled: true });
    expect(childA.respondUi).toHaveBeenCalledWith("same-native-id", { confirmed: true });
    expect(childB.respondUi).toHaveBeenCalledWith("same-native-id", { cancelled: true });

    childA.onEvent({ type: "result", willRetry: false });
    childB.onEvent({ type: "result", willRetry: false });
    childA.onEvent({ type: "settled" });
    childB.onEvent({ type: "settled" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { text: "", ok: true },
      { text: "", ok: true },
    ]);
  });

  it("父 pi:abort 级联取消 child 并注销 delegate state", async () => {
    const { state } = await openDelegateParent();
    const pending = state.runSubAgent(state.roles[0]!, "长任务", () => {}, "child-abort");
    await vi.waitFor(() => expect(h.openRequests.some((request) => request.uiSessionId === "child-abort")).toBe(true));
    const childIndex = h.openRequests.findIndex((request) => request.uiSessionId === "child-abort");
    const child = h.instances[childIndex]!;

    await h.handlers.get("pi:abort")!({}, "parent-ui");

    await expect(pending).resolves.toEqual({ text: "", ok: false, error: "已取消" });
    expect(child.stop).toHaveBeenCalledTimes(1);
    expect(h.unregisterDelegateSession).toHaveBeenCalledWith("parent-ui", expect.any(Object));
    expect(h.delegateStates.has("parent-ui")).toBe(false);
  });

  it("父 pi:close 与 WebContents destroyed 都会停止 child、注销 state 且清父会话", async () => {
    const first = await openDelegateParent();
    const closing = first.state.runSubAgent(first.state.roles[0]!, "关闭期间任务", () => {}, "child-close");
    await vi.waitFor(() => expect(h.openRequests.some((request) => request.uiSessionId === "child-close")).toBe(true));
    const closeChild = h.instances[h.openRequests.findIndex((request) => request.uiSessionId === "child-close")]!;
    await h.handlers.get("pi:close")!({}, "parent-ui");
    await expect(closing).resolves.toEqual({ text: "", ok: false, error: "已取消" });
    expect(closeChild.stop).toHaveBeenCalledTimes(1);
    expect(piSessionCount()).toBe(0);

    const second = await openDelegateParent();
    const destroying = second.state.runSubAgent(
      second.state.roles[0]!,
      "窗口销毁期间任务",
      () => {},
      "child-destroy",
    );
    await vi.waitFor(() => expect(h.openRequests.some((request) => request.uiSessionId === "child-destroy")).toBe(true));
    const destroyChild = h.instances[h.openRequests.findIndex((request) => request.uiSessionId === "child-destroy")]!;
    const destroyedHandler = second.event.sender.once.mock.calls.find(([name]) => name === "destroyed")?.[1] as
      | (() => void)
      | undefined;
    expect(destroyedHandler).toBeTypeOf("function");
    destroyedHandler!();
    await expect(destroying).resolves.toEqual({ text: "", ok: false, error: "已取消" });
    expect(destroyChild.stop).toHaveBeenCalledTimes(1);
    expect(h.unregisterDelegateSession).toHaveBeenCalledWith("parent-ui", expect.any(Object));
    expect(piSessionCount()).toBe(0);
  });

  it("child 超时会返回明确错误并 stop，不遗留 transient UI 路由", async () => {
    const { event, state } = await openDelegateParent();
    const parent = h.instances[h.openRequests.findIndex((request) => request.uiSessionId === "parent-ui")]!;
    vi.useFakeTimers();
    try {
      const pending = state.runSubAgent(state.roles[0]!, "永不结束", () => {}, "child-timeout");
      // prepare/open/ready 都是异步微任务；先排空到 child 已建立，再推进 30 分钟硬超时。
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const childIndex = h.openRequests.findIndex((request) => request.uiSessionId === "child-timeout");
      expect(childIndex).toBeGreaterThanOrEqual(0);
      const child = h.instances[childIndex]!;
      child.onUiRequest({
        type: "extension_ui_request",
        id: "pending-native-id",
        method: "confirm",
        title: "确认",
        message: "等待用户",
      });
      const routedId = (event.sender.send.mock.calls.find(([channel]) => channel === "pi:uiRequest")?.[1] as {
        request: { id: string };
      }).request.id;

      await vi.advanceTimersByTimeAsync(30 * 60_000);

      await expect(pending).resolves.toEqual({ text: "", ok: false, error: "子 Agent 超时（30 分钟）" });
      expect(child.stop).toHaveBeenCalledTimes(1);
      expect(event.sender.send).toHaveBeenCalledWith("pi:uiCancel", {
        uiSessionId: "parent-ui",
        requestId: routedId,
      });
      // transient 已按 child adapter 摘除，迟到响应不能误落到父 engine。
      await h.handlers.get("pi:uiResponse")!({}, "parent-ui", routedId, { confirmed: true });
      expect(child.respondUi).not.toHaveBeenCalled();
      expect(parent.respondUi).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Pi RPC artifact 能力边界", () => {
  const slidesArtifact: ConversationArtifactRef = {
    kind: "slides",
    documentId: "deck-1",
    title: "Deck",
    workspaceRoot: "/artifact-root",
    entryPath: "/artifact-root/.cortex-design/deck-1/index.html",
    createdAt: 1,
    updatedAt: 1,
  };

  function arrangeArtifactHosts(): void {
    h.isKnownConversationArtifactRoot.mockReturnValue(true);
    h.ensureDesignDelegateMcpServerConfig.mockResolvedValue({
      id: "cortex-design-delegate",
      transport: "http",
      url: "http://127.0.0.1:4301/mcp",
    });
    h.ensureSlidesMcpServerConfig.mockResolvedValue({
      id: "cortex-slides",
      transport: "http",
      url: "http://127.0.0.1:4302/mcp",
    });
    h.buildResearchMcpServerConfig.mockReturnValue({
      id: "cortex-research",
      transport: "http",
      url: "http://127.0.0.1:4303/mcp",
    });
    h.collectBridgeServers.mockImplementation((servers: unknown[] = [], browser?: unknown) => [
      ...servers,
      ...(browser ? [browser] : []),
    ]);
    h.getPersistedState.mockResolvedValue({
      generalSettings: {
        mcp: { enabled: true, servers: [{ id: "user-mcp", transport: "http", url: "https://evil.invalid/mcp" }] },
        browserControl: { enabled: true },
        knowledgeBase: { enabled: true },
        computerUse: { enabled: true },
      },
    });
  }

  async function openSlidesArtifact(
    overrides: Partial<PiOpenRequest> = {},
  ): Promise<Awaited<ReturnType<typeof open>>> {
    arrangeArtifactHosts();
    return open({
      uiSessionId: "artifact-parent",
      cwd: slidesArtifact.workspaceRoot,
      artifactContext: slidesArtifact,
      model: "parent-model",
      providerId: "openai",
      enableToolApproval: true,
      approvalTools: ["bash", "write", "edit"],
      ...overrides,
    });
  }

  it("open 复验 root/cwd/index，在 prepare 前注册 state，并仅注入 artifact 最小能力", async () => {
    const { result } = await openSlidesArtifact({
      extensionPaths: ["/tmp/renderer-extension"],
      inProcExtensionPaths: ["/tmp/renderer-inproc-extension"],
      enableArtifactsTool: true,
      enableJsReplTool: true,
      enableSampleTools: true,
      enableSampleCommands: true,
    });

    expect(result.uiSessionId).toBe("artifact-parent");
    expect(h.isKnownConversationArtifactRoot).toHaveBeenCalledWith(
      slidesArtifact.workspaceRoot,
      expect.objectContaining({ generalSettings: expect.any(Object) }),
      expect.any(String),
    );
    expect(h.assertAllowed).toHaveBeenCalledWith(slidesArtifact.workspaceRoot);
    expect(h.validateConversationArtifact).toHaveBeenCalledWith(slidesArtifact);
    expect(h.registerDesignDelegateSession.mock.invocationCallOrder[0]).toBeLessThan(
      h.ensureDesignDelegateMcpServerConfig.mock.invocationCallOrder[0]!,
    );
    expect(h.registerSlidesSession.mock.invocationCallOrder[0]).toBeLessThan(
      h.ensureSlidesMcpServerConfig.mock.invocationCallOrder[0]!,
    );

    const sent = h.openRequests[0]!;
    const bridgeIds = sent.bridgeServers?.map((server) => server.id) ?? [];
    expect(bridgeIds).toEqual(expect.arrayContaining([
      "cortex-design-delegate",
      "cortex-slides",
      "cortex-research",
    ]));
    expect(bridgeIds).not.toContain("user-mcp");
    expect(sent.requiredBridgeServerIds).toEqual([
      "cortex-design-delegate",
      "cortex-slides",
    ]);
    expect(h.buildResearchMcpServerConfig).toHaveBeenCalledWith(
      undefined,
      "artifact-parent",
      "slides",
      false,
    );
    expect(h.resolveAgentBrowserBinary).not.toHaveBeenCalled();
    expect(h.buildAgentBrowserMcpServerConfig).not.toHaveBeenCalled();
    expect(h.buildBrowserMcpServerConfig).not.toHaveBeenCalled();
    expect(h.resolveComputerUse).not.toHaveBeenCalled();
    expect(sent).toMatchObject({
      extensionPaths: [],
      enableArtifactsTool: false,
      enableJsReplTool: false,
      enableSampleTools: false,
      enableSampleCommands: false,
    });
    expect(sent.inProcExtensionPaths).toBeUndefined();
  });

  it("伪造 root/cwd 或 required MCP 不可用时 fail-loud，且不遗留 capability state", async () => {
    arrangeArtifactHosts();
    h.isKnownConversationArtifactRoot.mockReturnValue(false);
    await expect(open({
      uiSessionId: "unknown-root",
      cwd: slidesArtifact.workspaceRoot,
      artifactContext: slidesArtifact,
    })).rejects.toThrow("产物工作区未注册");
    expect(h.openPiGatewaySession).not.toHaveBeenCalled();

    arrangeArtifactHosts();
    await expect(open({
      uiSessionId: "wrong-cwd",
      cwd: "/other-root",
      artifactContext: slidesArtifact,
    })).rejects.toThrow("产物 cwd 不匹配");

    arrangeArtifactHosts();
    h.ensureSlidesMcpServerConfig.mockResolvedValue(null);
    await expect(open({
      uiSessionId: "required-fail",
      cwd: slidesArtifact.workspaceRoot,
      artifactContext: slidesArtifact,
    })).rejects.toThrow(/Pi slides MCP 不可用/);
    expect(h.designStates.has("required-fail")).toBe(false);
    expect(h.slidesStates.has("required-fail")).toBe(false);
    expect(h.unregisterDesignDelegateSession).toHaveBeenCalledWith("required-fail", expect.any(Object));
    expect(h.unregisterSlidesSession).toHaveBeenCalledWith("required-fail", expect.any(Object));
  });

  it("worker required bridge 接入失败时 open 原样失败并清理预注册 state", async () => {
    arrangeArtifactHosts();
    h.openPiGatewaySession.mockRejectedValueOnce(
      new Error("Pi required MCP 接入失败: cortex-slides"),
    );

    await expect(open({
      uiSessionId: "worker-required-fail",
      cwd: slidesArtifact.workspaceRoot,
      artifactContext: slidesArtifact,
    })).rejects.toThrow("Pi required MCP 接入失败: cortex-slides");

    expect(h.designStates.has("worker-required-fail")).toBe(false);
    expect(h.slidesStates.has("worker-required-fail")).toBe(false);
    expect(h.unregisterDesignDelegateSession).toHaveBeenCalledWith(
      "worker-required-fail",
      expect.any(Object),
    );
    expect(h.unregisterSlidesSession).toHaveBeenCalledWith(
      "worker-required-fail",
      expect.any(Object),
    );
  });

  it("prompt 校验 artifact run identity，按 runId 换代并在 settled 时撤销能力", async () => {
    await openSlidesArtifact();
    const initialDesign = h.designStates.get("artifact-parent")!;
    const parent = h.instances[0]!;

    await expect(
      h.handlers.get("pi:prompt")!({}, "artifact-parent", "非法回合", "artifact:slides:other:turn"),
    ).rejects.toThrow("产物 runId 不匹配");
    expect(parent.prompt).not.toHaveBeenCalled();
    expect(h.designStates.get("artifact-parent")).toBe(initialDesign);

    const runId = "artifact:slides:deck-1:turn-1";
    await h.handlers.get("pi:prompt")!({}, "artifact-parent", "生成幻灯片", runId);
    const currentDesign = h.designStates.get("artifact-parent")!;
    expect(currentDesign).not.toBe(initialDesign);
    expect(currentDesign.runId).toBe(runId);

    (parent.onEvent as unknown as (event: unknown, runId?: string) => void)({ type: "settled" }, runId);
    expect(h.designStates.has("artifact-parent")).toBe(false);
    expect(h.slidesStates.has("artifact-parent")).toBe(false);

    await open({ uiSessionId: "plain", cwd: "/proj" });
    await expect(
      h.handlers.get("pi:prompt")!({}, "plain", "伪造产物", "artifact:slides:deck-1:turn"),
    ).rejects.toThrow("产物 runId 缺少 artifactContext");
  });

  it("图片准备期间 abort 会撤销本轮 artifact 代际，且迟到 continuation 不启动 prompt", async () => {
    await openSlidesArtifact();
    let releaseImage!: () => void;
    h.readImageBytes.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseImage = () => resolve({ mimeType: "image/png", base64: "AAAA" });
      }),
    );
    const runId = "artifact:slides:deck-1:slow-image";

    const pendingPrompt = h.handlers.get("pi:prompt")!(
      {},
      "artifact-parent",
      "读取慢图片",
      runId,
      ["/img/slow.png"],
    );
    await vi.waitFor(() => expect(h.readImageBytes).toHaveBeenCalledTimes(1));
    const promptDesignState = h.designStates.get("artifact-parent")!;
    expect(promptDesignState.runId).toBe(runId);

    await h.handlers.get("pi:abort")!({}, "artifact-parent");
    expect(promptDesignState.signal.aborted).toBe(true);
    expect(h.designStates.has("artifact-parent")).toBe(false);
    expect(h.slidesStates.has("artifact-parent")).toBe(false);
    releaseImage();

    await expect(pendingPrompt).resolves.toEqual({ accepted: false, cancelled: true });
    expect(h.instances[0]!.prompt).not.toHaveBeenCalled();
  });

  it("design delegate child 强制 gateway、继承父审批且 UI 只路由到父窗口", async () => {
    const { event } = await openSlidesArtifact({
      extensionPaths: ["/tmp/parent-extension"],
      webSearch: true,
    });
    const runId = "artifact:slides:deck-1:turn-child";
    await h.handlers.get("pi:prompt")!({}, "artifact-parent", "并行生成", runId);
    const state = h.designStates.get("artifact-parent")!;

    const pending = state.runSubAgent("page:cover", "生成封面", () => {});
    await vi.waitFor(() => expect(h.openRequests.length).toBe(2));
    const childRequest = h.openRequests[1]!;
    const child = h.instances[1]!;
    expect(childRequest).toMatchObject({
      cwd: slidesArtifact.workspaceRoot,
      model: "parent-model",
      enableToolApproval: true,
      approvalTools: ["bash", "write", "edit"],
      bridgeServers: [],
      requiredBridgeServerIds: [],
      extensionPaths: [],
      webSearch: false,
    });
    expect(childRequest.artifactContext).toBeUndefined();
    expect(childRequest.delegateRoles).toBeUndefined();
    expect(h.resolveComputerUse).not.toHaveBeenCalled();

    child.onUiRequest({
      type: "extension_ui_request",
      id: "native-approval",
      method: "confirm",
      title: "确认",
      message: "执行 bash?",
    });
    const routed = event.sender.send.mock.calls.find(([channel, payload]) =>
      channel === "pi:uiRequest" &&
      (payload as { request?: { id?: string } }).request?.id?.startsWith("delegate:"),
    )?.[1] as { uiSessionId: string; request: { id: string } } | undefined;
    expect(routed?.uiSessionId).toBe("artifact-parent");
    await h.handlers.get("pi:uiResponse")!({}, "artifact-parent", routed!.request.id, { confirmed: true });
    expect(child.respondUi).toHaveBeenCalledWith("native-approval", { confirmed: true });

    child.onEvent({ type: "text", delta: "完成" });
    child.onEvent({ type: "settled" });
    await expect(pending).resolves.toEqual({ text: "完成", ok: true });
    expect(child.stop).toHaveBeenCalledTimes(1);
  });

  it("prompt 失败、abort、close、destroy、crash 与 reopen 都撤销自己的 artifact 代际", async () => {
    await openSlidesArtifact();
    h.instances[0]!.prompt.mockRejectedValueOnce(new Error("prompt failed"));
    await expect(
      h.handlers.get("pi:prompt")!({}, "artifact-parent", "失败", "artifact:slides:deck-1:failed"),
    ).rejects.toThrow("prompt failed");
    expect(h.designStates.has("artifact-parent")).toBe(false);

    await openSlidesArtifact();
    await h.handlers.get("pi:prompt")!({}, "artifact-parent", "中止", "artifact:slides:deck-1:abort");
    await h.handlers.get("pi:abort")!({}, "artifact-parent");
    expect(h.designStates.has("artifact-parent")).toBe(false);
    expect(h.slidesStates.has("artifact-parent")).toBe(false);

    await openSlidesArtifact();
    await h.handlers.get("pi:close")!({}, "artifact-parent");
    expect(h.designStates.has("artifact-parent")).toBe(false);

    const destroying = await openSlidesArtifact();
    const destroyedHandler = destroying.event.sender.once.mock.calls.find(([name]) => name === "destroyed")?.[1] as
      | (() => void)
      | undefined;
    destroyedHandler!();
    expect(h.slidesStates.has("artifact-parent")).toBe(false);

    await openSlidesArtifact();
    const crashing = h.instances[h.instances.length - 1]!;
    crashing.onEvent({ type: "crashed", error: "boom" });
    expect(h.designStates.has("artifact-parent")).toBe(false);

    await openSlidesArtifact();
    const oldState = h.designStates.get("artifact-parent")!;
    await openSlidesArtifact();
    const newState = h.designStates.get("artifact-parent")!;
    expect(newState).not.toBe(oldState);
    // 旧代即使此后迟到调用 expected-state unregister，也不能摘掉新代。
    h.unregisterDesignDelegateSession("artifact-parent", oldState);
    expect(h.designStates.get("artifact-parent")).toBe(newState);
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

  it("图片准备在途时 abort：旧 prompt 返回取消 no-op，绝不能在停止后迟到启动", async () => {
    await open();
    let releaseImage!: () => void;
    h.readImageBytes.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseImage = () => resolve({ mimeType: "image/png", base64: "AAAA" });
      }),
    );

    const pendingPrompt = h.handlers.get("pi:prompt")!({}, "u1", "慢图片", "run-slow", ["/img/slow.png"]);
    await vi.waitFor(() => expect(h.readImageBytes).toHaveBeenCalledTimes(1));
    await h.handlers.get("pi:abort")!({}, "u1");
    releaseImage();

    await expect(pendingPrompt).resolves.toEqual({ accepted: false, cancelled: true });
    expect(h.instances[0]!.abort).toHaveBeenCalledTimes(1);
    expect(h.instances[0]!.prompt).not.toHaveBeenCalled();
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
    await expect(Promise.resolve().then(() => h.handlers.get("pi:abort")!({}, "missing"))).rejects.toThrow(/不存在/);
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
  // 信封归一 P0:pi:event 载荷字段 uiSessionId → sessionId(与 cli:event 信封对齐)。
  it("普通事件 → sender.send('pi:event', {sessionId, event})", async () => {
    const { event } = await open();
    h.onEventRef.current!({ type: "text", delta: "你好" });
    expect(event.sender.send).toHaveBeenCalledWith("pi:event", {
      sessionId: "u1",
      event: { type: "text", delta: "你好" },
    });
  });

  it("并发多会话:事件按 sessionId 路由到各自 sender,互不串台", async () => {
    const e1 = fakeEvent();
    await h.handlers.get("pi:open")!(e1, { uiSessionId: "u1", cwd: "/p" });
    const e2 = fakeEvent();
    await h.handlers.get("pi:open")!(e2, { uiSessionId: "u2", cwd: "/p" });
    h.instances[0].onEvent({ type: "text", delta: "a" });
    h.instances[1].onEvent({ type: "text", delta: "b" });
    expect(e1.sender.send).toHaveBeenCalledWith("pi:event", { sessionId: "u1", event: { type: "text", delta: "a" } });
    expect(e2.sender.send).toHaveBeenCalledWith("pi:event", { sessionId: "u2", event: { type: "text", delta: "b" } });
    // 互不串台:各 sender 只收到自己 sessionId 的事件
    expect(e1.sender.send).not.toHaveBeenCalledWith("pi:event", expect.objectContaining({ sessionId: "u2" }));
    expect(e2.sender.send).not.toHaveBeenCalledWith("pi:event", expect.objectContaining({ sessionId: "u1" }));
  });

  it("同 id opening 期间占住 owner：并发重开被拒绝，owner 销毁后迟到 engine 立即 stop", async () => {
    let releaseGateway: (() => void) | undefined;
    const gatewayGate = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const delayed = h.makeSession();
    h.openPiGatewaySession.mockImplementationOnce(async (options) => {
      h.onEventRef.current = options.onEvent;
      delayed.onEvent = options.onEvent;
      if (options.onUiRequest) delayed.onUiRequest = options.onUiRequest;
      h.instances.push(delayed);
      h.openRequests.push(options.request);
      options.onSessionCreated?.(delayed);
      await gatewayGate;
      return delayed;
    });
    const ownerEvent = fakeEvent();
    const opening = Promise.resolve(
      h.handlers.get("pi:open")!(ownerEvent, { uiSessionId: "opening", cwd: "/p" }),
    );
    const rejected = expect(opening).rejects.toThrow("开启已取消");
    await vi.waitFor(() => expect(h.openPiGatewaySession).toHaveBeenCalled());

    await expect(
      h.handlers.get("pi:open")!(ownerEvent, { uiSessionId: "opening", cwd: "/same-owner" }),
    ).rejects.toThrow("正在开启");
    await expect(
      h.handlers.get("pi:open")!(fakeEvent(), { uiSessionId: "opening", cwd: "/foreign" }),
    ).rejects.toThrow("不属于当前 renderer");

    const destroyed = ownerEvent.sender.once.mock.calls.find(([eventName]) => eventName === "destroyed")?.[1] as
      | (() => void)
      | undefined;
    destroyed?.();
    releaseGateway?.();
    await rejected;
    expect(delayed.stop).toHaveBeenCalled();
    expect(piSessionCount()).toBe(0);
  });

  it("opening 期间的 extension startup confirm 会推到主界面并可回写", async () => {
    let releaseGateway: (() => void) | undefined;
    const gatewayGate = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const delayed = h.makeSession();
    h.openPiGatewaySession.mockImplementationOnce(async (options) => {
      delayed.onEvent = options.onEvent;
      if (options.onUiRequest) delayed.onUiRequest = options.onUiRequest;
      h.instances.push(delayed);
      h.openRequests.push(options.request);
      options.onSessionCreated?.(delayed);
      await gatewayGate;
      return delayed;
    });
    const event = fakeEvent();
    const pendingOpen = Promise.resolve(h.handlers.get("pi:open")!(event, {
      uiSessionId: "startup-dialog",
      cwd: "/p",
    }));
    await vi.waitFor(() => expect(h.openPiGatewaySession).toHaveBeenCalledTimes(1));
    const request = {
      type: "extension_ui_request",
      id: "startup-confirm",
      method: "confirm",
      title: "启动扩展",
      message: "是否继续？",
    };
    delayed.onUiRequest(request);
    expect(event.sender.send).toHaveBeenCalledWith("pi:uiRequest", {
      uiSessionId: "startup-dialog",
      request,
    });

    await h.handlers.get("pi:uiResponse")!(event, "startup-dialog", "startup-confirm", { confirmed: true });
    expect(delayed.respondUi).toHaveBeenCalledWith("startup-confirm", { confirmed: true });
    releaseGateway?.();
    await pendingOpen;
  });

  it("同 owner 重开后旧 gateway 的迟到 crashed/UI 请求不得命中新世代", async () => {
    const { event } = await open({ uiSessionId: "generation" });
    const stale = h.instances[0]!;
    await open({ uiSessionId: "generation", cwd: "/next" });
    const current = h.instances[1]!;
    event.sender.send.mockClear();

    stale.onEvent({ type: "crashed", error: "old worker late crash" });
    stale.onUiRequest({
      type: "extension_ui_request",
      id: "old-approval",
      method: "confirm",
      title: "old",
      message: "{}",
    });
    expect(piSessionCount()).toBe(1);
    expect(current.stop).not.toHaveBeenCalled();
    expect(event.sender.send).not.toHaveBeenCalled();

    current.onEvent({ type: "text", delta: "new" });
    expect(event.sender.send).toHaveBeenCalledWith("pi:event", {
      sessionId: "generation",
      event: { type: "text", delta: "new" },
    });
  });

  it("crashed 事件 → 摘除注册表条目,但仍把 crashed 推给 renderer", async () => {
    const { event } = await open();
    expect(piSessionCount()).toBe(1);
    h.onEventRef.current!({ type: "crashed", error: "退出码 1" });
    expect(piSessionCount()).toBe(0);
    expect(event.sender.send).toHaveBeenCalledWith("pi:event", {
      sessionId: "u1",
      event: { type: "crashed", error: "退出码 1" },
    });
  });

  it("sender 已销毁 → 在启动 gateway 前拒绝 open", async () => {
    const event = fakeEvent();
    event.sender.isDestroyed = vi.fn(() => true);
    await expect(h.handlers.get("pi:open")!(event, { uiSessionId: "u1", cwd: "/p" })).rejects.toThrow(
      "开启已取消",
    );
    expect(h.openPiGatewaySession).not.toHaveBeenCalled();
    expect(piSessionCount()).toBe(0);
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
    const { event: eventA } = await open({ uiSessionId: "uA" });
    const instA = h.instances[h.instances.length - 1]!;
    const { event: eventB } = await open({ uiSessionId: "uB" });
    const instB = h.instances[h.instances.length - 1]!;
    registerTransientPiUiRequest(
      "uA",
      "same-id",
      instA,
      eventA.sender as unknown as Parameters<typeof registerTransientPiUiRequest>[3],
    );
    registerTransientPiUiRequest(
      "uB",
      "same-id",
      instB,
      eventB.sender as unknown as Parameters<typeof registerTransientPiUiRequest>[3],
    );

    await h.handlers.get("pi:uiResponse")!({}, "uA", "same-id", { confirmed: true });
    await h.handlers.get("pi:uiResponse")!({}, "uB", "same-id", { cancelled: true });

    expect(instA.respondUi).toHaveBeenCalledWith("same-id", { confirmed: true });
    expect(instB.respondUi).toHaveBeenCalledWith("same-id", { cancelled: true });
    clearTransientPiUiRequestsForSession(instA);
    clearTransientPiUiRequestsForSession(instB);
  });

  it("短生命周期 Pi 段无长会话 entry 也能回写审批，且异 renderer 不能代答", async () => {
    const ownerEvent = fakeEvent();
    const foreignEvent = fakeEvent();
    const transient = h.makeSession();
    registerTransientPiUiRequest(
      "orchestration-parent",
      "approval-1",
      transient,
      ownerEvent.sender as unknown as Parameters<typeof registerTransientPiUiRequest>[3],
    );

    await expect(h.handlers.get("pi:uiResponse")!(
      foreignEvent,
      "orchestration-parent",
      "approval-1",
      { confirmed: true },
    )).rejects.toThrow("不属于当前 renderer");
    expect(transient.respondUi).not.toHaveBeenCalled();

    await h.handlers.get("pi:uiResponse")!(
      ownerEvent,
      "orchestration-parent",
      "approval-1",
      { confirmed: false },
    );
    expect(transient.respondUi).toHaveBeenCalledWith("approval-1", { confirmed: false });
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
      approvalTools: ["bash", "write", "edit"],
      enableSampleTools: true,
      enableSampleCommands: true,
    };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    const sent = h.openRequests[0]!;
    expect(sent).toMatchObject({
      enableToolApproval: true,
      approvalTools: ["bash", "write", "edit"],
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
