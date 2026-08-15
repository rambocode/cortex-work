import { describe, expect, it, vi } from "vitest";

// ../log 桩:断言 U4 盲区补点(请求超时 / 意外断连)经 scoped logger 落盘;避免加载真 electron-log/main。
const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));

import {
  buildTurnInput,
  CodexWsChannel,
  mapPermissionMode,
  parseAppServerEvent,
  renderCodexSkillFallback,
  type WsLike,
} from "./codex-ws-channel";
import type { CliStreamEvent } from "./types";

// ── FakeWebSocket ───────────────────────────────────────────────────────────
class FakeWs implements WsLike {
  readyState = 1;
  sent: { method: string; id?: number; params?: unknown }[] = [];
  private handlers: Record<string, ((ev: unknown) => void)[]> = {};
  // method → result(自动应答请求,简化握手)
  autoRespond: Record<string, unknown> = {};

  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  private fire(type: string, ev?: unknown) {
    (this.handlers[type] ?? []).forEach((h) => h(ev));
  }
  send(data: string) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (typeof frame.id === "number" && frame.method in this.autoRespond) {
      // 下一 tick 应答,模拟异步
      queueMicrotask(() => this.emit({ id: frame.id, result: this.autoRespond[frame.method] }));
    }
  }
  close() {
    this.readyState = 3;
    this.fire("close", { code: 1000 });
  }
  open() {
    this.fire("open");
  }
  emit(msg: unknown) {
    this.fire("message", { data: JSON.stringify(msg) });
  }
  emitRaw(data: string) {
    this.fire("message", { data });
  }
  triggerError() {
    this.fire("error", {});
  }
  triggerClose(code = 1006) {
    this.readyState = 3;
    this.fire("close", { code });
  }
}

function connectedChannel(over: Partial<Parameters<typeof makeChannel>[0]> = {}) {
  return makeChannel(over);
}

function makeChannel(over: {
  events?: CliStreamEvent[];
  autoRespond?: Record<string, unknown>;
} = {}) {
  const fake = new FakeWs();
  fake.autoRespond = {
    initialize: { userAgent: "x" },
    "thread/start": { thread: { id: "thr_1", sessionId: "thr_1" } },
    "thread/resume": {},
    "turn/start": { turn: { id: "turn_1", status: "inProgress" } },
    "turn/interrupt": {},
    ...(over.autoRespond ?? {}),
  };
  const events: CliStreamEvent[] = over.events ?? [];
  const activity = vi.fn();
  const channel = new CodexWsChannel({
    wsUrl: "ws://127.0.0.1:9/",
    createWebSocket: () => fake,
    onEvent: (e) => events.push(e),
    onActivity: activity,
    requestTimeoutMs: 200,
  });
  return { channel, fake, events, activity };
}

// ── U4:parseAppServerEvent ──────────────────────────────────────────────────
describe("parseAppServerEvent(U4)", () => {
  it("agentMessage/delta → text(phase 未知/final_answer);空 delta → null", () => {
    expect(parseAppServerEvent("item/agentMessage/delta", { delta: "hi" })).toEqual({
      type: "text",
      delta: "hi",
    });
    expect(parseAppServerEvent("item/agentMessage/delta", { delta: "" })).toBeNull();
    // final_answer → text(回复)
    expect(
      parseAppServerEvent("item/agentMessage/delta", { itemId: "m1", delta: "ans" }, { agentMessagePhase: () => "final_answer" }),
    ).toEqual({ type: "text", delta: "ans" });
  });

  it("agentMessage/delta phase=commentary → thinking(右侧过程,不进回复)", () => {
    expect(
      parseAppServerEvent("item/agentMessage/delta", { itemId: "m1", delta: "我先读 skill" }, { agentMessagePhase: () => "commentary" }),
    ).toEqual({ type: "thinking", delta: "我先读 skill" });
  });

  it("reasoning summary/text delta → thinking(右侧过程)", () => {
    expect(parseAppServerEvent("item/reasoning/summaryTextDelta", { delta: "思考中" })).toEqual({
      type: "thinking",
      delta: "思考中",
    });
    expect(parseAppServerEvent("item/reasoning/textDelta", { delta: "raw" })).toEqual({
      type: "thinking",
      delta: "raw",
    });
    expect(parseAppServerEvent("item/reasoning/summaryTextDelta", { delta: "" })).toBeNull();
  });

  it("item/started 各工具类型 → 正确 tool 名 + detail + toolCallId + input", () => {
    expect(
      parseAppServerEvent("item/started", { item: { type: "commandExecution", id: "i1", command: "ls -la" } }),
    ).toEqual({
      type: "tool",
      name: "Shell",
      detail: "ls -la",
      input: { type: "commandExecution", id: "i1", command: "ls -la" },
      phase: "start",
      toolCallId: "i1",
    });
    expect(parseAppServerEvent("item/started", { item: { type: "mcpToolCall", server: "memory" } })).toMatchObject({
      name: "MCP",
      detail: "memory",
    });
    // server+tool 齐全时拼成 mcp__<server>__<tool>,渲染端才能查到中文标签(见 codexMcpToolName)。
    expect(
      parseAppServerEvent("item/started", {
        item: { type: "mcpToolCall", server: "cortex-slides", tool: "set_slides" },
      }),
    ).toMatchObject({ name: "mcp__cortex-slides__set_slides" });
    expect(parseAppServerEvent("item/started", { item: { type: "webSearch", query: "cats" } })).toMatchObject({
      name: "WebSearch",
      detail: "cats",
    });
    expect(parseAppServerEvent("item/started", { item: { type: "fileChange", path: "/a/b.ts" } })).toMatchObject({
      name: "Edit",
      detail: "/a/b.ts",
    });
  });

  it("item/started imageGeneration → tool Image(过程步骤)", () => {
    expect(parseAppServerEvent("item/started", { item: { type: "imageGeneration", id: "g1" } })).toMatchObject({
      type: "tool",
      name: "Image",
      phase: "start",
    });
  });

  it("item/completed imageGeneration(savedPath) → 内联 markdown 图片 text", () => {
    const ev = parseAppServerEvent("item/completed", {
      item: { type: "imageGeneration", id: "g1", savedPath: "/Users/me/.codex/generated_images/a.png", revisedPrompt: "x" },
    });
    expect(ev).toEqual({ type: "text", delta: "\n\n![生成的图片](/Users/me/.codex/generated_images/a.png)\n\n" });
  });

  it("item/completed imageView(path) → 内联 markdown 图片 text", () => {
    expect(parseAppServerEvent("item/completed", { item: { type: "imageView", id: "v1", path: "/tmp/x.png" } })).toEqual({
      type: "text",
      delta: "\n\n![图片](/tmp/x.png)\n\n",
    });
  });

  it("item/completed 非图片非工具类型(agentMessage) → null;工具类型 → tool phase:end", () => {
    expect(parseAppServerEvent("item/completed", { item: { type: "agentMessage", text: "hi" } })).toBeNull();
    // 工具完成帧:带输出与失败标记,toolCallId 与 start 配对。
    expect(
      parseAppServerEvent("item/completed", {
        item: { type: "commandExecution", id: "i1", command: "ls", aggregatedOutput: "a.txt\n", exitCode: 0 },
      }),
    ).toEqual({
      type: "tool",
      name: "Shell",
      detail: "ls",
      // end 帧 input = 完成 item 剔除输出正文(aggregatedOutput 可能极大,已走 output 截断透出)。
      input: { type: "commandExecution", id: "i1", command: "ls", exitCode: 0 },
      phase: "end",
      toolCallId: "i1",
      output: "a.txt\n",
      isError: false,
    });
    expect(
      parseAppServerEvent("item/completed", {
        item: { type: "commandExecution", id: "i2", exitCode: 1, aggregatedOutput: "boom" },
      }),
    ).toMatchObject({ phase: "end", isError: true, output: "boom" });
    expect(
      parseAppServerEvent("item/completed", { item: { type: "fileChange", id: "i3", status: "failed" } }),
    ).toMatchObject({ type: "tool", name: "Edit", phase: "end", isError: true, output: undefined });
  });

  it("item/completed webSearch → end 帧带 detail/input,并合成输出(查询词+去向说明)", () => {
    const ev = parseAppServerEvent("item/completed", {
      item: { type: "webSearch", id: "ws1", query: "AI news 2026-07", action: { type: "search" } },
    }) as { output?: string };
    expect(ev).toMatchObject({
      type: "tool",
      name: "WebSearch",
      phase: "end",
      toolCallId: "ws1",
      detail: "AI news 2026-07",
      // 完成帧 input 带最终查询词,供渲染端覆盖调用行的空 query 快照。
      input: { type: "webSearch", id: "ws1", query: "AI news 2026-07", action: { type: "search" } },
    });
    // OpenAI 不回传搜索结果原文 → 合成输出,不再显示「无输出」。
    expect(ev.output).toContain("查询: AI news 2026-07");
    expect(ev.output).toContain("注入模型上下文");
  });

  it("item/completed webSearch 多路查询(action.queries)+ sources → 输出逐条列出", () => {
    const ev = parseAppServerEvent("item/completed", {
      item: {
        type: "webSearch",
        id: "ws2",
        query: "q1",
        action: { type: "search", query: "q1", queries: ["q1", "q2"], sources: ["https://a.com", { url: "https://b.com" }] },
      },
    }) as { output?: string };
    expect(ev.output).toContain("共 2 路查询:");
    expect(ev.output).toContain("1. q1");
    expect(ev.output).toContain("2. q2");
    expect(ev.output).toContain("- https://a.com");
    expect(ev.output).toContain("- https://b.com");
  });

  it("item/started 非工具类型(reasoning/agentMessage/userMessage) → null", () => {
    expect(parseAppServerEvent("item/started", { item: { type: "reasoning" } })).toBeNull();
    expect(parseAppServerEvent("item/started", { item: { type: "agentMessage" } })).toBeNull();
    expect(parseAppServerEvent("item/started", { item: { type: "userMessage" } })).toBeNull();
  });

  it("tokenUsage 使用 last 回合快照而不是 total 会话累计值", () => {
    expect(
      parseAppServerEvent("thread/tokenUsage/updated", {
        tokenUsage: {
          total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 },
          last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 },
        },
      }),
      // inputTokens 是 12 - 2 = 10:缓存部分是 inputTokens 的子集,归一化时剥离(与 codex.ts 同口径)。
    ).toEqual({ type: "usage", inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 });
    expect(parseAppServerEvent("thread/tokenUsage/updated", { tokenUsage: { total: {}, last: {} } })).toBeNull();
  });

  it("turn/completed status=completed → result ok;failed → result ok:false", () => {
    expect(parseAppServerEvent("turn/completed", { turn: { status: "completed" } })).toEqual({
      type: "result",
      ok: true,
    });
    expect(parseAppServerEvent("turn/completed", { turn: { status: "failed", error: "boom" } })).toEqual({
      type: "result",
      ok: false,
      error: "boom",
    });
  });

  it("error 通知 → result ok:false;未知方法 → null", () => {
    expect(parseAppServerEvent("error", { message: "nope" })).toEqual({
      type: "result",
      ok: false,
      error: "nope",
    });
    expect(parseAppServerEvent("totally/unknown", {})).toBeNull();
  });
});

describe("mapPermissionMode(KTD6)", () => {
  it("plan→read-only/never, accept-edits→workspace-write/never, full-auto/缺省→danger-full-access/never", () => {
    expect(mapPermissionMode("plan")).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
    expect(mapPermissionMode("accept-edits")).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
    expect(mapPermissionMode("full-auto")).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(mapPermissionMode(undefined)).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  it("sandbox(外部沙箱)→ workspace-write/never,与 codex.ts exec 路径一致(不落 danger-full-access)", () => {
    expect(mapPermissionMode("sandbox")).toEqual({ sandbox: "workspace-write", approvalPolicy: "never" });
  });
});

describe("buildTurnInput", () => {
  it("文本包裹 appendSystemPrompt + 追加 localImage", () => {
    const input = buildTurnInput({
      prompt: "hello",
      appendSystemPrompt: "SYS",
      images: [{ path: "/tmp/a.png", mimeType: "image/png" }],
    });
    expect(input[0]).toEqual({
      type: "text",
      text: "SYS\n\n<user_request>\nhello\n</user_request>",
      text_elements: [],
    });
    expect(input[1]).toEqual({ type: "localImage", path: "/tmp/a.png" });
  });
  it("无 appendSystemPrompt 时原样文本", () => {
    expect(buildTurnInput({ prompt: "hi" })[0]).toEqual({ type: "text", text: "hi", text_elements: [] });
  });
  // U4:原生 skill input item(ws 主交互路径显式触发)。
  it("invokedSkill 存在 → 追加 {type:'skill',name,path},文本项不含 prose 改写文案", () => {
    const input = buildTurnInput({ prompt: "打开 x.com", invokedSkill: { name: "agent-browser", path: "/g/ab" } });
    expect(input[0]).toEqual({ type: "text", text: "打开 x.com", text_elements: [] });
    expect(input).toContainEqual({ type: "skill", name: "agent-browser", path: "/g/ab" });
    // 文本项是用户原始 args,不含「请用 Read 工具」之类 prose。
    expect((input[0] as { text: string }).text).not.toContain("SKILL.md");
  });
  it("invokedSkill 与 images 同时存在 → 两者互不影响,input 同时含 localImage 与 skill 项", () => {
    const input = buildTurnInput({
      prompt: "hi",
      images: [{ path: "/tmp/a.png", mimeType: "image/png" }],
      invokedSkill: { name: "deploy", path: "/g/deploy" },
    });
    expect(input).toContainEqual({ type: "localImage", path: "/tmp/a.png" });
    expect(input).toContainEqual({ type: "skill", name: "deploy", path: "/g/deploy" });
  });
  it("invokedSkill 缺省 → input 逐字与改动前一致(仅 text + localImage,向后兼容)", () => {
    const input = buildTurnInput({ prompt: "hi", images: [{ path: "/tmp/a.png", mimeType: "image/png" }] });
    expect(input).toEqual([
      { type: "text", text: "hi", text_elements: [] },
      { type: "localImage", path: "/tmp/a.png" },
    ]);
  });
});

// U4:codex exec(非 ws)回退 prose,须与 core 的 renderSkillInvocation 文案对齐(R3 不倒退)。
describe("renderCodexSkillFallback", () => {
  it("渲染「读 SKILL.md 再执行」定向 prompt,含 name/路径/参数", () => {
    const out = renderCodexSkillFallback({ name: "agent-browser", path: "/g/ab" }, "打开 x.com");
    expect(out).toContain("请使用 skill「agent-browser」完成本次任务。");
    expect(out).toContain("/g/ab/SKILL.md");
    expect(out).toContain("本次参数:打开 x.com");
  });
  it("无参数时不追加「本次参数」行", () => {
    const out = renderCodexSkillFallback({ name: "deploy", path: "/g/deploy" }, "");
    expect(out).not.toContain("本次参数");
  });
  it("name/path 含换行 → 去换行防越界注入", () => {
    const out = renderCodexSkillFallback({ name: "x\n## injected", path: "/g/x\n## bad" }, "arg");
    expect(out).not.toContain("\n## injected");
    expect(out).not.toContain("\n## bad");
  });
});

// ── U3:CodexWsChannel ─────────────────────────────────────────────────────────
describe("CodexWsChannel 握手与会话(U3)", () => {
  it("connect 发 initialize(experimentalApi) + initialized 通知", async () => {
    const { channel, fake } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    const init = fake.sent.find((f) => f.method === "initialize");
    expect((init?.params as { capabilities: { experimentalApi: boolean } }).capabilities.experimentalApi).toBe(
      true,
    );
    expect(fake.sent.some((f) => f.method === "initialized" && f.id === undefined)).toBe(true);
  });

  it("startThread → 返回 threadId,sandbox/approval 正确(init 由 run 发,不在通道)", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    const id = await channel.startThread({ cwd: "/proj", permissionMode: "plan" });
    expect(id).toBe("thr_1");
    expect(channel.threadId).toBe("thr_1");
    expect(events).not.toContainEqual({ type: "init", sessionId: "thr_1" }); // 通道不自发 init
    const ts = fake.sent.find((f) => f.method === "thread/start");
    expect(ts?.params).toMatchObject({ cwd: "/proj", sandbox: "read-only", approvalPolicy: "never" });
  });

  it("startTurn 发 turn/start(input+effort)并返回 turnId", async () => {
    const { channel, fake } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/proj" });
    const turnId = await channel.startTurn({
      input: buildTurnInput({ prompt: "hi" }),
      effort: "medium",
    });
    expect(turnId).toBe("turn_1");
    const t = fake.sent.find((f) => f.method === "turn/start");
    expect(t?.params).toMatchObject({ threadId: "thr_1", effort: "medium" });
  });

  it("resumeThread 发 thread/resume(init 由 run 发)", async () => {
    const { channel, fake } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.resumeThread("thr_old", { permissionMode: "accept-edits" });
    expect(channel.threadId).toBe("thr_old");
    const r = fake.sent.find((f) => f.method === "thread/resume");
    expect(r?.params).toMatchObject({ threadId: "thr_old", sandbox: "workspace-write" });
  });

  it("通知流式映射为归一化事件,onActivity 被调用", async () => {
    const { channel, fake, events, activity } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p" });
    fake.emit({ method: "item/agentMessage/delta", params: { delta: "PO" } });
    fake.emit({ method: "item/agentMessage/delta", params: { delta: "NG" } });
    fake.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", delta: "PO" },
      { type: "text", delta: "NG" },
    ]);
    expect(events.at(-1)).toEqual({ type: "result", ok: true });
    expect(activity).toHaveBeenCalled();
  });

  it("每 turn 仅放行一个终态 result(error + turn/completed 不双发)", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p" });
    fake.emit({ method: "error", params: { message: "x" } });
    fake.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
    expect(events.filter((e) => e.type === "result")).toEqual([{ type: "result", ok: false, error: "x" }]);
  });

  it("请求超时 → reject", async () => {
    const { channel, fake } = connectedChannel();
    fake.autoRespond = {}; // 清空自动应答 → initialize 不被回复
    const p = channel.connect();
    fake.open();
    // initialize 不应答 → 200ms 后 request 超时 → connect reject
    await expect(p).rejects.toThrow(/超时|握手|连接/);
  });

  it("close 后丢弃后续通知 + pending 被 reject", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p" });
    channel.close();
    fake.emit({ method: "item/agentMessage/delta", params: { delta: "late" } });
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  it("ws 异常关闭 → onClose(expected:false)", async () => {
    const onClose = vi.fn();
    const fake = new FakeWs();
    fake.autoRespond = { initialize: {} };
    const channel = new CodexWsChannel({
      wsUrl: "ws://x/",
      createWebSocket: () => fake,
      onEvent: () => {},
      onClose,
    });
    const p = channel.connect();
    fake.open();
    await p;
    fake.triggerClose(1006);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 1006, expected: false }));
  });

  it("startTurn 默认开启 reasoning summary(summary=auto)", async () => {
    const { channel, fake } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p" });
    await channel.startTurn({ input: buildTurnInput({ prompt: "hi" }) });
    const t = fake.sent.find((f) => f.method === "turn/start");
    expect((t?.params as { summary: string }).summary).toBe("auto");
  });

  it("commentary 归 thinking、final_answer 归 text(按 item/started 的 phase 分流)", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p" });
    await channel.startTurn({ input: buildTurnInput({ prompt: "hi" }) });
    // commentary 消息
    fake.emit({ method: "item/started", params: { item: { type: "agentMessage", id: "m1", phase: "commentary" } } });
    fake.emit({ method: "item/agentMessage/delta", params: { itemId: "m1", delta: "我先读 skill" } });
    // final_answer 消息
    fake.emit({ method: "item/started", params: { item: { type: "agentMessage", id: "m2", phase: "final_answer" } } });
    fake.emit({ method: "item/agentMessage/delta", params: { itemId: "m2", delta: "答案" } });
    expect(events).toContainEqual({ type: "thinking", delta: "我先读 skill" });
    expect(events).toContainEqual({ type: "text", delta: "答案" });
  });

  it("端到端:富 turn 通知序列 → 过程(thinking/tool)与回复(text)分流(U8)", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p", permissionMode: "full-auto" });
    await channel.startTurn({ input: buildTurnInput({ prompt: "build it" }) });
    // 回放实测 0.142.2 富 turn:推理 → commentary → 工具 → final_answer → usage → 完成。
    fake.emit({ method: "item/reasoning/summaryTextDelta", params: { delta: "分析需求" } }); // → thinking
    fake.emit({ method: "item/started", params: { item: { type: "agentMessage", id: "c", phase: "commentary" } } });
    fake.emit({ method: "item/agentMessage/delta", params: { itemId: "c", delta: "我先看看目录" } }); // commentary → thinking
    fake.emit({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "ls" } } }); // → tool
    fake.emit({ method: "item/started", params: { item: { type: "agentMessage", id: "f", phase: "final_answer" } } });
    fake.emit({ method: "item/agentMessage/delta", params: { itemId: "f", delta: "这是答案" } }); // final → text
    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { inputTokens: 38, outputTokens: 11, cachedInputTokens: 3 },
          last: { inputTokens: 8, outputTokens: 2, cachedInputTokens: 0 },
        },
      },
    });
    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { inputTokens: 40, outputTokens: 12, cachedInputTokens: 4 },
          last: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 1 },
        },
      },
    });
    fake.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
    // 过程(thinking + tool)与回复(text)分流;通道不自发 init(由 run 发,本测试直接驱动通道故无 init)。
    expect(events).toEqual([
      { type: "thinking", delta: "分析需求" },
      { type: "thinking", delta: "我先看看目录" },
      {
        type: "tool",
        name: "Shell",
        detail: "ls",
        input: { type: "commandExecution", id: "c1", command: "ls" },
        phase: "start",
        toolCallId: "c1",
      },
      { type: "text", delta: "这是答案" },
      // last.inputTokens 10 - cached 1 = 9（缓存部分已剥离，与 codex.ts 同口径）。
      { type: "usage", inputTokens: 9, outputTokens: 3, cachedInputTokens: 1 },
      { type: "result", ok: true },
    ]);
  });

  it("interrupt 发 turn/interrupt(带 threadId+turnId)", async () => {
    const { channel, fake } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p" });
    await channel.startTurn({ input: buildTurnInput({ prompt: "hi" }) });
    await channel.interrupt();
    const i = fake.sent.find((f) => f.method === "turn/interrupt");
    expect(i?.params).toEqual({ threadId: "thr_1", turnId: "turn_1" });
  });
});

describe("U4 盲区补点落盘", () => {
  // thread/resume 故意不放进 autoRespond → 触发请求超时;requestTimeoutMs 调短便于断言。
  function makeForLog() {
    const fake = new FakeWs();
    fake.autoRespond = { initialize: { userAgent: "x" }, "thread/start": { thread: { id: "thr_1" } } };
    const channel = new CodexWsChannel({
      wsUrl: "ws://127.0.0.1:9/",
      createWebSocket: () => fake,
      onEvent: () => {},
      requestTimeoutMs: 50,
    });
    return { channel, fake };
  }

  it("请求超时 → 记一条 warn(含 method 与阈值)", async () => {
    logMocks.logger.warn.mockReset();
    const { channel, fake } = makeForLog();
    const p = channel.connect();
    fake.open();
    await p;
    await expect(channel.resumeThread("thr_x", {})).rejects.toThrow(/请求超时/);
    expect(logMocks.logger.warn).toHaveBeenCalledWith("codex ws 请求超时", { method: "thread/resume", timeoutMs: 50 });
  });

  it("意外断连(非主动 stop)→ 记一条 warn(含 code)", async () => {
    logMocks.logger.warn.mockReset();
    const { channel, fake } = makeForLog();
    const p = channel.connect();
    fake.open();
    await p;
    fake.triggerClose(1006);
    expect(logMocks.logger.warn).toHaveBeenCalledWith(
      "codex ws 意外断连",
      expect.objectContaining({ code: 1006 }),
    );
  });

  it("主动 close 不记意外断连(expected 不噪声)", async () => {
    logMocks.logger.warn.mockReset();
    const { channel, fake } = makeForLog();
    const p = channel.connect();
    fake.open();
    await p;
    channel.close(); // 置 stopped=true 后 ws.close → close 事件 expected
    expect(logMocks.logger.warn).not.toHaveBeenCalledWith("codex ws 意外断连", expect.anything());
  });
});
