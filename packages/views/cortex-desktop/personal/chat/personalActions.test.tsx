// usePersonalActions 的 send/stop/editResend「单发 vs pi RPC」分叉回归（计划 U3）。
// 重点:claude/codex 仍走 startCli/killCli/trimAgentSession（R10 零回归）;pi 走
// piOpen+piPrompt / piAbort / piFork。jsdom + renderHook（core 是 node env,放此处）。

import type { ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoreProvider,
  RUN_START_TIMEOUT_MS,
  cleanToolName,
  personalChatKeys,
  personalProcessKeys,
  usePersonalActions,
  usePersonalPiEvents,
  usePersonalPiUi,
  usePersonalStore,
  resetProviderCatalogCache,
  type PiSessionEvent,
  type PiUiRequest,
  __resetPersonalMessageRunsForTest,
  __resetPiSessionsForTest,
  type DesktopBridge,
  type Message,
  type PendingDocFile,
  type PendingImage,
  type SessionMeta,
} from "@cortex-work/core";
import { __handleCliEventForTest } from "@cortex-work/core/personal/messages";

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    loadChat: vi.fn(async () => []),
    saveChat: vi.fn(async () => undefined),
    startCli: vi.fn(async () => undefined),
    startOrchestration: vi.fn(async () => undefined),
    killOrchestration: vi.fn(async () => undefined),
    killCli: vi.fn(async () => undefined),
    agentSessionExists: vi.fn(async () => true),
    trimAgentSession: vi.fn(async () => true),
    oneshotCli: vi.fn(async () => ""),
    piOpen: vi.fn(async (req: { uiSessionId: string }) => ({
      uiSessionId: req.uiSessionId,
      sessionId: "pi-1",
      sessionFile: "/sessions/s.jsonl",
    })),
    piPrompt: vi.fn(async () => undefined),
    piSteer: vi.fn(async () => undefined),
    piAbort: vi.fn(async () => undefined),
    piClose: vi.fn(async () => undefined),
    piFork: vi.fn(async () => undefined),
    piGetForkMessages: vi.fn(async () => ({ messages: [{ entryId: "e1", text: "原问题" }] })),
    piSetModel: vi.fn(async () => undefined),
    piCompact: vi.fn(async () => undefined),
    piSwitchSession: vi.fn(async () => ({ cancelled: false })),
    piGetState: vi.fn(async () => ({ sessionId: "pi-1", sessionFile: "/sessions/s.jsonl" })),
    onPiEvent: vi.fn(() => () => undefined),
    onPiUiRequest: vi.fn(() => () => undefined),
    onPiUiCancel: vi.fn(() => () => undefined),
    piUiResponse: vi.fn(async () => undefined),
    // 发送前 vision 阻断（计划 §2.3）要查 Provider Catalog：目录里 vision-model 支持图片、
    // text-model 只吃文本。缺这个方法会一律判 unknown 并阻断（保守降级，见 modelCapabilities）。
    providerCatalogGet: vi.fn(async () => ({ ok: true, catalog: TEST_CATALOG })),
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
// 带图发送的 pi 会话必须显式选一个**多模态**模型：能力未知同样会被阻断（不允许当成 text-only）。
const piVisionSession: SessionMeta = { ...piSession, providerId: "test-provider", model: "vision-model" };
const piTextSession: SessionMeta = { ...piSession, providerId: "test-provider", model: "text-model" };

const TEST_CATALOG = {
  schemaVersion: 1 as const,
  piVersion: "0.82.1",
  hash: "test",
  providers: [
    {
      id: "test-provider",
      name: "Test",
      api: "openai-completions",
      auth: ["api-key" as const],
      models: [
        { id: "vision-model", name: "Vision", api: "openai-completions", input: ["text" as const, "image" as const], reasoning: true, contextWindow: 200_000, maxTokens: 8_192 },
        { id: "text-model", name: "Text", api: "openai-completions", input: ["text" as const], reasoning: false, contextWindow: 128_000, maxTokens: 4_096 },
      ],
    },
  ],
};

// 构造一张待发图片(data 是任意字节;测试里 imageSave 被 mock,不嗅探)。
function pendingImg(name: string): PendingImage {
  return {
    id: `p-${name}`,
    name,
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
  };
}

// imageSave mock:按 fileName 回一个确定路径,便于断言保序。
function imageSaveMock() {
  return vi.fn(async (req: { fileName: string }) => ({ path: `/img/${req.fileName}` }));
}

// 待发文档(srcPath 形态;docSave 被 mock,不真正落盘)。
function pendingDoc(name: string): PendingDocFile {
  return { id: `d-${name}`, name, mimeType: "application/pdf", sizeBytes: 10, status: "ready", srcPath: `/abs/${name}` };
}
function docSaveMock() {
  return vi.fn(async (req: { fileName: string }) => ({ path: `/docs/${req.fileName}`, sizeBytes: 10 }));
}

function userMsgUid(qc: QueryClient, sessionId: string, text: string): string {
  const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
  const hit = msgs.find((m) => m.kind === "text" && m.who === "me" && m.text === text);
  return hit?.uid ?? "";
}

// 产品已移除编排开关，缺省状态会把委派工具交给模型自行决定。多数历史用例专门覆盖 pi RPC
// 路径，beforeEach 用已废弃的显式 false 作为测试闸门；委派用例各自移除或开启该闸门。
const setOrchestration = (on: boolean) =>
  usePersonalStore.setState({
    generalSettings: { ...usePersonalStore.getState().generalSettings, subagentOrchestration: on },
  });

beforeEach(() => {
  __resetPersonalMessageRunsForTest();
  __resetPiSessionsForTest();
  resetProviderCatalogCache(); // Catalog 是模块级进程内缓存,跨用例必须清,否则串台
  usePersonalStore.setState({
    sessions: [claudeSession, piSession], // piVisionSession/piTextSession 与 piSession 同 id,只是模型不同
    projects: [],
    agentsAvailable: { claude: true, codex: true, pi: true },
    runningBySession: {},
    piRuntimeBySession: {},
  });
  setOrchestration(false);
});

afterEach(() => {
  cleanup();
  __resetPersonalMessageRunsForTest();
  __resetPiSessionsForTest();
});

describe("send 分叉", () => {
  it("side 子会话保持只读，领域层拒绝任何绕过 UI 的发送", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    const sideSession: SessionMeta = { ...claudeSession, id: "side-1", relation: "side", parentSessionId: "s-claude" };
    let sent = true;
    await act(async () => {
      sent = await result.current.send(sideSession, "/proj", "绕过输入框发送", []);
    });
    expect(sent).toBe(false);
    expect(bridge.startCli).not.toHaveBeenCalled();
    expect(bridge.piPrompt).not.toHaveBeenCalled();
  });

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

  it("项目分析请求默认获得 Kun 对齐的 Explorer 委派指令与子代理工具", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    // 清掉 beforeEach 的测试闸门，模拟真实出厂状态（字段缺失）。
    const { subagentOrchestration: _unset, ...rest } = usePersonalStore.getState().generalSettings;
    usePersonalStore.setState({ generalSettings: rest });
    await act(async () => {
      await result.current.send(claudeSession, "/proj", "分析下当前项目主要解决什么问题", []);
    });
    expect(bridge.startCli).toHaveBeenCalledTimes(1);
    const req = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req).toMatchObject({
      sessionId: "s-claude",
      agent: "claude",
      resumeSessionId: "c1",
    });
    expect(req.delegateRoles).toHaveLength(8);
    expect(req.delegatePolicy).toEqual({ maxParallel: 256, maxChildRuns: 25 });
    expect(req.appendSystemPrompt).toContain("实质性任务只要受益于专项能力、独立复核或多个互不依赖的工作流");
    expect(req.appendSystemPrompt).toContain("必须调用合适的协作者工具");
    expect(req.appendSystemPrompt).toContain("任何仓库或项目探索都必须先调用 `explore_agent`");
    expect(req.appendSystemPrompt).toContain("互不重叠的范围动态拆成多个并行 `explore_agent`");
    expect(bridge.startOrchestration).not.toHaveBeenCalled();
  });

  it("默认 Cortex + ask + 自动委派仍走 Pi RPC，并为 bash/write/edit 开启主界面审批", async () => {
    let emitUiRequest: ((uiSessionId: string, request: PiUiRequest) => void) | undefined;
    const bridge = makeBridge({
      // Cortex 的自动委派已经属于 Pi RPC；即使桥不暴露 CLI 入口也必须保留角色目录。
      startCli: undefined,
      onPiUiRequest: vi.fn((cb: (uiSessionId: string, request: PiUiRequest) => void) => {
        emitUiRequest = cb;
        return () => undefined;
      }),
    });
    const qc = new QueryClient();
    usePersonalStore.setState({ piUiPending: [] });
    const { result } = renderHook(() => {
      // PersonalWorkspace 的真实组合：发送动作与主界面审批订阅同时挂载。
      usePersonalPiUi();
      return usePersonalActions();
    }, { wrapper: wrapper(bridge, qc) });
    // 删除兼容闸门，模拟真实出厂状态：自动委派默认开启。
    const { subagentOrchestration: _unset, ...rest } = usePersonalStore.getState().generalSettings;
    usePersonalStore.setState({ generalSettings: rest });
    const session: SessionMeta = {
      ...piSession,
      model: "pi-model",
      thinkingLevel: "high",
      execPermission: "ask",
      agentSessionIds: { pi: "pi-main-session" },
    };
    await act(async () => {
      await result.current.send(session, "/proj", "请分析代码", []);
    });

    expect(bridge.startCli).toBeUndefined();
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piPrompt).toHaveBeenCalledTimes(1);
    const req = (bridge.piOpen as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req).toMatchObject({
      uiSessionId: "s-pi",
      cwd: "/proj",
      model: "pi-model",
      enableToolApproval: true,
      toolWhitelist: undefined,
      delegatePolicy: { maxParallel: 256, maxChildRuns: 25 },
    });
    expect(req.approvalTools).toEqual(expect.arrayContaining(["bash", "write", "edit"]));
    expect(req.delegateRoles).toHaveLength(8);
    expect(req.delegateRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "general", label: "General Agent", agent: "pi" }),
        expect.objectContaining({ id: "code-reviewer", label: "Code Reviewer", agent: "pi" }),
      ]),
    );
    expect((bridge.piPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toContain(
      "由你结合主会话上下文总结",
    );
    expect(bridge.startOrchestration).not.toHaveBeenCalled();

    // 这里验证 preload 回调后的 renderer 半链：三类 confirm 都必须归属父会话并进入主界面
    // 队列。native hook 与 gateway/main 转发分别由 desktop 包的契约测试覆盖。
    for (const toolName of ["bash", "write", "edit"]) {
      act(() => {
        emitUiRequest?.("s-pi", {
          type: "extension_ui_request",
          id: `approve-${toolName}`,
          method: "confirm",
          title: `允许执行工具 ${toolName}?`,
          message: "{}",
        });
      });
    }
    expect(usePersonalStore.getState().piUiPending).toEqual(
      ["bash", "write", "edit"].map((toolName) =>
        expect.objectContaining({
          uiSessionId: "s-pi",
          request: expect.objectContaining({ id: `approve-${toolName}`, method: "confirm" }),
        }),
      ),
    );
  });

  it("默认 Cortex + plan 仍在只读白名单中保留自动委派工具", async () => {
    const bridge = makeBridge({ startCli: undefined });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    const { subagentOrchestration: _unset, ...rest } = usePersonalStore.getState().generalSettings;
    usePersonalStore.setState({ generalSettings: rest });

    await act(async () => {
      await result.current.send({ ...piSession, execPermission: "plan" }, "/proj", "只读分析代码", []);
    });

    const req = (bridge.piOpen as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req.toolWhitelist).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls", "explore_agent", "ask_general"]),
    );
    expect(req.toolWhitelist).not.toEqual(expect.arrayContaining(["bash", "write", "edit"]));
    expect(req.delegateRoles).toHaveLength(8);
  });

  it("Cortex artifact + ask 与显式子 Agent 仍走 Pi RPC，并使用独立 cwd、skill 与审批配置", async () => {
    const artifact = {
      kind: "slides" as const,
      documentId: "deck-1",
      title: "季度总结",
      workspaceRoot: "/artifact/workspace",
      entryPath: "/artifact/workspace/.cortex-design/deck-1/slides.html",
      createdAt: 1,
      updatedAt: 1,
    };
    const resumeKey = [artifact.workspaceRoot, artifact.documentId, "pi", "", ""].join("\u0000");
    const session: SessionMeta = {
      ...piSession,
      execPermission: "ask",
      artifacts: [artifact],
      activeArtifact: artifact,
      // 迁移前 oneshot 保存的是逻辑 id；RPC 不能把它当 JSONL 交给 pi:switchSession。
      artifactSessionIds: { [resumeKey]: "legacy-logical-session-id" },
    };
    usePersonalStore.setState({ sessions: [claudeSession, session] });
    const bridge = makeBridge({
      startCli: undefined,
      piOpen: vi.fn(async (req: { uiSessionId: string }) => ({
        uiSessionId: req.uiSessionId,
        sessionId: "pi-artifact",
        sessionFile: "/sessions/deck-1.jsonl",
      })),
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current.send(
        session,
        "/project",
        "@codex 修改第三页",
        [],
        "只修改当前演示文稿。",
        undefined,
        undefined,
        undefined,
        { name: "slides", path: "/skills/slides" },
        undefined,
        artifact,
      );
    });

    expect(bridge.startCli).toBeUndefined();
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piPrompt).toHaveBeenCalledTimes(1);
    const request = (bridge.piOpen as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      uiSessionId: "s-pi",
      cwd: artifact.workspaceRoot,
      artifactContext: artifact,
      enableToolApproval: true,
    });
    expect(request.approvalTools).toEqual(expect.arrayContaining(["bash", "write", "edit"]));
    expect(request.skillPaths).toContain("/skills/slides");
    expect(request.enableArtifactsTool).toBeUndefined();
    expect(request.enableJsReplTool).toBeUndefined();
    expect(request.delegateRoles).toEqual([
      expect.objectContaining({ id: "codex", agent: "pi", model: undefined }),
    ]);
    expect((bridge.piPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatch(
      /^artifact:slides:deck-1:/,
    );
    expect(bridge.piSwitchSession).not.toHaveBeenCalled();
    const stored = usePersonalStore.getState().sessions.find((candidate) => candidate.id === session.id);
    expect(stored?.artifactSessionIds?.[resumeKey]).toBe("/sessions/deck-1.jsonl");
    expect(stored?.piSessionFile).toBeUndefined();
  });

  it("Pi 自动委派仍由 RPC 从已有 sessionFile 恢复，不序列化 UI 历史", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    setOrchestration(true);
    const session = { ...piSession, piSessionFile: "/sessions/existing.jsonl" };

    await act(async () => {
      await result.current.send(session, "/proj", "暗号是什么？", []);
    });

    expect(bridge.startCli).not.toHaveBeenCalled();
    expect(bridge.piSwitchSession).toHaveBeenCalledWith("s-pi", "/sessions/existing.jsonl");
    const req = (bridge.piOpen as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(req.delegateRoles).toEqual(expect.any(Array));
    expect(req).not.toHaveProperty("conversationContext");
  });

  it("Pi RPC 动态启停委派：按冷配置重开，但从同一 sessionFile 恢复", async () => {
    let openCount = 0;
    const bridge = makeBridge({
      piOpen: vi.fn(async (req: { uiSessionId: string }) => ({
        uiSessionId: req.uiSessionId,
        sessionId: `pi-${++openCount}`,
        sessionFile: openCount === 1 ? "/sessions/s.jsonl" : "/sessions/new-empty.jsonl",
      })),
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    setOrchestration(false);
    await act(async () => {
      await result.current.send(piSession, "/proj", "第一轮普通对话", []);
    });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    usePersonalStore.getState().setRunning(piSession.id, undefined);

    setOrchestration(true);
    const afterRpc = usePersonalStore.getState().sessions.find((s) => s.id === piSession.id)!;
    await act(async () => {
      await result.current.send(afterRpc, "/proj", "委派分析", []);
    });
    expect(bridge.piClose).toHaveBeenCalledWith("s-pi");
    expect(bridge.startCli).not.toHaveBeenCalled();
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
    expect(bridge.piSwitchSession).toHaveBeenLastCalledWith("s-pi", "/sessions/s.jsonl");
    const delegateReq = (bridge.piOpen as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(delegateReq.delegateRoles).toHaveLength(8);
    expect(delegateReq.delegateRoles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "general", agent: "pi" })]),
    );
    usePersonalStore.getState().setRunning(piSession.id, undefined);

    setOrchestration(false);
    const afterDelegate = usePersonalStore.getState().sessions.find((s) => s.id === piSession.id)!;
    await act(async () => {
      await result.current.send(afterDelegate, "/proj", "回到普通对话", []);
    });
    expect(bridge.piOpen).toHaveBeenCalledTimes(3);
    expect(bridge.piSwitchSession).toHaveBeenLastCalledWith("s-pi", "/sessions/s.jsonl");
  });

  it("pi RPC 能力缺失时直接提示,不调用 piOpen/piPrompt", async () => {
    const bridge = makeBridge({ piOpen: undefined, piPrompt: vi.fn(async () => undefined) });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail("s-pi")) ?? [];
    expect(bridge.piOpen).toBeUndefined();
    expect(bridge.piPrompt).not.toHaveBeenCalled();
    expect(bridge.startCli).not.toHaveBeenCalled();
    expect(usePersonalStore.getState().runningBySession["s-pi"]).toBeUndefined();
    expect(msgs.map((m) => (m.kind === "text" ? m.text : "")).join("\n")).toContain("缺少 piOpen");
    expect(msgs.map((m) => (m.kind === "text" ? m.text : "")).join("\n")).toContain("完整重启 Cortex Desktop");
  });

  it("claude 未安装时直接提示,不调用 startCli", async () => {
    usePersonalStore.getState().setAgentsAvailable({ claude: false, codex: true });
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    let consumed = true;
    await act(async () => {
      consumed = await result.current.send(claudeSession, "/proj", "你好", []);
    });
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail("s-claude")) ?? [];
    expect(consumed).toBe(false);
    expect(bridge.startCli).not.toHaveBeenCalled();
    expect(usePersonalStore.getState().runningBySession["s-claude"]).toBeUndefined();
    expect(msgs.map((m) => (m.kind === "text" ? m.text : "")).join("\n")).toContain("Claude Code 未安装或不可用");
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

  it("Pi result 后仍阻止新 send，authoritative settled 到达后才允许下一轮", async () => {
    let emitPiEvent: ((uiSessionId: string, event: PiSessionEvent, runId?: string) => void) | undefined;
    const bridge = makeBridge({
      onPiEvent: vi.fn((cb: (uiSessionId: string, event: PiSessionEvent, runId?: string) => void) => {
        emitPiEvent = cb;
        return () => undefined;
      }),
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => {
      usePersonalPiEvents();
      return usePersonalActions();
    }, { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current.send(piSession, "/proj", "第一轮", []);
    });
    const runId = usePersonalStore.getState().runningBySession[piSession.id]!;
    act(() => emitPiEvent?.(piSession.id, { type: "result", willRetry: false }, runId));

    let acceptedWhileFollowingUp = true;
    await act(async () => {
      acceptedWhileFollowingUp = await result.current.send(piSession, "/proj", "不得抢跑", []);
    });
    expect(acceptedWhileFollowingUp).toBe(false);
    expect(bridge.piPrompt).toHaveBeenCalledTimes(1);
    expect(usePersonalStore.getState().runningBySession[piSession.id]).toBe(runId);

    act(() => emitPiEvent?.(piSession.id, { type: "settled" }, runId));
    await act(async () => {
      await result.current.send(piSession, "/proj", "第二轮", []);
    });
    expect(bridge.piPrompt).toHaveBeenCalledTimes(2);
  });

  it("send 后把 sessionFile 持久到 SessionMeta.piSessionFile（阶段4 U1）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    expect(usePersonalStore.getState().sessions.find((s) => s.id === "s-pi")?.piSessionFile).toBe("/sessions/s.jsonl");
  });

  it("会话有 piSessionFile（崩溃后）→ send 传 resumeFrom 触发 switchSession 恢复（阶段4 U3）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    usePersonalStore.setState({ sessions: [{ ...piSession, piSessionFile: "/sessions/old.jsonl" }] });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send({ ...piSession, piSessionFile: "/sessions/old.jsonl" }, "/proj", "续上", []);
    });
    expect(bridge.piSwitchSession).toHaveBeenCalledWith("s-pi", "/sessions/old.jsonl");
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

  it("@mention 委派续接主会话：子 init 不污染，主 init 更新主会话 resume id", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current.send(claudeSession, "/proj", "@codex 看一下", []);
    });

    const req = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req.resumeSessionId).toBe("c1");
    expect(req.delegateRoles?.map((r: { id: string }) => r.id)).toEqual(["codex"]);

    __handleCliEventForTest(
      qc,
      req.runId,
      { type: "init", sessionId: "delegate-temp-thread", roleId: "codex", stageLabel: "Codex" },
      claudeSession.id,
    );

    expect(usePersonalStore.getState().sessions.find((s) => s.id === claudeSession.id)?.agentSessionIds?.claude).toBe(
      "c1",
    );

    __handleCliEventForTest(qc, req.runId, { type: "init", sessionId: "claude-main-2" }, claudeSession.id);
    expect(usePersonalStore.getState().sessions.find((s) => s.id === claudeSession.id)?.agentSessionIds?.claude).toBe(
      "claude-main-2",
    );

    __handleCliEventForTest(
      qc,
      req.runId,
      { type: "text", delta: "子 Agent 原始结果", roleId: "codex" },
      claudeSession.id,
    );
    __handleCliEventForTest(qc, req.runId, { type: "text", delta: "主会话总结结果" }, claudeSession.id);
    const chat = qc.getQueryData<Message[]>(personalChatKeys.detail(claudeSession.id)) ?? [];
    const process = qc.getQueryData<Message[]>(personalProcessKeys.detail(claudeSession.id)) ?? [];
    expect(chat.some((message) => message.kind === "text" && message.text === "子 Agent 原始结果")).toBe(false);
    expect(chat.some((message) => message.kind === "text" && message.text === "主会话总结结果")).toBe(true);
    expect(process.some((message) => message.kind === "reasoning" && message.text === "子 Agent 原始结果")).toBe(true);
  });

  it("claude 会话思考强度经 startCli.effort 下发", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const session = { ...claudeSession, effort: "high" } as SessionMeta;
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(session, "/proj", "需要认真推理", []);
    });
    const req = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req).toMatchObject({ agent: "claude", effort: "high" });
  });

  it("claude:带文档 → doc:save 落盘 + appendSystemPrompt 注入文档清单/extract_document + Message.files 回显", async () => {
    const docSave = docSaveMock();
    const bridge = makeBridge({ docSave });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(claudeSession, "/proj", "分析这个", [], undefined, undefined, undefined, [pendingDoc("a.pdf")]);
    });
    expect(docSave).toHaveBeenCalledTimes(1);
    const req = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req.appendSystemPrompt).toContain("/docs/a.pdf");
    expect(req.appendSystemPrompt).toContain("extract_document");
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(claudeSession.id)) ?? [];
    const userMsg = msgs.find((m) => m.kind === "text" && m.who === "me");
    expect(userMsg && userMsg.kind === "text" ? userMsg.files?.[0]?.path : undefined).toBe("/docs/a.pdf");
  });

  it("pi:带文档 → doc:save + piPrompt 文本含文档清单/extract_document", async () => {
    const docSave = docSaveMock();
    const bridge = makeBridge({ docSave });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "看看这个", [], undefined, undefined, undefined, [pendingDoc("b.docx")]);
    });
    expect(docSave).toHaveBeenCalledTimes(1);
    const promptArg = (bridge.piPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(String(promptArg)).toContain("/docs/b.docx");
    expect(String(promptArg)).toContain("extract_document");
  });
});

describe("cleanToolName(MCP 工具可观测性)", () => {
  it("去 claude 的 mcp__<server>__ 前缀", () => {
    expect(cleanToolName("mcp__cortex-docs__extract_document")).toBe("extract_document");
    expect(cleanToolName("mcp__cortex-browser__browser_navigate")).toBe("browser_navigate");
  });
  it("非 MCP 工具原样", () => {
    expect(cleanToolName("bash")).toBe("bash");
    expect(cleanToolName("extract_document")).toBe("extract_document");
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

  it("pi stop:待答 askquestion 卡回 cancelled 解锁 pi + 出队,他会话卡不动（U6）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    const aq = (id: string): PiUiRequest =>
      ({ type: "extension_ui_request", id, method: "askquestion", envelope: { groups: [] } }) as unknown as PiUiRequest;
    usePersonalStore.setState({
      piUiPending: [
        { uiSessionId: piSession.id, request: aq("aq1") },
        { uiSessionId: "s-other", request: aq("aq2") },
      ],
    });
    await act(async () => {
      await result.current.stop(piSession.id);
    });
    expect(bridge.piUiResponse).toHaveBeenCalledWith("s-pi", "aq1", { cancelled: true });
    // 本会话待答卡出队;后台会话 s-other 的卡保留(隔离)。
    expect(usePersonalStore.getState().piUiPending.map((p) => p.request.id)).toEqual(["aq2"]);
  });

  it("pi delegate RPC 轮 stop → piAbort 级联取消主/子 RPC，不 killCli", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    setOrchestration(true);
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    const runId = usePersonalStore.getState().runningBySession[piSession.id];
    expect(bridge.piPrompt).toHaveBeenCalledTimes(1);
    expect(runId).toEqual(expect.any(String));
    await act(async () => {
      await result.current.stop(piSession.id);
    });
    expect(bridge.piAbort).toHaveBeenCalledWith("s-pi");
    expect(bridge.killCli).not.toHaveBeenCalled();
    expect(bridge.killOrchestration).not.toHaveBeenCalled();
  });

  it("pi delegate RPC 轮长时间静默也不被 CLI watchdog 杀死", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    setOrchestration(true);
    await act(async () => {
      await result.current.send(piSession, "/proj", "你好", []);
    });
    const runId = usePersonalStore.getState().runningBySession[piSession.id];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_START_TIMEOUT_MS + 1_000);
    });

    expect(usePersonalStore.getState().runningBySession[piSession.id]).toBe(runId);
    expect(bridge.killCli).not.toHaveBeenCalled();
    expect(bridge.killOrchestration).not.toHaveBeenCalled();
    expect(bridge.piUiResponse).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.stop(piSession.id);
    });
    expect(bridge.piAbort).toHaveBeenCalledWith("s-pi");
    vi.useRealTimers();
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

  it("usePersonalPiUi:askquestion 入队渲染(不立即取消)", () => {
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
    emit!("s-pi", {
      type: "extension_ui_request",
      id: "aq1",
      method: "askquestion",
      envelope: { groups: [{ id: "g0", question: "Q", options: [{ label: "A" }], allowCustom: false }] },
    });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(1);
    expect(usePersonalStore.getState().piUiPending[0]).toMatchObject({
      uiSessionId: "s-pi",
      request: { method: "askquestion" },
    });
    expect(piUiResponse).not.toHaveBeenCalled(); // 不立即取消
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

  it("compact:会话已开 → 调 piCompact 透传指令", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "hi", []);
    });
    await act(async () => {
      await result.current.compact(piSession.id, "保留最近 3 轮");
    });
    expect(bridge.piCompact).toHaveBeenCalledWith("s-pi", "保留最近 3 轮");
    // 成功 → 补一条确认,避免「点了没反应」。
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(piSession.id)) ?? [];
    expect(msgs.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("已压缩上下文"))).toBe(true);
  });

  it("compact:失败(上下文过短)→ 给可读反馈,不静默", async () => {
    const bridge = makeBridge({ piCompact: vi.fn(async () => { throw new Error("Nothing to compact (session too small)"); }) });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "hi", []);
    });
    await act(async () => {
      await result.current.compact(piSession.id);
    });
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(piSession.id)) ?? [];
    expect(msgs.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("无需压缩"))).toBe(true);
  });

  it("compact:claude 会话 no-op:不调 piCompact", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.compact(claudeSession.id);
    });
    expect(bridge.piCompact).not.toHaveBeenCalled();
  });

  it("compact:会话未就绪 → 不调 piCompact（无上下文可压缩）", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    // 未先 send 开会话 → isPiSessionOpen 为假。
    await act(async () => {
      await result.current.compact(piSession.id);
    });
    expect(bridge.piCompact).not.toHaveBeenCalled();
  });

  it("setPiModel:会话已开 + 同 provider → updateSession + 实时 piSetModel", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const session = { ...piSession, providerId: "deepseek", model: "deepseek-chat" };
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(session, "/proj", "hi", []);
    });
    await act(async () => {
      result.current.setPiModel(session, "deepseek", "deepseek-reasoner");
    });
    expect(bridge.piSetModel).toHaveBeenCalledWith("s-pi", "deepseek", "deepseek-reasoner");
    expect(usePersonalStore.getState().sessions.find((s) => s.id === "s-pi")).toMatchObject({
      providerId: "deepseek",
      model: "deepseek-reasoner",
    });
  });

  it("setPiModel:会话已开 + 跨 provider → 仅 updateSession,不实时下发(下一轮经指纹漂移重开生效)", async () => {
    const bridge = makeBridge();
    const qc = new QueryClient();
    const session = { ...piSession, providerId: "p0", model: "m0" };
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(session, "/proj", "hi", []);
    });
    await act(async () => {
      result.current.setPiModel(session, "deepseek", "deepseek-chat");
      await Promise.resolve();
    });
    // 目标 provider 的 extension/密钥不在当前 pi 进程里,实时 set_model 必失败 → 不下发。
    expect(bridge.piSetModel).not.toHaveBeenCalled();
    // 记忆保持新值(不回滚):下一轮 send 经 extensionFingerprint(含 providerId)漂移重开会话。
    expect(usePersonalStore.getState().sessions.find((s) => s.id === "s-pi")).toMatchObject({
      providerId: "deepseek",
      model: "deepseek-chat",
    });
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail("s-pi")) ?? [];
    expect(msgs.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("切换模型失败"))).toBe(false);
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

  it("setPiModel 同 provider 实时下发失败 → 回滚会话记忆 + ⚠️ 提示（阶段4 U8）", async () => {
    const bridge = makeBridge({ piSetModel: vi.fn(async () => Promise.reject(new Error("不支持轮中切"))) });
    const qc = new QueryClient();
    // 会话已有 model，open 后切换失败应回滚到原值。
    usePersonalStore.setState({
      sessions: [{ ...piSession, providerId: "p0", model: "m0" }],
    });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send({ ...piSession, providerId: "p0", model: "m0" }, "/proj", "hi", []);
    });
    await act(async () => {
      result.current.setPiModel({ ...piSession, providerId: "p0", model: "m0" }, "p0", "m1");
      await Promise.resolve();
    });
    expect(usePersonalStore.getState().sessions.find((s) => s.id === "s-pi")).toMatchObject({
      providerId: "p0",
      model: "m0",
    }); // 回滚
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail("s-pi")) ?? [];
    expect(msgs.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("切换模型失败"))).toBe(true);
  });
});

describe("agent 报错:当场可见但不落盘 + 失败信息写日志", () => {
  it("agent 不可用:报错进缓存可见,saveChat 落盘已剥离,logMessage 记录失败", async () => {
    const saveChat = vi.fn(async () => undefined);
    const logMessage = vi.fn(async () => undefined);
    const bridge = makeBridge({ saveChat, logMessage });
    const qc = new QueryClient();
    usePersonalStore.setState({ agentsAvailable: { claude: false, codex: true, pi: true } });
    // usePersonalPiEvents 挂载即把 bridgeRef 指向本 bridge（生产中由 PersonalWorkspace 根部挂载），
    // 使 flushChat 落盘与 appendMsg 写日志可用。
    const { result } = renderHook(
      () => {
        usePersonalPiEvents();
        return usePersonalActions();
      },
      { wrapper: wrapper(bridge, qc) },
    );
    await act(async () => {
      await result.current.send(claudeSession, "/proj", "hi", []);
    });
    // 报错当场可见(中栏缓存里有 who:"claude" 的提示)。
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail("s-claude")) ?? [];
    expect(msgs.some((m) => m.kind === "text" && m.who === "claude")).toBe(true);
    // 不落盘:flushChat 存 sanitize 后的,报错被剥离;用户消息仍在。
    const lastSaved = (saveChat as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Message[];
    expect(lastSaved.some((m) => m.kind === "text" && m.who === "claude")).toBe(false);
    expect(lastSaved.some((m) => m.kind === "text" && m.who === "me")).toBe(true);
    // 失败信息写主进程日志(含 session id)。
    expect(logMessage).toHaveBeenCalledWith("error", expect.stringContaining("session=s-claude"));
  });
});

describe("send 图片路由（U4）", () => {
  it("claude:逐张 imageSave + startCli.images 保序;用户消息带 images refs;返回已消费", async () => {
    const save = imageSaveMock();
    const bridge = makeBridge({ imageSave: save });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    let consumed: boolean | undefined;
    await act(async () => {
      consumed = await result.current.send(claudeSession, "/proj", "看图", [], undefined, [pendingImg("a.png"), pendingImg("b.png")]);
    });
    expect(consumed).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    const req = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(req.images).toEqual([
      { path: "/img/a.png", mimeType: "image/png" },
      { path: "/img/b.png", mimeType: "image/png" },
    ]);
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(claudeSession.id)) ?? [];
    const userMsg = msgs.find((m) => m.kind === "text" && m.who === "me");
    expect(userMsg?.kind === "text" ? userMsg.images?.map((i) => i.path) : null).toEqual(["/img/a.png", "/img/b.png"]);
  });

  it("pi:imageSave + piPrompt 第4参 imagePaths(绝对路径,保序)", async () => {
    const save = imageSaveMock();
    const bridge = makeBridge({ imageSave: save });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piVisionSession, "/proj", "看图", [], undefined, [pendingImg("x.png")]);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect((bridge.piPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[3]).toEqual(["/img/x.png"]);
  });

  it("pi 文本模型 + 图片:发送前被阻断(不 imageSave、不 piPrompt),草稿完整保留并留下拦截提示", async () => {
    const save = imageSaveMock();
    const bridge = makeBridge({ imageSave: save });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    let consumed: boolean | undefined;
    await act(async () => {
      consumed = await result.current.send(piTextSession, "/proj", "看图", [], undefined, [pendingImg("x.png")]);
    });
    // 返回 false = composer 保留文本/图片/附件/编辑态；图片未落盘故不留孤儿文件。
    expect(consumed).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(bridge.piPrompt).not.toHaveBeenCalled();
    expect(qc.getQueryData<Message[]>(personalChatKeys.detail("s-pi")) ?? []).toHaveLength(0);
    expect(usePersonalStore.getState().visionBlockHints["s-pi"]?.reason).toBe("unsupported");
  });

  it("pi 模型不在 Catalog 中(能力未知):同样阻断,但 reason 是 unknown 而非 unsupported", async () => {
    const save = imageSaveMock();
    const bridge = makeBridge({ imageSave: save });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    const unknownSession = { ...piSession, providerId: "test-provider", model: "not-in-catalog" };
    await act(async () => {
      await result.current.send(unknownSession, "/proj", "看图", [], undefined, [pendingImg("x.png")]);
    });
    expect(save).not.toHaveBeenCalled();
    expect(usePersonalStore.getState().visionBlockHints["s-pi"]?.reason).toBe("unknown");
  });

  it("纯图无文本:允许发送(startCli 被调用)", async () => {
    const bridge = makeBridge({ imageSave: imageSaveMock() });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    let consumed: boolean | undefined;
    await act(async () => {
      consumed = await result.current.send(claudeSession, "/proj", "", [], undefined, [pendingImg("a.png")]);
    });
    expect(consumed).toBe(true);
    expect(bridge.startCli).toHaveBeenCalledTimes(1);
  });

  it("imageSave 失败:整轮中止(不 startCli)、返回未消费、提示保存失败(AE10)", async () => {
    const bridge = makeBridge({ imageSave: vi.fn(async () => Promise.reject(new Error("磁盘满"))) });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    let consumed: boolean | undefined;
    await act(async () => {
      consumed = await result.current.send(claudeSession, "/proj", "看图", [], undefined, [pendingImg("a.png")]);
    });
    expect(consumed).toBe(false);
    expect(bridge.startCli).not.toHaveBeenCalled();
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(claudeSession.id)) ?? [];
    expect(msgs.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("图片保存失败"))).toBe(true);
  });

  it("纯文本(无图):imageSave 不被调用,startCli.images 为 undefined(R16 回归)", async () => {
    const save = imageSaveMock();
    const bridge = makeBridge({ imageSave: save });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(claudeSession, "/proj", "纯文本", []);
    });
    expect(save).not.toHaveBeenCalled();
    expect((bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].images).toBeUndefined();
  });

  it("pi 不可用兜底 + presavedImages(editResend 复用):回显仍带图,不静默丢图", async () => {
    const bridge = makeBridge({ piOpen: undefined }); // pi RPC 不可用
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    const refs = [{ path: "/img/a.png", name: "a.png", mimeType: "image/png" }];
    await act(async () => {
      await result.current.send(piVisionSession, "/proj", "改后", [], undefined, undefined, refs);
    });
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail("s-pi")) ?? [];
    const userMsg = msgs.find((m) => m.kind === "text" && m.who === "me");
    expect(userMsg?.kind === "text" ? userMsg.images?.map((i) => i.path) : null).toEqual(["/img/a.png"]);
  });

  it("editResend:复用原消息已落盘图(不重新 imageSave),随重发带回 startCli.images(AE8)", async () => {
    const save = imageSaveMock();
    const bridge = makeBridge({ imageSave: save });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(claudeSession, "/proj", "原问题", [], undefined, [pendingImg("a.png")]);
    });
    usePersonalStore.getState().setRunning(claudeSession.id, undefined);
    const uid = userMsgUid(qc, claudeSession.id, "原问题");
    await act(async () => {
      await result.current.editResend(claudeSession, "/proj", uid, "改后", []);
    });
    expect(save).toHaveBeenCalledTimes(1); // 仅原发一次,editResend 复用不重存
    const lastReq = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(lastReq.images).toEqual([{ path: "/img/a.png", mimeType: "image/png" }]);
  });
});

describe("editResend fork 可观测 + 后缀匹配（阶段4 U9/U10）", () => {
  it("fork 定位失败（无匹配 entry）→ 关闭旧 Pi 上下文,不恢复旧 sessionFile,不显示定位告警但仍重发（U9）", async () => {
    const bridge = makeBridge({ piGetForkMessages: vi.fn(async () => ({ messages: [{ entryId: "e9", text: "别的问题" }] })) });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "原问题", []);
    });
    usePersonalStore.getState().setRunning(piSession.id, undefined);
    const livePiSession = usePersonalStore.getState().sessions.find((s) => s.id === piSession.id)!;
    expect(livePiSession.piSessionFile).toBe("/sessions/s.jsonl");
    const uid = userMsgUid(qc, piSession.id, "原问题");
    await act(async () => {
      await result.current.editResend(livePiSession, "/proj", uid, "改后", []);
    });
    expect(bridge.piFork).not.toHaveBeenCalled(); // 无匹配 → 不 fork
    expect(bridge.piClose).toHaveBeenCalledWith("s-pi");
    expect(bridge.piOpen).toHaveBeenCalledTimes(2); // close 后重开干净 Pi 会话
    expect(bridge.piSwitchSession).not.toHaveBeenCalled(); // 不从旧 JSONL 恢复被编辑前上下文
    expect(usePersonalStore.getState().sessions.find((s) => s.id === piSession.id)?.piSessionFile).toBe("/sessions/s.jsonl");
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail(piSession.id)) ?? [];
    expect(msgs.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("未能在 pi 侧定位编辑点"))).toBe(false);
    expect(bridge.piPrompt).toHaveBeenCalledTimes(2); // 仍重发
  });

  it("fork 匹配含内联系统提示前缀的 entry（U10 收紧不误判）", async () => {
    const bridge = makeBridge({
      piGetForkMessages: vi.fn(async () => ({ messages: [{ entryId: "epfx", text: "<project>...</project>\n\n原问题" }] })),
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });
    await act(async () => {
      await result.current.send(piSession, "/proj", "原问题", []);
    });
    usePersonalStore.getState().setRunning(piSession.id, undefined);
    const uid = userMsgUid(qc, piSession.id, "原问题");
    await act(async () => {
      await result.current.editResend(piSession, "/proj", uid, "改后", []);
    });
    expect(bridge.piFork).toHaveBeenCalledWith("s-pi", "epfx"); // \n\n 前缀剥离后匹配
  });
});
