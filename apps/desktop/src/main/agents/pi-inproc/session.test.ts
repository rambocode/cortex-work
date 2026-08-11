// 会话层单测。用 pi 模块替身（不加载真 ESM 包）覆盖四类：
//   1. `buildRpcArgs()` 每个 flag 的 in-process 对应物是否真的被下发；
//   2. 命令语义与 RpcResponse 形状（pi-session.ts 的 command() 只认 success/data/error）；
//   3. **异常边界**——命令抛错、受理后抛错、stop 之后的调用，一律不得冒泡（KTD5 + 进程隔离消失）；
//   4. 扩展命令补发收尾（pi 对 /cmd 不跑 agent，不补发的话 renderer 永久卡「思考中」）。

import { beforeEach, describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../ipc/agent-trace", () => ({ recordAgentTrace: vi.fn(), recordStreamDelta: vi.fn() }));

import { openPiInProcSession, type PiInProcSession } from "./session";
import type { PiCodingAgentModule } from "./runtime";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest } from "../../ipc/types";

// ── pi 模块替身 ──────────────────────────────────────────────────────────────────────

type PromptImpl = (
  text: string,
  options?: { preflightResult?: (ok: boolean) => void; images?: unknown[] },
) => Promise<void>;

/** AgentSession 的最小替身。只实现本层真正调用到的成员。 */
function makeAgentSession(id: string) {
  const listeners = new Set<(e: unknown) => void>();
  const state = {
    id,
    listeners,
    bindCalls: [] as unknown[],
    activeTools: [] as string[],
    disposed: false,
    // 默认 prompt：正常受理 + 立即完成。逐用例可替换。
    promptImpl: (async (_text, options) => {
      options?.preflightResult?.(true);
    }) as PromptImpl,
    steerCalls: [] as string[],
    setModelCalls: [] as unknown[],
    thinkingCalls: [] as string[],
  };
  const session = {
    sessionId: `sess-${id}`,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: undefined as string | undefined,
    model: { provider: "anthropic", id: "claude-x" },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: true,
    messages: [{ role: "user" }],
    pendingMessageCount: 0,
    promptTemplates: [{ name: "tpl", description: "模板" }],
    resourceLoader: { getSkills: () => ({ skills: [{ name: "s1", description: "技能" }] }) },
    extensionRunner: { getRegisteredCommands: () => [{ invocationName: "memory", description: "扩展命令" }] },
    modelRuntime: {
      getAvailable: async () => [{ provider: "anthropic", id: "claude-x" }],
    },
    subscribe(listener: (e: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async bindExtensions(bindings: unknown) {
      state.bindCalls.push(bindings);
    },
    prompt: (text: string, options?: Parameters<PromptImpl>[1]) => state.promptImpl(text, options),
    steer: async (m: string) => void state.steerCalls.push(m),
    followUp: async (m: string) => void state.steerCalls.push(m),
    abort: async () => {},
    waitForIdle: async () => {},
    reload: async () => {},
    compact: async (instructions?: string) => ({ summary: "压缩完成", instructions }),
    setModel: async (m: unknown) => void state.setModelCalls.push(m),
    setThinkingLevel: (l: string) => void state.thinkingCalls.push(l),
    getSessionStats: () => ({ sessionId: `sess-${id}`, totalMessages: 1 }),
    getLastAssistantText: () => "最后一句",
    getUserMessagesForForking: () => [{ entryId: "e1", text: "第一条" }],
    navigateTree: async () => ({ cancelled: false }),
    getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "find" }, { name: "ls" }],
    setActiveToolsByName: (names: string[]) => {
      state.activeTools = names;
    },
  };
  return { session, state, emit: (e: unknown) => listeners.forEach((l) => l(e)) };
}

function makeMod() {
  const servicesCalls: Array<Record<string, unknown>> = [];
  const sessionCalls: Array<Record<string, unknown>> = [];
  const created: Array<ReturnType<typeof makeAgentSession>> = [];
  let seq = 0;
  const disposed = { count: 0 };

  const mod = {
    getAgentDir: () => "/fake/.pi/agent",
    SessionManager: {
      create: (cwd: string, dir?: string) => ({ cwd, dir, getCwd: () => cwd }),
    },
    createAgentSessionServices: async (opts: Record<string, unknown>) => {
      servicesCalls.push(opts);
      return { cwd: opts.cwd, agentDir: opts.agentDir, diagnostics: [] };
    },
    createAgentSessionFromServices: async (opts: Record<string, unknown>) => {
      sessionCalls.push(opts);
      const made = makeAgentSession(`s${++seq}`);
      created.push(made);
      return { session: made.session, extensionsResult: {} };
    },
    createAgentSessionRuntime: async (
      factory: (o: Record<string, unknown>) => Promise<{ session: unknown }>,
      opts: Record<string, unknown>,
    ) => {
      const build = async (): Promise<unknown> =>
        (await factory({ cwd: opts.cwd, agentDir: opts.agentDir, sessionManager: opts.sessionManager })).session;
      let current = await build();
      return {
        get session() {
          return current;
        },
        diagnostics: [],
        modelFallbackMessage: undefined,
        dispose: async () => {
          disposed.count++;
        },
        // 三个会替换 AgentSession 实例的命令：重跑工厂，模拟 pi 的真实行为。
        fork: async (entryId: string) => {
          current = await build();
          return { cancelled: false, selectedText: `text-of-${entryId}` };
        },
        newSession: async () => {
          current = await build();
          return { cancelled: false };
        },
        switchSession: async () => {
          current = await build();
          return { cancelled: false };
        },
      };
    },
  };
  return { mod: mod as unknown as PiCodingAgentModule, servicesCalls, sessionCalls, created, disposed };
}

interface Harness {
  session: PiInProcSession;
  events: Array<{ ev: PiSessionEvent; runId?: string }>;
  uiRequests: PiUiRequest[];
  fake: ReturnType<typeof makeMod>;
}

async function open(req: Partial<PiOpenRequest> = {}, fake = makeMod()): Promise<Harness> {
  const events: Array<{ ev: PiSessionEvent; runId?: string }> = [];
  const uiRequests: PiUiRequest[] = [];
  const session = await openPiInProcSession({
    request: { uiSessionId: "ui-1", cwd: "/proj", ...req },
    onEvent: (ev, runId) => events.push({ ev, runId }),
    onUiRequest: (r) => uiRequests.push(r),
    askQuestionSentinel: "@@S@@",
    deps: { loadModule: async () => fake.mod },
  });
  return { session, events, uiRequests, fake };
}

beforeEach(() => {
  logMocks.logger.warn.mockClear();
  logMocks.logger.error.mockClear();
});

// ── 1. CLI flag → in-process 选项映射 ────────────────────────────────────────────────

describe("buildRpcArgs 的 flag 对应物", () => {
  it("--no-extensions 恒开;--no-skills 随 useOwnSkills;--skill 逐个注入", async () => {
    const a = await open({ skillPaths: ["/skills/x"] });
    const loader = a.fake.servicesCalls[0]!.resourceLoaderOptions as Record<string, unknown>;
    expect(loader.noExtensions).toBe(true);
    expect(loader.noSkills).toBe(true); // useOwnSkills 未置 true
    expect(loader.additionalSkillPaths).toEqual(["/skills/x"]);

    const b = await open({ useOwnSkills: true });
    const loaderB = b.fake.servicesCalls[0]!.resourceLoaderOptions as Record<string, unknown>;
    expect(loaderB.noSkills).toBe(false);
  });

  it("--append-system-prompt 变成数组;--thinking / --tools 进会话选项", async () => {
    const h = await open({
      appendSystemPrompt: "额外提示",
      thinkingLevel: "high",
      toolWhitelist: ["read", "grep", "find", "ls"],
    });
    const loader = h.fake.servicesCalls[0]!.resourceLoaderOptions as Record<string, unknown>;
    expect(loader.appendSystemPrompt).toEqual(["额外提示"]);
    const sess = h.fake.sessionCalls[0]!;
    expect(sess.thinkingLevel).toBe("high");
    expect(sess.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("无 toolWhitelist 时不下发 tools(缺省 = 全工具,等价于不传 --tools)", async () => {
    const h = await open();
    expect(h.fake.sessionCalls[0]!.tools).toBeUndefined();
  });

  it("--model/--provider 走注入点;缺注入器且指定了模型时响亮告警(绝不静默兜底)", async () => {
    await open({ model: "claude-x", providerId: "anthropic" });
    expect(logMocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("未解析出模型"),
      expect.objectContaining({ requested: "claude-x" }),
    );
  });

  it("resolveModel 注入的 modelRuntime / model 被透传给 pi", async () => {
    const fake = makeMod();
    const modelRuntime = { tag: "runtime" };
    const model = { provider: "p", id: "m" };
    await openPiInProcSession({
      request: { uiSessionId: "ui-1", cwd: "/proj", model: "m" },
      onEvent: () => {},
      deps: { loadModule: async () => fake.mod, resolveModel: async () => ({ modelRuntime, model }) },
    });
    expect(fake.servicesCalls[0]!.modelRuntime).toBe(modelRuntime);
    expect(fake.sessionCalls[0]!.model).toBe(model);
    expect(logMocks.logger.warn).not.toHaveBeenCalled();
  });
});

// ── 2. 命令语义 ──────────────────────────────────────────────────────────────────────

describe("命令与 RpcResponse 形状", () => {
  it("ready 直接给出 sessionId / sessionFile(无需轮询 get_state)", async () => {
    const h = await open();
    await expect(h.session.ready()).resolves.toEqual({ sessionId: "sess-s1", sessionFile: "/tmp/s1.jsonl" });
  });

  it("getState 字段与 pi rpc-mode 的 get_state 对齐", async () => {
    const h = await open();
    const resp = await h.session.getState();
    expect(resp.success).toBe(true);
    expect(resp.data).toMatchObject({
      sessionId: "sess-s1",
      sessionFile: "/tmp/s1.jsonl",
      thinkingLevel: "medium",
      isStreaming: false,
      messageCount: 1,
    });
  });

  it("getCommands 聚合 extension / prompt / skill 三个来源", async () => {
    const h = await open();
    const resp = await h.session.getCommands();
    expect(resp.data).toEqual({
      commands: [
        { name: "memory", description: "扩展命令", source: "extension" },
        { name: "tpl", description: "模板", source: "prompt" },
        { name: "skill:s1", description: "技能", source: "skill" },
      ],
    });
  });

  it("setModel 找不到模型时响亮失败,而不是让 pi 兜底换一个", async () => {
    const h = await open();
    await expect(h.session.setModel("anthropic", "claude-x")).resolves.toMatchObject({ success: true });
    const bad = await h.session.setModel("openai", "gpt-x");
    expect(bad).toMatchObject({ success: false });
    expect(bad.error).toContain("openai/gpt-x");
  });

  it("steer / followUp / abort / compact / stats / lastText 均回 success", async () => {
    const h = await open();
    expect((await h.session.steer("往左")).success).toBe(true);
    expect((await h.session.followUp("再补一句")).success).toBe(true);
    expect((await h.session.abort()).success).toBe(true);
    expect((await h.session.compact("精简点")).data).toMatchObject({ summary: "压缩完成" });
    expect((await h.session.getSessionStats()).data).toMatchObject({ totalMessages: 1 });
    expect((await h.session.getLastAssistantText()).data).toEqual({ text: "最后一句" });
    expect((await h.session.getForkMessages()).data).toEqual({ messages: [{ entryId: "e1", text: "第一条" }] });
  });

  it("fork / switchSession / newSession 换实例后自动重绑事件订阅", async () => {
    const h = await open();
    expect((await h.session.fork("e1")).data).toEqual({ text: "text-of-e1", cancelled: false });
    // 换实例后事件必须来自新会话:向旧会话发事件不应再有产出。
    h.fake.created[0]!.emit({ type: "agent_end", willRetry: false });
    expect(h.events).toHaveLength(0);
    h.fake.created[1]!.emit({ type: "agent_end", willRetry: false });
    expect(h.events.map((e) => e.ev)).toEqual([{ type: "result", willRetry: false }]);

    expect((await h.session.switchSession("/tmp/x.jsonl")).success).toBe(true);
    expect((await h.session.newSession("parent")).success).toBe(true);
  });

  it("setActiveTools 运行时切工具集(旧路径必须重开会话)", async () => {
    const h = await open();
    const resp = await h.session.setActiveTools(["read", "grep", "browser_navigate"]);
    expect(resp.data).toEqual({ applied: ["read", "grep"], missing: ["browser_navigate"] });
    expect(h.fake.created[0]!.state.activeTools).toEqual(["read", "grep"]);
  });

  it("返回值经 JSON 往返净化(否则活对象会在 webContents.send 处炸)", async () => {
    const h = await open();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    h.fake.created[0]!.session.getSessionStats = () => cyclic as never;
    const resp = await h.session.getSessionStats();
    expect(resp.success).toBe(true);
    expect(resp.data).toBeUndefined();
  });
});

// ── 3. 事件流 ────────────────────────────────────────────────────────────────────────

describe("事件流", () => {
  it("AgentSession 事件经 mapPiEvent 归一化并带上当前 runId", async () => {
    const h = await open();
    await h.session.prompt("你好", "run-9");
    h.fake.created[0]!.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "嗨" } });
    expect(h.events.at(-1)).toEqual({ ev: { type: "text", delta: "嗨" }, runId: "run-9" });
  });

  it("stop 之后残余事件被丢弃", async () => {
    const h = await open();
    h.session.stop();
    h.fake.created[0]!.emit({ type: "agent_end", willRetry: false });
    expect(h.events).toHaveLength(0);
  });
});

// ── 4. 异常边界 ──────────────────────────────────────────────────────────────────────

describe("异常边界（进程隔离消失后的四道闸）", () => {
  it("rebind/session_start 前先暴露 respondUi 句柄", async () => {
    const fake = makeMod();
    let createdSession: PiInProcSession | undefined;
    let bindCountAtCallback = -1;
    const session = await openPiInProcSession({
      request: { uiSessionId: "ui-opening", cwd: "/proj" },
      onEvent: () => {},
      onSessionCreated: (created) => {
        createdSession = created as PiInProcSession;
        bindCountAtCallback = fake.created[0]?.state.bindCalls.length ?? -1;
      },
      deps: { loadModule: async () => fake.mod },
    });

    expect(createdSession).toBe(session);
    expect(bindCountAtCallback).toBe(0);
    expect(fake.created[0]?.state.bindCalls).toHaveLength(1);
  });

  it("命令抛错转成 success:false,不冒泡", async () => {
    const h = await open();
    h.fake.created[0]!.session.compact = async () => {
      throw new Error("压缩失败");
    };
    const resp = await h.session.compact();
    expect(resp).toMatchObject({ type: "response", command: "compact", success: false, error: "压缩失败" });
  });

  it("prompt 受理前失败 → success:false(渲染端走既有错误路径)", async () => {
    const h = await open();
    h.fake.created[0]!.state.promptImpl = async (_t, options) => {
      options?.preflightResult?.(false);
      throw new Error("没有配置凭据");
    };
    const resp = await h.session.prompt("hi", "run-1");
    expect(resp).toMatchObject({ success: false, error: "没有配置凭据" });
    // 受理失败不该再补发 error 事件（否则同一次失败在 UI 上出现两次）。
    expect(h.events).toHaveLength(0);
  });

  it("prompt 受理**后**失败 → 补发 error 终态,不留 unhandledRejection(KTD5)", async () => {
    const h = await open();
    h.fake.created[0]!.state.promptImpl = async (_t, options) => {
      options?.preflightResult?.(true);
      throw new Error("response.result is not a function");
    };
    const resp = await h.session.prompt("hi", "run-2");
    expect(resp.success).toBe(true); // ack 已发出，命令本身算受理成功
    await new Promise((r) => setImmediate(r));
    expect(h.events).toEqual([
      { ev: { type: "error", error: "response.result is not a function" }, runId: "run-2" },
    ]);
  });

  it("stop 之后所有命令一律 success:false,且 stop 幂等", async () => {
    const h = await open();
    h.session.stop();
    h.session.stop();
    expect(h.fake.disposed.count).toBe(1);
    expect(await h.session.prompt("hi")).toMatchObject({ success: false });
    expect(await h.session.getState()).toMatchObject({ success: false });
    await expect(h.session.ready()).rejects.toThrow();
  });

  it("stop 解锁挂起的 UI 对话框(否则 pi 的 execute 栈永久留在主进程)", async () => {
    const h = await open();
    const bindings = h.fake.created[0]!.state.bindCalls[0] as {
      uiContext: { confirm(t: string, m: string): Promise<boolean> };
    };
    const pending = bindings.uiContext.confirm("执行确认", "跑 bash?");
    expect(h.uiRequests).toHaveLength(1);
    h.session.stop();
    await expect(pending).resolves.toBe(false);
  });

  it("renderer 回写经 respondUi 结算;stop 之后回写被静默丢弃", async () => {
    const h = await open();
    const bindings = h.fake.created[0]!.state.bindCalls[0] as {
      uiContext: { confirm(t: string, m: string): Promise<boolean> };
    };
    const p = bindings.uiContext.confirm("t", "m");
    h.session.respondUi(h.uiRequests[0]!.id, { confirmed: true });
    await expect(p).resolves.toBe(true);
    h.session.stop();
    expect(() => h.session.respondUi("whatever", { cancelled: true })).not.toThrow();
  });
});

// ── 5. 扩展命令补发收尾 ──────────────────────────────────────────────────────────────

describe("扩展命令补发收尾", () => {
  it("/cmd 有 notify 输出且无 agent 活动 → 立即补发 result + authoritative settled", async () => {
    const h = await open();
    await h.session.loadSlashCommands(); // memory 来源 = extension
    const bindings = h.fake.created[0]!.state.bindCalls[0] as {
      uiContext: { notify(msg: string, type?: string): void };
    };
    h.fake.created[0]!.state.promptImpl = async (_t, options) => {
      bindings.uiContext.notify("索引完成");
      options?.preflightResult?.(true);
    };
    await h.session.prompt("/memory", "run-3");
    expect(h.events.map((e) => e.ev)).toEqual([
      { type: "notify", message: "索引完成", level: "info" },
      { type: "result", willRetry: false },
      { type: "settled" },
    ]);
  });

  it("/cmd 无 notify → 走宽限窗补发 result + settled", async () => {
    vi.useFakeTimers();
    try {
      const h = await open();
      await h.session.loadSlashCommands();
      await h.session.prompt("/memory", "run-4");
      expect(h.events).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_600);
      expect(h.events.map((e) => e.ev)).toEqual([
        { type: "result", willRetry: false },
        { type: "settled" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("命中缓存的 skill / prompt 命令不跟踪(它们会展开成真实 agent 轮次)", async () => {
    vi.useFakeTimers();
    try {
      const h = await open();
      await h.session.loadSlashCommands();
      await h.session.prompt("/tpl 参数", "run-5"); // source = prompt
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("普通 prompt 零影响", async () => {
    vi.useFakeTimers();
    try {
      const h = await open();
      await h.session.prompt("普通消息", "run-6");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("见到 agent 活动即取消补发", async () => {
    vi.useFakeTimers();
    try {
      const h = await open();
      await h.session.loadSlashCommands();
      await h.session.prompt("/unknown-cmd", "run-7"); // 不在缓存里 → 走兜底跟踪
      h.fake.created[0]!.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.events.map((e) => e.ev)).toEqual([{ type: "text", delta: "x" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
