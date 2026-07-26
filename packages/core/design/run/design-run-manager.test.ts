import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesignResumeSessions,
  installDesignRuntime,
  resolveDesignRunAgent,
  sendDesignMessage,
} from "./design-run-manager";
import { usePersonalStore, type PersonalState } from "../../store/personal";
import type { DesktopBridge } from "../../desktop/bridge";
import type { CliExitEvent, CliStreamEvent } from "../../desktop/types";
import { useChatStore } from "../compat/chat-store";
import { useDesignWorkspaceStore } from "../design-workspace-store";

// 构造 resolveDesignRunAgent 所需的最小 personal 切片（只填被读到的字段）。
function slice(input: {
  agent?: string;
  derivedAgentId?: string;
  defaultAgent?: PersonalState["generalSettings"]["defaultAgent"];
  agentsAvailable?: PersonalState["agentsAvailable"];
  derivedAgents?: PersonalState["derivedAgents"];
}): Pick<PersonalState, "designSettings" | "generalSettings" | "agentsAvailable" | "derivedAgents"> {
  return {
    designSettings: { agent: input.agent ?? "", derivedAgentId: input.derivedAgentId ?? "" } as PersonalState["designSettings"],
    generalSettings: { defaultAgent: input.defaultAgent } as PersonalState["generalSettings"],
    agentsAvailable: input.agentsAvailable,
    derivedAgents: input.derivedAgents,
  };
}

describe("resolveDesignRunAgent", () => {
  it("显式选择优先", () => {
    expect(resolveDesignRunAgent(slice({ agent: "codex", agentsAvailable: { codex: true } }))).toEqual({
      agent: "codex",
      derivedId: undefined,
    });
  });

  it("未设置时跟随系统「新会话默认 Agent」", () => {
    expect(
      resolveDesignRunAgent(slice({ agent: "", defaultAgent: "claude", agentsAvailable: { claude: true } })),
    ).toEqual({ agent: "claude", derivedId: undefined });
  });

  it("显式选择不做可用性静默回落(探测可能误判;真不可用由 spawn 前置校验明确报错)", () => {
    // 此前 claude 探测为 false 会悄悄换 codex → UI 显示 claude 实跑 codex,静默分歧极难排查。
    expect(
      resolveDesignRunAgent(slice({ agent: "claude", agentsAvailable: { claude: false, codex: true } })).agent,
    ).toBe("claude");
  });

  it("derivedAgentId 必须仍在派生列表中才返回", () => {
    expect(
      resolveDesignRunAgent(
        slice({
          agent: "claude",
          derivedAgentId: "my-x",
          agentsAvailable: { claude: true },
          derivedAgents: [{ id: "my-x", base: "claude" }],
        }),
      ).derivedId,
    ).toBe("my-x");
    // 派生 id 已失效（不在列表）→ 不返回。
    expect(
      resolveDesignRunAgent(
        slice({ agent: "claude", derivedAgentId: "ghost", agentsAvailable: { claude: true }, derivedAgents: [] }),
      ).derivedId,
    ).toBeUndefined();
  });
});

describe("sendDesignMessage 回合元数据", () => {
  let startCli: ReturnType<typeof vi.fn>;
  let emit: (runId: string, event: CliStreamEvent) => void;
  let emitExit: (exit: CliExitEvent) => void;

  beforeEach(() => {
    clearDesignResumeSessions();
    usePersonalStore.setState((state) => ({
      designSettings: {
        ...state.designSettings,
        agent: "pi",
        derivedAgentId: "",
        providerId: "",
        model: "",
      },
      providerSettings: { providers: [] },
      derivedAgents: [],
    }));
    useChatStore.setState({ blocks: [], threads: [], activeThreadId: null, liveAssistant: "" });
    useDesignWorkspaceStore.setState({
      workspaceRoot: "/tmp/ws",
      activeDocumentId: "deck-1",
      documents: [
        {
          id: "deck-1",
          title: "Deck",
          createdAt: "",
          updatedAt: "",
          order: 0,
          artifacts: [],
          activeArtifactId: null,
          kind: "slides",
          slidesManifestPath: ".cortex-design/deck-1/deck.json",
        },
      ],
    });
    startCli = vi.fn(async () => undefined);
    installDesignRuntime({
      onCliEvent: (cb: (runId: string, event: CliStreamEvent) => void) => {
        emit = cb;
        return () => undefined;
      },
      onCliExit: (cb: (exit: CliExitEvent) => void) => {
        emitExit = cb;
        return () => undefined;
      },
      startCli,
      killCli: vi.fn(async () => undefined),
      designWorkspaceRoot: async () => "/tmp/ws",
    } as unknown as DesktopBridge);
  });

  afterEach(() => {
    for (const [request] of startCli.mock.calls) {
      emitExit({ runId: (request as { runId: string }).runId, code: 0 });
    }
  });

  it("webSearch=true 透传给 cli:start", async () => {
    await sendDesignMessage("查资料", "agent", { webSearch: true });
    expect(startCli).toHaveBeenCalledWith(expect.objectContaining({ webSearch: true }));
  });

  it("未开启 webSearch 时不发送该字段", async () => {
    await sendDesignMessage("不用联网");
    expect(startCli).toHaveBeenCalledWith(expect.not.objectContaining({ webSearch: expect.anything() }));
  });

  it("附件引用落进 user block meta", async () => {
    const attachments = [
      { id: "file-1", kind: "document" as const, name: "brief.md", byteSize: 12, truncated: false },
    ];
    await sendDesignMessage("按附件制作", "agent", { attachments });
    const user = useChatStore.getState().blocks.find((block) => block.kind === "user");
    expect(user?.meta?.attachments).toEqual(attachments);
  });

  it("仅附件回合保留空 displayText，避免把完整合同显示在用户气泡", async () => {
    const attachments = [
      { id: "file-1", kind: "document" as const, name: "brief.md", byteSize: 12 },
    ];
    await sendDesignMessage("<slides contract>", "agent", { displayText: "", attachments });
    const user = useChatStore.getState().blocks.find((block) => block.kind === "user");
    expect(user?.meta?.displayText).toBe("");
  });

  it("同一设计稿第二轮续接第一轮返回的 Agent session", async () => {
    await sendDesignMessage("第一轮：把标题改短");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "agent-session-1" });

    await sendDesignMessage("第二轮：再简洁一点");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ resumeSessionId: "agent-session-1" }),
    );
  });

  it("委派子 Agent 的合成 init 不覆盖顶层 Agent session", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-delegate-init" });
    await sendDesignMessage("第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "top-level-agent-session" });
    emit(firstRequest.runId, {
      type: "init",
      sessionId: "design-deck-delegate-init",
      roleId: "page-slide-3",
    });

    await sendDesignMessage("第二轮");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ resumeSessionId: "top-level-agent-session" }),
    );
  });

  it("同一设计稿切换模型后不续接旧 Agent session", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-model-switch" });
    usePersonalStore.setState((state) => ({
      designSettings: {
        ...state.designSettings,
        agent: "codex",
        derivedAgentId: "",
        model: "model-a",
      },
    }));
    await sendDesignMessage("第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "model-a-session" });

    usePersonalStore.setState((state) => ({
      designSettings: { ...state.designSettings, model: "model-b" },
    }));
    await sendDesignMessage("切换模型后的第一轮");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });

  it("切换设计稿后清除旧设计稿的 Agent session", async () => {
    usePersonalStore.setState((state) => ({
      designSettings: {
        ...state.designSettings,
        agent: "codex",
        derivedAgentId: "",
        model: "model-a",
      },
    }));
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-switch-a" });
    await sendDesignMessage("A 稿第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "deck-a-session" });

    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-switch-b" });
    await sendDesignMessage("B 稿第一轮");
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-switch-a" });
    await sendDesignMessage("重新进入 A 稿");

    expect(startCli.mock.calls[2]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });

  it("显式清除设计稿会话后下一轮不再续接", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-new-conversation" });
    await sendDesignMessage("第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "old-agent-session" });

    clearDesignResumeSessions("deck-new-conversation");
    await sendDesignMessage("新会话第一轮");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });

  it("清除后迟到的旧 init 不会恢复已失效的 Agent session", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-late-init" });
    await sendDesignMessage("旧会话第一轮");
    const oldRequest = startCli.mock.calls[0]?.[0] as { runId: string };

    clearDesignResumeSessions("deck-late-init");
    emit(oldRequest.runId, { type: "init", sessionId: "late-old-session" });
    await sendDesignMessage("新会话第一轮");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });

  it("Agent 明确报告 resume session 丢失后下一轮回退为新会话", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-resume-lost" });
    await sendDesignMessage("第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "missing-agent-session" });

    await sendDesignMessage("第二轮");
    const resumedRequest = startCli.mock.calls[1]?.[0] as { runId: string };
    emit(resumedRequest.runId, {
      type: "result",
      ok: false,
      error: "thread/resume failed: session not found",
    });
    await sendDesignMessage("恢复后的第一轮");

    expect(startCli.mock.calls[2]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });

  it("子 Agent 的 session-lost result 不清除顶层 Agent session", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-child-resume-lost" });
    await sendDesignMessage("第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "top-level-agent-session" });

    await sendDesignMessage("第二轮");
    const resumedRequest = startCli.mock.calls[1]?.[0] as { runId: string };
    emit(resumedRequest.runId, {
      type: "result",
      ok: false,
      error: "thread/resume failed: session not found",
      roleId: "page-slide-3",
    });
    await sendDesignMessage("第三轮");

    expect(startCli.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ resumeSessionId: "top-level-agent-session" }),
    );
  });

  it("切换 Agent 后不续接旧 Agent session", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-agent-switch" });
    usePersonalStore.setState((state) => ({
      designSettings: {
        ...state.designSettings,
        agent: "codex",
        derivedAgentId: "",
        model: "",
      },
    }));
    await sendDesignMessage("Codex 第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "codex-session" });

    usePersonalStore.setState((state) => ({
      designSettings: { ...state.designSettings, agent: "claude" },
    }));
    await sendDesignMessage("Claude 第一轮");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });

  it("切换 Pi provider 后不续接旧 Agent session", async () => {
    const providers = ["provider-a", "provider-b"].map((id) => ({
      id,
      name: id,
      baseUrl: `https://${id}.example.com/v1`,
      endpointFormat: "chat_completions" as const,
      enabled: true,
      models: [{ id: "shared-model", label: "Shared Model" }],
    }));
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-provider-switch" });
    usePersonalStore.setState((state) => ({
      designSettings: {
        ...state.designSettings,
        agent: "pi",
        providerId: "provider-a",
        model: "shared-model",
      },
      providerSettings: { providers },
    }));
    await sendDesignMessage("Provider A 第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "provider-a-session" });

    usePersonalStore.setState((state) => ({
      designSettings: { ...state.designSettings, providerId: "provider-b" },
    }));
    await sendDesignMessage("Provider B 第一轮");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });

  it("切换派生 Agent 后不续接旧 Agent session", async () => {
    useDesignWorkspaceStore.setState({ activeDocumentId: "deck-derived-switch" });
    usePersonalStore.setState((state) => ({
      designSettings: {
        ...state.designSettings,
        agent: "claude",
        derivedAgentId: "derived-a",
        model: "",
      },
      derivedAgents: [
        { id: "derived-a", base: "claude" },
        { id: "derived-b", base: "claude" },
      ],
    }));
    await sendDesignMessage("派生 Agent A 第一轮");
    const firstRequest = startCli.mock.calls[0]?.[0] as { runId: string };
    emit(firstRequest.runId, { type: "init", sessionId: "derived-a-session" });

    usePersonalStore.setState((state) => ({
      designSettings: { ...state.designSettings, derivedAgentId: "derived-b" },
    }));
    await sendDesignMessage("派生 Agent B 第一轮");

    expect(startCli.mock.calls[1]?.[0]).toEqual(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    );
  });
});

// 回归(用户实测):演示文稿改稿在会话里只留下一个「MCP」芯片。
// codex 的 MCP item 可能不带 id,旧实现的 block id 退化成 `${runId}:${name}`,
// 于是同回合的每一次调用都写进同一个 block(且 patchBlock 会一起改到)。
describe("handleDesignCliEvent 的工具块折叠", () => {
  let emit: (runId: string, event: CliStreamEvent) => void;
  let runId: string;

  /** 最小桥:只实现 sendDesignMessage / 事件订阅用到的成员。 */
  function fakeBridge(): DesktopBridge {
    return {
      onCliEvent: (cb: (runId: string, event: CliStreamEvent) => void) => {
        emit = cb;
        return () => undefined;
      },
      onCliExit: () => () => undefined,
      startCli: vi.fn(async (req: { runId: string }) => {
        runId = req.runId;
      }),
      killCli: vi.fn(async () => undefined),
      designWorkspaceRoot: async () => "/tmp/ws",
    } as unknown as DesktopBridge;
  }

  beforeEach(async () => {
    useChatStore.setState({ blocks: [], threads: [], activeThreadId: null, liveAssistant: "" });
    // installDesignRuntime 幂等(同 bridge 跳过),每个用例给一个新桥以重挂订阅。
    installDesignRuntime(fakeBridge());
    await sendDesignMessage("改第 3 页");
  });

  const toolBlocks = () => useChatStore.getState().blocks.filter((b) => b.kind === "tool");

  it("同一回合两次无 toolCallId 的同名 MCP 调用 → 两个独立 block", () => {
    emit(runId, { type: "tool", name: "MCP", phase: "start", input: { tool: "set_slides" } } as CliStreamEvent);
    emit(runId, { type: "tool", name: "MCP", phase: "start", input: { tool: "set_slides" } } as CliStreamEvent);
    expect(toolBlocks()).toHaveLength(2);
    expect(new Set(toolBlocks().map((b) => b.id)).size).toBe(2);
  });

  it("end 帧把 output 合进 meta,且不冲掉 meta.toolName(delegate_task 的 per-page 映射依赖它)", () => {
    emit(runId, {
      type: "tool",
      name: "mcp__cortex-slides__set_slides",
      phase: "start",
      toolCallId: "call_1",
      input: { tool: "set_slides" },
    } as CliStreamEvent);
    emit(runId, {
      type: "tool",
      name: "mcp__cortex-slides__set_slides",
      phase: "end",
      toolCallId: "call_1",
      output: '{"ok":true,"revision":72,"replacedPages":[3]}',
    } as CliStreamEvent);
    const block = toolBlocks()[0];
    expect(block?.kind === "tool" && block.status).toBe("success");
    expect(block?.kind === "tool" && block.meta?.toolName).toBe("mcp__cortex-slides__set_slides");
    expect(block?.kind === "tool" && block.meta?.output).toContain("replacedPages");
  });

  it("end 帧按 FIFO 落到对应 block(第一条先完成)", () => {
    emit(runId, { type: "tool", name: "MCP", phase: "start" } as CliStreamEvent);
    emit(runId, { type: "tool", name: "MCP", phase: "start" } as CliStreamEvent);
    emit(runId, { type: "tool", name: "MCP", phase: "end", isError: true } as CliStreamEvent);
    const [first, second] = toolBlocks();
    expect(first?.kind === "tool" && first.status).toBe("error");
    expect(second?.kind === "tool" && second.status).toBe("running");
  });
});
