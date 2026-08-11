import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { PiOpenRequest, PiOpenResult } from "../desktop/types";
import {
  IDLE_RECLAIM_MS,
  MAX_PI_SESSIONS,
  __resetPiSessionsForTest,
  __setPiNowForTest,
  abortPi,
  closeAllPiSessions,
  closePiSession,
  compactPi,
  ensurePiSession,
  forkPi,
  isPiSessionOpen,
  markPiSessionGone,
  piRpcAvailable,
  piRpcMissingCapabilities,
  piRpcUnavailableMessage,
  promptPi,
  setModelPi,
  setThinkingLevelPi,
  setPiLifecycleHooks,
  steerPi,
  touchPiSession,
} from "./pi-session";

afterEach(() => __resetPiSessionsForTest());

// 仅实现 pi 方法的 fake bridge（其余 DesktopBridge 方法用不到,cast 即可）。
function fakeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  const open = vi.fn(
    async (req: PiOpenRequest): Promise<PiOpenResult> => ({
      uiSessionId: req.uiSessionId,
      sessionId: "pi-abc",
      sessionFile: "/sessions/new.jsonl",
    }),
  );
  return {
    piOpen: open,
    piPrompt: vi.fn(async () => undefined),
    piSteer: vi.fn(async () => undefined),
    piAbort: vi.fn(async () => undefined),
    piFork: vi.fn(async () => undefined),
    piGetForkMessages: vi.fn(async () => []),
    piSetModel: vi.fn(async () => undefined),
    piCompact: vi.fn(async () => undefined),
    piSwitchSession: vi.fn(async () => ({ cancelled: false })),
    piGetState: vi.fn(async () => ({ sessionId: "pi-restored", sessionFile: "/sessions/old.jsonl", messageCount: 5 })),
    piClose: vi.fn(async () => undefined),
    onPiEvent: vi.fn(() => () => undefined),
    onPiUiRequest: vi.fn(() => () => undefined),
    onPiUiCancel: vi.fn(() => () => undefined),
    piUiResponse: vi.fn(async () => undefined),
    ...over,
  } as unknown as DesktopBridge;
}

const req = (uiSessionId = "s1"): PiOpenRequest => ({ uiSessionId, cwd: "/proj" });

describe("piRpcAvailable", () => {
  it("执行与审批完整能力集齐备才算可用", () => {
    expect(piRpcAvailable(fakeBridge())).toBe(true);
    expect(piRpcAvailable(null)).toBe(false);
    expect(piRpcAvailable(fakeBridge({ piOpen: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ piPrompt: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ onPiEvent: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ onPiUiRequest: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ onPiUiCancel: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ piUiResponse: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ piAbort: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ piClose: undefined }))).toBe(false);
  });

  it("返回缺失能力列表和可操作提示", () => {
    const bridge = fakeBridge({
      piOpen: undefined,
      piPrompt: undefined,
      onPiEvent: undefined,
      onPiUiRequest: undefined,
      onPiUiCancel: undefined,
      piUiResponse: undefined,
      piAbort: undefined,
      piClose: undefined,
    });
    expect(piRpcMissingCapabilities(bridge)).toEqual([
      "piOpen",
      "piPrompt",
      "onPiEvent",
      "onPiUiRequest",
      "onPiUiCancel",
      "piUiResponse",
      "piAbort",
      "piClose",
    ]);
    expect(piRpcUnavailableMessage(bridge)).toContain(
      "缺少 piOpen, piPrompt, onPiEvent, onPiUiRequest, onPiUiCancel, piUiResponse, piAbort, piClose",
    );
    expect(piRpcUnavailableMessage(bridge)).toContain("完整重启 Cortex Desktop");
    expect(piRpcUnavailableMessage(fakeBridge())).toBeNull();
  });
});

describe("ensurePiSession", () => {
  it("首开 spawn 一次并标记就绪,回带 sessionFile", async () => {
    const bridge = fakeBridge();
    const res = await ensurePiSession(bridge, req());
    expect(res.sessionId).toBe("pi-abc");
    expect(res.sessionFile).toBe("/sessions/new.jsonl"); // 阶段4 U1:贯通 sessionFile
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(isPiSessionOpen("s1")).toBe(true);
  });

  it("带 resumeFrom 重开 → piOpen + piSwitchSession + 校准 sessionFile（阶段4 U2 恢复）", async () => {
    const bridge = fakeBridge();
    const res = await ensurePiSession(bridge, req(), { resumeFrom: "/sessions/old.jsonl" });
    expect(bridge.piSwitchSession).toHaveBeenCalledWith("s1", "/sessions/old.jsonl");
    expect(res.sessionId).toBe("pi-restored"); // get_state 校准为恢复会话
    expect(res.sessionFile).toBe("/sessions/old.jsonl");
  });

  it("无 resumeFrom → 不 switchSession（全新会话）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    expect(bridge.piSwitchSession).not.toHaveBeenCalled();
  });

  it("switchSession 硬错(cwd 缺失 reject)→ best-effort 保持新会话仍可用", async () => {
    const bridge = fakeBridge({ piSwitchSession: vi.fn(async () => Promise.reject(new Error("MissingSessionCwd"))) });
    const res = await ensurePiSession(bridge, req(), { resumeFrom: "/sessions/old.jsonl" });
    expect(res.sessionId).toBe("pi-abc"); // 回退新会话
    expect(isPiSessionOpen("s1")).toBe(true); // 仍就绪可用,不抛
  });

  it("switchSession 成功但 get_state 抛错 → sessionFile 仍为旧文件,不退回新空文件（评审 #1）", async () => {
    // pi 进程已切到旧上下文,只是 getState 偶发失败;决不能持久回新空 file 丢历史指针。
    const bridge = fakeBridge({ piGetState: vi.fn(async () => Promise.reject(new Error("getState 超时"))) });
    const res = await ensurePiSession(bridge, req(), { resumeFrom: "/sessions/old.jsonl" });
    expect(res.sessionFile).toBe("/sessions/old.jsonl"); // 兜底旧文件,非 "/sessions/new.jsonl"
    expect(res.sessionId).toBe("pi-abc"); // 沿用 live pi id（温会话复用守卫需真值）
  });

  it("恢复 switchSession 在途时 close，应答到达后必须关掉迟到进程而不得标记 ready", async () => {
    let finishSwitch: (() => void) | undefined;
    const switching = new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    const bridge = fakeBridge({
      piSwitchSession: vi.fn(async () => switching),
    });

    const opening = ensurePiSession(bridge, req(), { resumeFrom: "/sessions/old.jsonl" });
    const rejected = expect(opening).rejects.toThrow("开启已取消");
    await vi.waitFor(() => expect(bridge.piSwitchSession).toHaveBeenCalled());
    const closing = closePiSession(bridge, "s1");
    finishSwitch?.();

    await rejected;
    await closing;
    expect(bridge.piClose).toHaveBeenCalledTimes(1);
    expect(isPiSessionOpen("s1")).toBe(false);
  });

  it("resumeFrom 等于新会话自身 file → 不重复 switchSession", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req(), { resumeFrom: "/sessions/new.jsonl" });
    expect(bridge.piSwitchSession).not.toHaveBeenCalled();
  });

  it("并发 ensure 复用同一在途 Promise,只 spawn 一次", async () => {
    const bridge = fakeBridge();
    const [a, b] = await Promise.all([ensurePiSession(bridge, req()), ensurePiSession(bridge, req())]);
    expect(a.sessionId).toBe("pi-abc");
    expect(b.sessionId).toBe("pi-abc");
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
  });

  it("开启中指纹漂移时不复用旧配置,旧开启收口后关闭并按新配置重开", async () => {
    let finishFirstOpen: ((result: PiOpenResult) => void) | undefined;
    const firstOpen = new Promise<PiOpenResult>((resolve) => {
      finishFirstOpen = resolve;
    });
    let finishClose: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const open = vi.fn((request: PiOpenRequest) => {
      if (!request.enableToolApproval) return firstOpen;
      return Promise.resolve({ uiSessionId: request.uiSessionId, sessionId: "pi-with-approval" });
    });
    const close = vi.fn(() => closing);
    const bridge = fakeBridge({ piOpen: open, piClose: close });

    const openingWithoutApproval = ensurePiSession(bridge, req());
    const openingWithApproval = ensurePiSession(bridge, { ...req(), enableToolApproval: true });

    expect(open).toHaveBeenCalledTimes(1);
    finishFirstOpen?.({ uiSessionId: "s1", sessionId: "pi-without-approval" });
    await expect(openingWithoutApproval).resolves.toMatchObject({ sessionId: "pi-without-approval" });
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith("s1"));
    expect(open).toHaveBeenCalledTimes(1); // 旧进程尚未关完时，不得抢先 open 同一个 uiSessionId。
    finishClose?.();
    await expect(openingWithApproval).resolves.toMatchObject({ sessionId: "pi-with-approval" });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(2, expect.objectContaining({ enableToolApproval: true }));
  });

  it.each([
    [
      "model",
      { model: "model-a", thinkingLevel: "low" },
      { model: "model-b", thinkingLevel: "low" },
    ],
    [
      "thinking",
      { model: "model-a", thinkingLevel: "low" },
      { model: "model-a", thinkingLevel: "high" },
    ],
  ] as const)("预热 opening 期间同 provider 仅切 %s → 不复用旧启动参数", async (_field, initial, next) => {
    let finishPrewarm: ((result: PiOpenResult) => void) | undefined;
    const prewarming = new Promise<PiOpenResult>((resolve) => {
      finishPrewarm = resolve;
    });
    let openCount = 0;
    const open = vi.fn((request: PiOpenRequest) => {
      openCount += 1;
      if (openCount === 1) return prewarming;
      return Promise.resolve({ uiSessionId: request.uiSessionId, sessionId: "pi-config-b" });
    });
    const close = vi.fn(async () => undefined);
    const bridge = fakeBridge({ piOpen: open, piClose: close });
    const a: PiOpenRequest = { ...req(), providerId: "provider-a", ...initial };
    const b: PiOpenRequest = { ...a, ...next };

    const openingA = ensurePiSession(bridge, a);
    const openingB = ensurePiSession(bridge, b);

    expect(open).toHaveBeenCalledTimes(1);
    finishPrewarm?.({ uiSessionId: "s1", sessionId: "pi-config-a" });
    await expect(openingA).resolves.toMatchObject({ sessionId: "pi-config-a" });
    await expect(openingB).resolves.toMatchObject({ sessionId: "pi-config-b" });
    expect(close).toHaveBeenCalledWith("s1");
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(2, b);
  });

  it("普通聊天切入 artifact 时按 cwd/产物身份关闭旧会话并重开", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await ensurePiSession(bridge, {
      ...req(),
      cwd: "/artifact/workspace",
      artifactContext: {
        kind: "slides",
        documentId: "deck-1",
        title: "Deck",
        workspaceRoot: "/artifact/workspace",
        entryPath: "/artifact/workspace/.cortex-design/deck-1/deck.bento.html",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
    expect(bridge.piOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/artifact/workspace", artifactContext: expect.objectContaining({ documentId: "deck-1" }) }),
    );
  });

  it("同一 artifact cwd 仅切 documentId/entryPath 时仍关闭旧会话并重开", async () => {
    const bridge = fakeBridge();
    const first: PiOpenRequest = {
      ...req(),
      cwd: "/artifact/workspace",
      artifactContext: {
        kind: "slides",
        documentId: "deck-1",
        title: "Deck 1",
        workspaceRoot: "/artifact/workspace",
        entryPath: "/artifact/workspace/.cortex-design/deck-1/deck.bento.html",
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const second: PiOpenRequest = {
      ...first,
      artifactContext: {
        ...first.artifactContext!,
        documentId: "deck-2",
        title: "Deck 2",
        entryPath: "/artifact/workspace/.cortex-design/deck-2/deck.bento.html",
      },
    };

    await ensurePiSession(bridge, first);
    await ensurePiSession(bridge, second);

    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
    expect(bridge.piOpen).toHaveBeenLastCalledWith(second);
  });

  it("旧 opening 延迟 reject 不删除已登记的新指纹句柄", async () => {
    let rejectFirstOpen: ((reason: Error) => void) | undefined;
    const firstOpen = new Promise<PiOpenResult>((_resolve, reject) => {
      rejectFirstOpen = reject;
    });
    const open = vi.fn((request: PiOpenRequest) => {
      if (!request.enableToolApproval) return firstOpen;
      return Promise.resolve({ uiSessionId: request.uiSessionId, sessionId: "pi-with-approval" });
    });
    const bridge = fakeBridge({ piOpen: open });

    const staleOpening = ensurePiSession(bridge, req());
    const replacementOpening = ensurePiSession(bridge, { ...req(), enableToolApproval: true });
    const staleRejection = expect(staleOpening).rejects.toThrow("first open failed");

    rejectFirstOpen?.(new Error("first open failed"));
    await staleRejection;
    await expect(replacementOpening).resolves.toMatchObject({ sessionId: "pi-with-approval" });
    expect(isPiSessionOpen("s1")).toBe(true);

    await ensurePiSession(bridge, { ...req(), enableToolApproval: true });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("关闭等待旧世代的 opening 后不会迟到 piOpen，后续新世代仍可正常启动", async () => {
    let finishFirstOpen: ((result: PiOpenResult) => void) | undefined;
    const firstOpen = new Promise<PiOpenResult>((resolve) => {
      finishFirstOpen = resolve;
    });
    const open = vi.fn((request: PiOpenRequest) => {
      if (!request.enableToolApproval) return firstOpen;
      return Promise.resolve({ uiSessionId: request.uiSessionId, sessionId: "pi-approved" });
    });
    const bridge = fakeBridge({ piOpen: open });

    const openingA = ensurePiSession(bridge, req());
    const openingB = ensurePiSession(bridge, { ...req(), enableToolApproval: true });
    const closingB = closePiSession(bridge, "s1");

    finishFirstOpen?.({ uiSessionId: "s1", sessionId: "pi-a" });
    await expect(openingA).resolves.toMatchObject({ sessionId: "pi-a" });
    await expect(openingB).rejects.toThrow("开启已取消");
    await closingB;
    expect(open).toHaveBeenCalledTimes(1);
    expect(isPiSessionOpen("s1")).toBe(false);

    await expect(ensurePiSession(bridge, { ...req(), enableToolApproval: true })).resolves.toMatchObject({
      sessionId: "pi-approved",
    });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("已取消的 B 等待 A 关闭时，同配置 C 也必须等迟到 close 收口后再 open", async () => {
    let finishA: ((result: PiOpenResult) => void) | undefined;
    const openingAResult = new Promise<PiOpenResult>((resolve) => {
      finishA = resolve;
    });
    let finishClose: (() => void) | undefined;
    const closingA = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const approved = { ...req(), enableToolApproval: true };
    const open = vi.fn((request: PiOpenRequest) =>
      request.enableToolApproval
        ? Promise.resolve({ uiSessionId: request.uiSessionId, sessionId: "pi-c" })
        : openingAResult,
    );
    const close = vi.fn(() => closingA);
    const bridge = fakeBridge({ piOpen: open, piClose: close });

    const openingA = ensurePiSession(bridge, req());
    const openingB = ensurePiSession(bridge, approved);
    const closingB = closePiSession(bridge, "s1");
    const openingC = ensurePiSession(bridge, approved);

    finishA?.({ uiSessionId: "s1", sessionId: "pi-a" });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledTimes(1);
    finishClose?.();
    await expect(openingA).resolves.toMatchObject({ sessionId: "pi-a" });
    await expect(openingB).rejects.toThrow("开启已取消");
    await closingB;
    await expect(openingC).resolves.toMatchObject({ sessionId: "pi-c" });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("已就绪再 ensure 不重复 spawn（同深度定制指纹）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await ensurePiSession(bridge, req());
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
  });

  it("深度定制开关变了（指纹漂移）→ 关旧重开,让新 extension 加载（防裸奔）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req() }); // 无审批
    await ensurePiSession(bridge, { ...req(), enableToolApproval: true }); // 中途开审批
    expect(bridge.piClose).toHaveBeenCalledWith("s1"); // 关旧
    expect(bridge.piOpen).toHaveBeenCalledTimes(2); // 重开
    expect(isPiSessionOpen("s1")).toBe(true);
  });

  it("同审批设置再 ensure 仍复用（指纹一致不重开）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), enableToolApproval: true });
    await ensurePiSession(bridge, { ...req(), enableToolApproval: true });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("换供应商 → 指纹漂移关旧重开,新 extension 生效", async () => {
    const bridge = fakeBridge();
    const p = (providerId: string): PiOpenRequest => ({ ...req(), providerId });
    await ensurePiSession(bridge, p("ds"));
    await ensurePiSession(bridge, p("openai")); // 换供应商
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
  });

  it("供应商不变 → 指纹一致复用不重开", async () => {
    const bridge = fakeBridge();
    const p: PiOpenRequest = { ...req(), providerId: "ds" };
    await ensurePiSession(bridge, { ...p });
    await ensurePiSession(bridge, { ...p });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("providerId 缺省 ↔ 有值 → 视为不同配置,重开", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req() });
    await ensurePiSession(bridge, { ...req(), providerId: "ds" });
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
  });

  // 同一 providerId 下改了自建网关端点 / 认证来源：渲染端看不到 baseUrl/apiKey，
  // 靠 providerConfigFingerprint 从 ProviderAuthSnapshot 派生的非敏感指纹表达。
  // 没有它，「填了自建网关但请求还发往官方端点」会是无报错的静默失败。
  it("同一供应商下 providerFingerprint 变化（如 baseUrl 覆盖）→ 温会话重开", async () => {
    const bridge = fakeBridge();
    const p = (providerFingerprint: string): PiOpenRequest => ({ ...req(), providerId: "ds", providerFingerprint });
    await ensurePiSession(bridge, p('{"baseUrlOverride":null}'));
    await ensurePiSession(bridge, p('{"baseUrlOverride":"https://my-gateway/v1"}'));
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
  });

  it("providerFingerprint 不变 → 复用温会话,不白白重开", async () => {
    const bridge = fakeBridge();
    const p: PiOpenRequest = { ...req(), providerId: "ds", providerFingerprint: '{"baseUrlOverride":null}' };
    await ensurePiSession(bridge, { ...p });
    await ensurePiSession(bridge, { ...p });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("appendSystemPrompt 变化 → 指纹漂移关旧重开（阶段4 持久 system prompt）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), appendSystemPrompt: "你是 A" });
    await ensurePiSession(bridge, { ...req(), appendSystemPrompt: "你是 B" });
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
  });

  it("appendSystemPrompt 不变 → 复用不重开", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), appendSystemPrompt: "你是 A" });
    await ensurePiSession(bridge, { ...req(), appendSystemPrompt: "你是 A" });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("skillPaths 变化（U5 插件 Skill）→ 指纹漂移关旧重开", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), skillPaths: ["/a/code-review"] });
    await ensurePiSession(bridge, { ...req(), skillPaths: ["/a/code-review", "/b/bug-hunt"] });
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
  });

  it("skillPaths 内容相同顺序不同 → 排序后指纹一致,复用不重开", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), skillPaths: ["/a", "/b"] });
    await ensurePiSession(bridge, { ...req(), skillPaths: ["/b", "/a"] });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("toolWhitelist 变化（切入 plan 只读档）→ 指纹漂移关旧重开（R5 唯一兑现路径）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req() }); // full-auto:无 toolWhitelist
    await ensurePiSession(bridge, { ...req(), toolWhitelist: ["read", "grep", "find", "ls"] }); // 切 plan
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
  });

  it("toolWhitelist 内容相同顺序不同 → 排序后指纹一致,复用不重开", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), toolWhitelist: ["read", "ls"] });
    await ensurePiSession(bridge, { ...req(), toolWhitelist: ["ls", "read"] });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  /// 会话级「联网」:研究引擎 MCP 经桥接 extension 在 pi:open 时并入,pi 无运行时增删工具集的命令。
  /// 不进指纹会让中途切开关复用温会话的旧工具集——**关掉后仍留着一套能出站的工具**,那是安全问题。
  it("webSearch 变化（会话级联网开关）→ 指纹漂移关旧重开,新工具集才真正加载", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), webSearch: true }); // 开着联网:带研究引擎 MCP
    await ensurePiSession(bridge, { ...req() }); // 关掉:必须重开,把工具卸掉
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
  });

  it("webSearch 不变 → 指纹一致复用不重开", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), webSearch: true });
    await ensurePiSession(bridge, { ...req(), webSearch: true });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("ready 后 setModel 成功同步热配置 → 下一次 ensure 保持温会话快路径", async () => {
    const bridge = fakeBridge();
    const initial = { ...req(), providerId: "provider-a", model: "model-a", thinkingLevel: "low" };
    await ensurePiSession(bridge, initial);
    await setModelPi(bridge, "s1", "provider-a", "model-b");
    await ensurePiSession(bridge, { ...initial, model: "model-b" });

    expect(bridge.piSetModel).toHaveBeenCalledWith("s1", "provider-a", "model-b");
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("ready 后 setThinking 成功同步热配置 → 下一次 ensure 保持温会话快路径", async () => {
    const setThinking = vi.fn(async () => undefined);
    const bridge = fakeBridge({ piSetThinking: setThinking });
    const initial = { ...req(), providerId: "provider-a", model: "model-a", thinkingLevel: "low" };
    await ensurePiSession(bridge, initial);
    await setThinkingLevelPi(bridge, "s1", "high");
    await ensurePiSession(bridge, { ...initial, thinkingLevel: "high" });

    expect(setThinking).toHaveBeenCalledWith("s1", "high");
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("setThinkingLevelPi 未就绪 → 抛错（requireReady）", () => {
    expect(() => setThinkingLevelPi(fakeBridge(), "s1", "high")).toThrow();
  });

  it("setThinkingLevelPi 缺 piSetThinking 能力 → 抛错（requireCap）", async () => {
    const bridge = fakeBridge({ piSetThinking: undefined });
    await ensurePiSession(bridge, req());
    expect(() => setThinkingLevelPi(bridge, "s1", "high")).toThrow();
  });

  it("setThinkingLevelPi 就绪 → 以 (sessionId, level) 下发", async () => {
    const setThinking = vi.fn(async () => undefined);
    const bridge = fakeBridge({ piSetThinking: setThinking });
    await ensurePiSession(bridge, req());
    await setThinkingLevelPi(bridge, "s1", "high");
    expect(setThinking).toHaveBeenCalledWith("s1", "high");
  });

  it("开启失败摘除登记,下次 ensure 可重试", async () => {
    const open = vi
      .fn<(r: PiOpenRequest) => Promise<PiOpenResult>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ uiSessionId: "s1", sessionId: "pi-xyz" });
    const bridge = fakeBridge({ piOpen: open });
    await expect(ensurePiSession(bridge, req())).rejects.toThrow("boom");
    expect(isPiSessionOpen("s1")).toBe(false);
    const res = await ensurePiSession(bridge, req());
    expect(res.sessionId).toBe("pi-xyz");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("缺 piOpen 能力直接抛错", async () => {
    await expect(ensurePiSession(fakeBridge({ piOpen: undefined }), req())).rejects.toThrow(/不支持/);
  });
});

describe("命令包装", () => {
  it("就绪后转发到对应 bridge 方法并带参", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await promptPi(bridge, "s1", "hi");
    await steerPi(bridge, "s1", "go left");
    await abortPi(bridge, "s1");
    await forkPi(bridge, "s1", "entry-7");
    await setModelPi(bridge, "s1", "deepseek", "deepseek-chat");
    await compactPi(bridge, "s1", "保留最近 3 轮");
    expect(bridge.piPrompt).toHaveBeenCalledWith("s1", "hi", undefined, undefined);
    expect(bridge.piSteer).toHaveBeenCalledWith("s1", "go left");
    expect(bridge.piAbort).toHaveBeenCalledWith("s1");
    expect(bridge.piFork).toHaveBeenCalledWith("s1", "entry-7");
    expect(bridge.piSetModel).toHaveBeenCalledWith("s1", "deepseek", "deepseek-chat");
    expect(bridge.piCompact).toHaveBeenCalledWith("s1", "保留最近 3 轮");
  });

  it("promptPi 透传 runId + imagePaths 给 bridge.piPrompt", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await promptPi(bridge, "s1", "看图", "run-1", ["/img/a.png", "/img/b.png"]);
    expect(bridge.piPrompt).toHaveBeenCalledWith("s1", "看图", "run-1", ["/img/a.png", "/img/b.png"]);
  });

  it("会话未就绪时命令抛错（不静默吞）", () => {
    const bridge = fakeBridge();
    expect(() => promptPi(bridge, "ghost", "hi")).toThrow(/未就绪/);
    expect(() => abortPi(bridge, "ghost")).toThrow(/未就绪/);
    expect(() => compactPi(bridge, "ghost")).toThrow(/未就绪/);
  });
});

describe("关闭与崩溃", () => {
  it("closePiSession 调 piClose 并摘除登记,幂等", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await closePiSession(bridge, "s1");
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(isPiSessionOpen("s1")).toBe(false);
    await closePiSession(bridge, "s1"); // 二次幂等,不再调
    expect(bridge.piClose).toHaveBeenCalledTimes(1);
  });

  it("旧世代 close 在途的迟到活动不重挂 idle timer，不能在十分钟后误关新世代", async () => {
    vi.useFakeTimers();
    let releaseClose: () => void = () => undefined;
    const closePending = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const piClose = vi.fn(() => closePending);
    const bridge = fakeBridge({ piClose });
    await ensurePiSession(bridge, req());
    touchPiSession(bridge, "s1");

    const closing = closePiSession(bridge, "s1");
    touchPiSession(bridge, "s1"); // 模拟主进程关闭应答前排队到 renderer 的旧事件。
    const reopening = ensurePiSession(bridge, req());
    await Promise.resolve();
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);

    releaseClose();
    await Promise.all([closing, reopening]);
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
    expect(isPiSessionOpen("s1")).toBe(true);

    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS);
    expect(piClose).toHaveBeenCalledTimes(1);
    expect(isPiSessionOpen("s1")).toBe(true);
    vi.useRealTimers();
  });

  it("closeAllPiSessions 关掉全部", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req("s1"));
    await ensurePiSession(bridge, req("s2"));
    await closeAllPiSessions(bridge);
    expect(bridge.piClose).toHaveBeenCalledTimes(2);
    expect(isPiSessionOpen("s1")).toBe(false);
    expect(isPiSessionOpen("s2")).toBe(false);
  });

  it("markPiSessionGone 摘除登记,下次 ensure 重开（不发 piClose）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    markPiSessionGone("s1");
    expect(isPiSessionOpen("s1")).toBe(false);
    await ensurePiSession(bridge, req());
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });
});

describe("空闲回收 + LRU 上限（阶段4 U5/U6）", () => {
  it("空闲 IDLE_RECLAIM_MS 后 → closePiSession;活动刷新会重置计时", async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req("s1"));
    touchPiSession(bridge, "s1"); // 启动空闲计时
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS - 1000);
    touchPiSession(bridge, "s1"); // 活动 → 重置
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS - 1000);
    expect(isPiSessionOpen("s1")).toBe(true); // 因重置过,尚未到期
    await vi.advanceTimersByTimeAsync(2000);
    expect(bridge.piClose).toHaveBeenCalledWith("s1"); // 再无活动 → 到期回收
    expect(isPiSessionOpen("s1")).toBe(false);
    vi.useRealTimers();
  });

  it("有活跃 run 的会话空闲到期不被回收（长工具静默期续命,评审 #2 HIGH）", async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req("s1"));
    setPiLifecycleHooks({ isBusy: (id) => id === "s1" }); // s1 一直在跑（长工具静默）
    touchPiSession(bridge, "s1");
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS * 3); // 远超空闲阈值
    expect(bridge.piClose).not.toHaveBeenCalled(); // 繁忙 → 不杀
    expect(isPiSessionOpen("s1")).toBe(true);
    // run 结束后再空闲 → 正常回收。
    setPiLifecycleHooks({ isBusy: () => false });
    touchPiSession(bridge, "s1");
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS + 1000);
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    vi.useRealTimers();
  });

  it("LRU 跳过繁忙会话,优先逐出无活跃 run 的最久未用（评审 #4 HIGH）", async () => {
    let t = 1000;
    __setPiNowForTest(() => t);
    const bridge = fakeBridge();
    for (let i = 0; i < MAX_PI_SESSIONS; i++) {
      t = 1000 + i * 100;
      await ensurePiSession(bridge, req(`s${i}`));
    }
    // s0 最旧但「在跑」;s1 次旧且空闲 → 应逐 s1 而非 s0。
    setPiLifecycleHooks({ isBusy: (id) => id === "s0" });
    t = 9999;
    await ensurePiSession(bridge, req("sNew"));
    expect(bridge.piClose).toHaveBeenCalledWith("s1"); // 跳过繁忙 s0,逐次旧空闲 s1
    expect(bridge.piClose).not.toHaveBeenCalledWith("s0");
    expect(isPiSessionOpen("s0")).toBe(true);
  });

  it("全忙时被迫逐出 → onReclaim 先收尾 renderer run（防 run 永挂,评审 #3）", async () => {
    let t = 1000;
    __setPiNowForTest(() => t);
    const reaped: string[] = [];
    const bridge = fakeBridge();
    for (let i = 0; i < MAX_PI_SESSIONS; i++) {
      t = 1000 + i * 100;
      await ensurePiSession(bridge, req(`s${i}`));
    }
    setPiLifecycleHooks({ isBusy: () => true, onReclaim: (id) => reaped.push(id) }); // 全忙
    t = 9999;
    await ensurePiSession(bridge, req("sNew"));
    expect(reaped).toContain("s0"); // 被迫逐出最旧 s0 前 reap 其 run
    expect(bridge.piClose).toHaveBeenCalledWith("s0");
  });

  it("达上限 → spawn 新会话前逐出 lastActiveAt 最小的（LRU）", async () => {
    let t = 1000;
    __setPiNowForTest(() => t);
    const bridge = fakeBridge();
    // 开满 MAX 个，各自 lastActiveAt 递增（s1 最旧）。
    for (let i = 0; i < MAX_PI_SESSIONS; i++) {
      t = 1000 + i * 100;
      await ensurePiSession(bridge, req(`s${i}`));
    }
    expect(isPiSessionOpen("s0")).toBe(true);
    // 再开一个 → 触发 LRU 逐出最旧的 s0。
    t = 9999;
    await ensurePiSession(bridge, req("sNew"));
    expect(bridge.piClose).toHaveBeenCalledWith("s0"); // 逐出最久未用
    expect(isPiSessionOpen("sNew")).toBe(true);
  });

  it("逐出/回收后 sessionFile 已在 SessionMeta（调用方持久),下次 ensure resumeFrom 恢复", async () => {
    // 本单元只验进程层逐出不丢恢复能力:逐出走 closePiSession,handle 删除;恢复靠 SessionMeta（renderer 层,
    // 见 personalActions.test）。此处确认逐出后再 ensure(resumeFrom) 会 switchSession。
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req("s1"));
    await closePiSession(bridge, "s1"); // 模拟空闲/LRU 回收
    await ensurePiSession(bridge, req("s1"), { resumeFrom: "/sessions/old.jsonl" });
    expect(bridge.piSwitchSession).toHaveBeenCalledWith("s1", "/sessions/old.jsonl");
  });
});
