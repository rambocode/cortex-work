import { describe, expect, it, vi } from "vitest";
import {
  buildTurnInput,
  CodexWsChannel,
  mapPermissionMode,
  parseAppServerEvent,
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
  it("agentMessage/delta → text(空 delta → null)", () => {
    expect(parseAppServerEvent("item/agentMessage/delta", { delta: "hi" })).toEqual({
      type: "text",
      delta: "hi",
    });
    expect(parseAppServerEvent("item/agentMessage/delta", { delta: "" })).toBeNull();
  });

  it("item/started 各工具类型 → 正确 tool 名 + detail + toolCallId", () => {
    expect(
      parseAppServerEvent("item/started", { item: { type: "commandExecution", id: "i1", command: "ls -la" } }),
    ).toEqual({ type: "tool", name: "Shell", detail: "ls -la", phase: "start", toolCallId: "i1" });
    expect(parseAppServerEvent("item/started", { item: { type: "mcpToolCall", server: "memory" } })).toMatchObject({
      name: "MCP",
      detail: "memory",
    });
    expect(parseAppServerEvent("item/started", { item: { type: "webSearch", query: "cats" } })).toMatchObject({
      name: "WebSearch",
      detail: "cats",
    });
    expect(parseAppServerEvent("item/started", { item: { type: "fileChange", path: "/a/b.ts" } })).toMatchObject({
      name: "Edit",
      detail: "/a/b.ts",
    });
  });

  it("item/started 非工具类型(reasoning/agentMessage/userMessage) → null", () => {
    expect(parseAppServerEvent("item/started", { item: { type: "reasoning" } })).toBeNull();
    expect(parseAppServerEvent("item/started", { item: { type: "agentMessage" } })).toBeNull();
    expect(parseAppServerEvent("item/started", { item: { type: "userMessage" } })).toBeNull();
  });

  it("tokenUsage 嵌套 total → usage(缺失 → null)", () => {
    expect(
      parseAppServerEvent("thread/tokenUsage/updated", {
        tokenUsage: { total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 } },
      }),
    ).toEqual({ type: "usage", inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 });
    expect(parseAppServerEvent("thread/tokenUsage/updated", { tokenUsage: { total: {} } })).toBeNull();
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

  it("startThread → threadId,产出 init 事件,sandbox/approval 正确", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    const id = await channel.startThread({ cwd: "/proj", permissionMode: "plan" });
    expect(id).toBe("thr_1");
    expect(channel.threadId).toBe("thr_1");
    expect(events).toContainEqual({ type: "init", sessionId: "thr_1" });
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

  it("resumeThread 发 thread/resume 并产出 init", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.resumeThread("thr_old", { permissionMode: "accept-edits" });
    expect(channel.threadId).toBe("thr_old");
    expect(events).toContainEqual({ type: "init", sessionId: "thr_old" });
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

  it("端到端:完整 turn 通知序列 → 与 codex exec 契约等价的归一化事件流(U8)", async () => {
    const { channel, fake, events } = connectedChannel();
    const p = channel.connect();
    fake.open();
    await p;
    await channel.startThread({ cwd: "/p", permissionMode: "full-auto" }); // → init
    await channel.startTurn({ input: buildTurnInput({ prompt: "build it" }) });
    // 回放实测 0.142.2 的一轮 turn 通知序列(含工具/推理/文本/usage/完成)。
    fake.emit({ method: "thread/started", params: {} }); // 通道已自产 init,此通知映射为 null
    fake.emit({ method: "turn/started", params: {} });
    fake.emit({ method: "item/started", params: { item: { type: "reasoning" } } }); // 非工具 → null
    fake.emit({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "npm i" } } });
    fake.emit({ method: "item/agentMessage/delta", params: { delta: "Done" } });
    fake.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "Done", phase: "final_answer" } } }); // item/completed 不单独映射 → null
    fake.emit({
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { total: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 1 } } },
    });
    fake.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
    // 归一化事件顺序:init(自产) → tool(Shell) → text → usage → result。与 codex exec parseLine 产物同构。
    expect(events).toEqual([
      { type: "init", sessionId: "thr_1" },
      { type: "tool", name: "Shell", detail: "npm i", phase: "start", toolCallId: "c1" },
      { type: "text", delta: "Done" },
      { type: "usage", inputTokens: 10, outputTokens: 3, cachedInputTokens: 1 },
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
