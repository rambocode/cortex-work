// pi-host 协议层单测。
//
// **不真起进程**：传输用内存替身（`write` 收集出站行），会话与能力组装用注入的替身。
// 这样每条断言都直接对着协议消息本身，与 `utilityProcess` 的可用性无关。
//
// 覆盖重点按「出问题时最难查」排序：
//   · call 转发的完整性（漏一个方法 = 某个命令静默失效）
//   · 反向请求的关联与超时（丢一次应答 = pi 永久挂起）
//   · 异常边界（任何抛出都必须变成 reply{ok:false}，绝不让 worker 崩掉）

import type { CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { ENGINE_METHODS, type HostMessage, type WorkerMessage } from "../../main/agents/pi-gateway/protocol";
import type { PiInProcOpenOptions, PiSessionEngine } from "../../main/agents/pi-inproc";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest } from "../../main/ipc/types";
import { PiHost } from "./host";

/** 一个可观测的假会话。所有方法回同一个 ok 应答，便于断言转发路径。 */
function createFakeSession(): PiSessionEngine & {
  calls: Array<{ method: string; args: unknown[] }>;
  stopped: boolean;
  responded: Array<{ id: string; payload: unknown }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const responded: Array<{ id: string; payload: unknown }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ type: "response" as const, command: method, success: true, data: { method } });
    };

  const flags = { stopped: false };
  const session = {
    ready: (...args: unknown[]) => {
      calls.push({ method: "ready", args });
      return Promise.resolve({ sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
    },
    loadSlashCommands: (...args: unknown[]) => {
      calls.push({ method: "loadSlashCommands", args });
      return Promise.resolve();
    },
    prompt: record("prompt"),
    steer: record("steer"),
    followUp: record("followUp"),
    abort: record("abort"),
    fork: record("fork"),
    getForkMessages: record("getForkMessages"),
    setModel: record("setModel"),
    setThinkingLevel: record("setThinkingLevel"),
    compact: record("compact"),
    getState: record("getState"),
    getSessionStats: record("getSessionStats"),
    newSession: record("newSession"),
    switchSession: record("switchSession"),
    getLastAssistantText: record("getLastAssistantText"),
    getCommands: record("getCommands"),
    respondUi: (id: string, payload: unknown) => {
      responded.push({ id, payload });
    },
    stop: () => {
      flags.stopped = true;
    },
  } as unknown as PiSessionEngine;

  // 用 defineProperty 而不是 Object.assign：后者会把 getter **求值一次**再拷过去，
  // `stopped` 就永远停在 false（踩过一次）。
  return Object.defineProperty(Object.assign(session as never, { calls, responded }), "stopped", {
    get: () => flags.stopped,
  }) as PiSessionEngine & {
    calls: Array<{ method: string; args: unknown[] }>;
    stopped: boolean;
    responded: Array<{ id: string; payload: unknown }>;
  };
}

interface Harness {
  host: PiHost;
  sent: WorkerMessage[];
  session: ReturnType<typeof createFakeSession>;
  opened: PiInProcOpenOptions[];
  exits: number[];
  send: (msg: HostMessage) => void;
}

const BASE_REQUEST: PiOpenRequest = { uiSessionId: "ui-1", cwd: "/tmp" };

function makeHarness(options: { hasUiOutlet?: boolean; openFails?: string } = {}): Harness {
  const sent: WorkerMessage[] = [];
  const session = createFakeSession();
  const opened: PiInProcOpenOptions[] = [];
  const exits: number[] = [];

  const host = new PiHost({
    write: (line) => sent.push(JSON.parse(line) as WorkerMessage),
    exit: (code) => exits.push(code),
    shutdownGraceMs: 0,
    buildDeps: async () => ({}),
    openSession: async (opts) => {
      opened.push(opts);
      if (options.openFails) throw new Error(options.openFails);
      return session;
    },
  });

  return {
    host,
    sent,
    session,
    opened,
    exits,
    send: (msg) => host.handleLine(JSON.stringify(msg)),
  };
}

/** 开一个会话并清空出站缓冲，让后续断言只看待测那一段。 */
async function openSession(h: Harness, hasUiOutlet = true): Promise<void> {
  h.send({ id: "o1", kind: "open", request: BASE_REQUEST, hasUiOutlet });
  await vi.waitFor(() => expect(h.sent.some((m) => m.kind === "reply")).toBe(true));
  h.sent.length = 0;
}

describe("PiHost · open", () => {
  it("组装能力并建会话，回 reply{ok:true}", async () => {
    const h = makeHarness();
    h.send({ id: "o1", kind: "open", request: BASE_REQUEST, hasUiOutlet: true });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ id: "o1", kind: "reply", ok: true });
    // 协议做过一次 JSON 往返，故比值不比引用。
    expect(h.opened[0]?.request).toEqual(BASE_REQUEST);
  });

  it("hasUiOutlet=true 时接线 onUiRequest；false 时不接（无 UI 出口的语义在引擎层生效）", async () => {
    const withUi = makeHarness();
    await openSession(withUi, true);
    expect(withUi.opened[0]?.onUiRequest).toBeTypeOf("function");

    const withoutUi = makeHarness();
    await openSession(withoutUi, false);
    expect(withoutUi.opened[0]?.onUiRequest).toBeUndefined();
  });

  it("建会话失败时响亮回错（主进程据此把 pi:open 转成 rejection）", async () => {
    const h = makeHarness({ openFails: "供应商未配置" });
    h.send({ id: "o1", kind: "open", request: BASE_REQUEST, hasUiOutlet: true });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ id: "o1", kind: "reply", ok: false, error: "供应商未配置" });
  });

  it("建会话失败时释放已组装的外部资源（stop() 走不到，MCP 子进程会挂着）", async () => {
    const dispose = vi.fn(async () => {});
    const sent: WorkerMessage[] = [];
    const host = new PiHost({
      write: (line) => sent.push(JSON.parse(line) as WorkerMessage),
      exit: () => {},
      buildDeps: async () => ({ onDispose: dispose }),
      openSession: async () => {
        throw new Error("ready 超时");
      },
    });
    host.handleLine(JSON.stringify({ id: "o1", kind: "open", request: BASE_REQUEST, hasUiOutlet: true }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("重复 open 直接失败，绝不悄悄建第二个会话", async () => {
    const h = makeHarness();
    await openSession(h);
    h.send({ id: "o2", kind: "open", request: BASE_REQUEST, hasUiOutlet: true });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ ok: false });
    expect(h.opened).toHaveLength(1);
  });
});

describe("PiHost · call 转发", () => {
  it("ENGINE_METHODS 里的每个方法都能转发到会话上（漏一个 = 该命令静默失效）", async () => {
    const h = makeHarness();
    await openSession(h);

    for (const [index, method] of ENGINE_METHODS.entries()) {
      h.send({ id: `c${index}`, kind: "call", method, args: [] });
    }
    await vi.waitFor(() => expect(h.sent).toHaveLength(ENGINE_METHODS.length));
    expect(h.sent.every((m) => m.kind === "reply" && m.ok)).toBe(true);
    expect(h.session.calls.map((c) => c.method)).toEqual([...ENGINE_METHODS]);
  });

  it("按签名顺序原样透传参数", async () => {
    const h = makeHarness();
    await openSession(h);
    h.send({ id: "c1", kind: "call", method: "prompt", args: ["你好", "run-7", [{ type: "image" }]] });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.session.calls[0]).toEqual({ method: "prompt", args: ["你好", "run-7", [{ type: "image" }]] });
  });

  it("JSON 往返造成的 null 还原成 undefined（跨进程契约，走错分支会让事件被渲染端丢弃）", async () => {
    const h = makeHarness();
    await openSession(h);
    // 客户端裁掉尾部 undefined，但夹在中间的可选参只能是 null。
    h.send({ id: "c1", kind: "call", method: "prompt", args: ["你好", null, [{ type: "image" }]] });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.session.calls[0]?.args).toEqual(["你好", undefined, [{ type: "image" }]]);
  });

  it("命令级失败随 ok:true 回去（ok:false 只留给转发层失败）", async () => {
    const h = makeHarness();
    await openSession(h);
    (h.session as unknown as { compact: () => Promise<unknown> }).compact = () =>
      Promise.resolve({ type: "response", command: "compact", success: false, error: "压缩失败" });
    h.send({ id: "c1", kind: "call", method: "compact", args: [] });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({
      ok: true,
      result: { success: false, error: "压缩失败" },
    });
  });

  it("会话方法抛错 → reply{ok:false}，不冒泡", async () => {
    const h = makeHarness();
    await openSession(h);
    (h.session as unknown as { abort: () => Promise<never> }).abort = () => Promise.reject(new Error("炸了"));
    h.send({ id: "c1", kind: "call", method: "abort", args: [] });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ id: "c1", kind: "reply", ok: false, error: "炸了" });
  });

  it("会话未建立时 call 立即失败", async () => {
    const h = makeHarness();
    h.send({ id: "c1", kind: "call", method: "getState", args: [] });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ ok: false, error: "pi 会话尚未建立" });
  });

  it("契约外的方法名被挡下（不去会话对象上乱找同名成员）", async () => {
    const h = makeHarness();
    await openSession(h);
    h.send({ id: "c1", kind: "call", method: "stop" as never, args: [] });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ ok: false });
    expect(h.session.stopped).toBe(false);
  });
});

describe("PiHost · 事件与 UI 反向请求", () => {
  it("会话事件转成 WorkerEvent，runId 存在才带", async () => {
    const h = makeHarness();
    await openSession(h);
    const onEvent = h.opened[0]!.onEvent;
    const text: PiSessionEvent = { type: "text", delta: "嗨" };
    onEvent(text, "run-1");
    onEvent({ type: "settled" });
    expect(h.sent).toEqual([
      { kind: "event", event: text, runId: "run-1" },
      { kind: "event", event: { type: "settled" } },
    ]);
  });

  it("UI 请求用 PiUiRequest.id 作为 requestId；应答回落到 respondUi", async () => {
    const h = makeHarness();
    await openSession(h);
    const request: PiUiRequest = {
      type: "extension_ui_request",
      id: "u-42",
      method: "confirm",
      title: "允许执行工具 bash?",
      message: "{}",
    };
    h.opened[0]!.onUiRequest?.(request);
    expect(h.sent[0]).toEqual({ kind: "uiRequest", requestId: "u-42", request });

    h.send({ id: "r1", kind: "uiResponse", requestId: "u-42", payload: { confirmed: true } });
    expect(h.session.responded).toEqual([{ id: "u-42", payload: { confirmed: true } }]);
  });
});

describe("PiHost · 凭据反向请求（KTD1）", () => {
  /** 建一个 host 并截下 ctx 上的 CredentialStore —— 它就是 RPC 通道的驱动入口。 */
  async function openWithCredentials(): Promise<{
    sent: WorkerMessage[];
    credentials: CredentialStore;
    send: (msg: HostMessage) => void;
  }> {
    const sent: WorkerMessage[] = [];
    let credentials: CredentialStore | null = null;
    const host = new PiHost({
      write: (line) => sent.push(JSON.parse(line) as WorkerMessage),
      // 必须给 exit 替身：缺省实现会真调 process.exit，vitest 会把它记成 unhandled rejection。
      exit: () => {},
      shutdownGraceMs: 0,
      buildDeps: async (_req, ctx) => {
        credentials = ctx.credentials;
        return {};
      },
      openSession: async () => createFakeSession(),
    });
    host.handleLine(JSON.stringify({ id: "o1", kind: "open", request: BASE_REQUEST, hasUiOutlet: true }));
    await vi.waitFor(() => expect(sent.some((m) => m.kind === "reply")).toBe(true));
    sent.length = 0;
    return { sent, credentials: credentials!, send: (msg) => host.handleLine(JSON.stringify(msg)) };
  }

  it("read 发出 credentialRequest，应答按 requestId 关联并反序列化成 Credential", async () => {
    const { sent, credentials, send } = await openWithCredentials();
    const pending = credentials.read("anthropic");

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { kind: string; requestId: string; key: string };
    expect(req.kind).toBe("credentialRequest");
    expect(req.key).toBe("provider:anthropic");

    send({
      id: "x",
      kind: "credentialResponse",
      requestId: req.requestId,
      value: JSON.stringify({ type: "api_key", key: "sk-test" }),
    });
    await expect(pending).resolves.toEqual({ type: "api_key", key: "sk-test" });
  });

  it("value=null（未配置）解析为 undefined，绝不当成空串凭据", async () => {
    const { sent, credentials, send } = await openWithCredentials();
    const pending = credentials.read("openai");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    send({ id: "x", kind: "credentialResponse", requestId: (sent[0] as { requestId: string }).requestId, value: null });
    await expect(pending).resolves.toBeUndefined();
  });

  it("主进程回了 error → 按未配置处理（不把错误冒泡进 pi 的 getAuth）", async () => {
    const { sent, credentials, send } = await openWithCredentials();
    const pending = credentials.read("openai");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    send({
      id: "x",
      kind: "credentialResponse",
      requestId: (sent[0] as { requestId: string }).requestId,
      value: null,
      error: "金库已锁",
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it("迟到/无主的凭据应答被丢弃，不抛也不产生出站消息", async () => {
    const { sent, send } = await openWithCredentials();
    send({ id: "x", kind: "credentialResponse", requestId: "cred-999", value: "{}" });
    expect(sent).toEqual([]);
  });

  it("shutdown 时解掉全部在途凭据请求（否则 pi 侧永久挂起）", async () => {
    const { sent, credentials, send } = await openWithCredentials();
    const pending = credentials.read("anthropic");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    send({ id: "s1", kind: "shutdown" });
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("PiHost · shutdown 与容错", () => {
  it("shutdown：停会话 → 立刻回 reply → 等清理跑完再退出", async () => {
    const h = makeHarness();
    await openSession(h);
    h.send({ id: "s1", kind: "shutdown" });
    // reply 必须是同步发出的：主进程的两段式 kill 靠它确认 worker 收到了。
    expect(h.session.stopped).toBe(true);
    expect(h.sent).toEqual([{ id: "s1", kind: "reply", ok: true }]);
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
  });

  it("等 MCP 等外部资源释放完成后才退出（主进程 3s 后会 SIGKILL，清理必须赶在前面）", async () => {
    let released = false;
    let releaseNow: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseNow = () => {
        released = true;
        resolve();
      };
    });
    const sent: WorkerMessage[] = [];
    const exits: number[] = [];
    const session = createFakeSession();
    let deps: { onDispose?: () => Promise<void> | void } = {};
    const host = new PiHost({
      write: (line) => sent.push(JSON.parse(line) as WorkerMessage),
      exit: (code) => exits.push(code),
      buildDeps: async () => ({ onDispose: () => gate }),
      openSession: async (opts) => {
        deps = opts.deps ?? {};
        return session;
      },
    });
    host.handleLine(JSON.stringify({ id: "o1", kind: "open", request: BASE_REQUEST, hasUiOutlet: true }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // `PiInProcSession.stop()` 会调 onDispose；假会话不会，故在这里代它调一次，
    // 断言的是 host 对「释放完成信号」的等待，而不是引擎内部的调用时机。
    void deps.onDispose?.();
    host.handleLine(JSON.stringify({ id: "s1", kind: "shutdown" }));
    await Promise.resolve();
    expect(exits).toEqual([]);
    expect(released).toBe(false);

    releaseNow();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it("重复 shutdown 幂等（仍回 reply，不重复停会话）", async () => {
    const h = makeHarness();
    await openSession(h);
    h.send({ id: "s1", kind: "shutdown" });
    h.sent.length = 0;
    h.send({ id: "s2", kind: "shutdown" });
    expect(h.sent).toEqual([{ id: "s2", kind: "reply", ok: true }]);
  });

  it("非法 JSON 行只跳过，不抛也不中断通道", async () => {
    const h = makeHarness();
    expect(() => h.host.handleLine("{ 这不是 JSON")).not.toThrow();
    await openSession(h);
    h.send({ id: "c1", kind: "call", method: "getState", args: [] });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ ok: true });
  });

  it("未知消息类型只跳过（对端比本 worker 新时不至于中断通道）", () => {
    const h = makeHarness();
    expect(() => h.host.handleLine(JSON.stringify({ kind: "从未来来的消息" }))).not.toThrow();
    expect(h.sent).toEqual([]);
  });
});
