// pi-session.ts 单测:pi:* IPC 注册表 / 命令转发 / 事件回推 / 生命周期。
// electron(ipcMain)、pi-rpc(spawn+会话)、pi-providers、cli(spawnEnvFor) 全 mock,
// 纯逻辑校验:不真的 spawn 子进程。

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { PiOpenRequest, PiOpenResult } from "./types";

// 共享 mock 状态(被 vi.mock 工厂引用,必须经 vi.hoisted 提前求值)。
const h = vi.hoisted(() => {
  const makeSession = () => ({
    ready: vi.fn().mockResolvedValue({ sessionId: "sess-x" }),
    prompt: vi.fn().mockResolvedValue({ success: true, data: { accepted: true } }),
    steer: vi.fn().mockResolvedValue({ success: true }),
    followUp: vi.fn().mockResolvedValue({ success: true }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    fork: vi.fn().mockResolvedValue({ success: true, data: { forked: true } }),
    getForkMessages: vi.fn().mockResolvedValue({ success: true, data: { messages: [] } }),
    setModel: vi.fn().mockResolvedValue({ success: true }),
    setThinkingLevel: vi.fn().mockResolvedValue({ success: true }),
    compact: vi.fn().mockResolvedValue({ success: true }),
    getState: vi.fn().mockResolvedValue({ success: true, data: { sessionId: "sess-x" } }),
    getSessionStats: vi.fn().mockResolvedValue({ success: true, data: { messageCount: 3 } }),
    stop: vi.fn(),
    onEvent: (_ev: unknown) => {}, // 构造时由 PiRpcSession mock 覆盖为真实回调（按实例存,支持多会话路由验证）
  });
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const onEventRef: { current: ((ev: unknown) => void) | null } = { current: null };
  const instances: ReturnType<typeof makeSession>[] = [];
  // 必须用普通 function(可 new),箭头函数不可作构造器。
  const PiRpcSession = vi.fn(function (_transport: unknown, onEvent: (ev: unknown) => void) {
    onEventRef.current = onEvent; // 末个会话的回调（单会话用例用）
    const inst = makeSession();
    inst.onEvent = onEvent; // 按实例存,多会话路由用例据此分别 fire
    instances.push(inst);
    return inst;
  });
  return {
    handlers,
    onEventRef,
    instances,
    makeSession,
    PiRpcSession,
    buildRpcArgs: vi.fn(() => ["--mode", "rpc"]),
    spawnPiRpc: vi.fn(() => ({})),
    writePiExtension: vi.fn(() => "/ext/deepseek.js"),
    spawnEnvFor: vi.fn(() => ({})),
  };
});

vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
}));
vi.mock("../agents/pi-rpc", () => ({
  buildRpcArgs: h.buildRpcArgs,
  spawnPiRpc: h.spawnPiRpc,
  PiRpcSession: h.PiRpcSession,
}));
vi.mock("../agents/pi-providers", () => ({ writePiExtension: h.writePiExtension }));
vi.mock("./cli", () => ({ spawnEnvFor: h.spawnEnvFor }));

import { registerPiSessionHandlers, killAllPiSessions, piSessionCount } from "./pi-session";

// renderer 替身:可控的 isDestroyed + 记录 send。
function fakeEvent() {
  return { sender: { isDestroyed: vi.fn(() => false), send: vi.fn() } };
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
  h.onEventRef.current = null;
  h.PiRpcSession.mockClear();
  h.buildRpcArgs.mockClear();
  h.spawnPiRpc.mockClear();
  h.writePiExtension.mockClear();
  h.spawnEnvFor.mockClear();
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

describe("pi:open", () => {
  it("无 provider:不生成 extension,buildRpcArgs+spawn+构造会话,就绪后回 sessionId,注册表 +1", async () => {
    const { result } = await open();
    expect(h.writePiExtension).not.toHaveBeenCalled();
    expect(h.buildRpcArgs).toHaveBeenCalledWith(expect.objectContaining({ uiSessionId: "u1", cwd: "/proj" }));
    expect(h.spawnPiRpc).toHaveBeenCalledTimes(1);
    expect(h.instances[0].ready).toHaveBeenCalled();
    expect(result).toEqual({ uiSessionId: "u1", sessionId: "sess-x" });
    expect(piSessionCount()).toBe(1);
  });

  it("有 provider:生成 extension + 回填 piExtensionPath + spawnEnvFor 收到 provider", async () => {
    const provider = { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x", models: [] };
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/proj", provider };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.writePiExtension).toHaveBeenCalledWith(provider);
    expect(req.piExtensionPath).toBe("/ext/deepseek.js"); // 被回填供 buildRpcArgs 读取
    expect(h.spawnEnvFor).toHaveBeenCalledWith({ agent: "pi", provider });
  });

  it("ready 失败 → stop 子进程 + 不留注册表条目 + 抛错", async () => {
    const bad = { ...h.makeSession(), ready: vi.fn().mockRejectedValue(new Error("pi 会话就绪超时")) };
    h.PiRpcSession.mockImplementationOnce(function (_t: unknown, onEvent: (ev: unknown) => void) {
      h.onEventRef.current = onEvent;
      h.instances.push(bad);
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
});

describe("命令转发", () => {
  it("pi:prompt 转发到 session.prompt 并回 data", async () => {
    await open();
    const data = await h.handlers.get("pi:prompt")!({}, "u1", "你好");
    expect(h.instances[0].prompt).toHaveBeenCalledWith("你好");
    expect(data).toEqual({ accepted: true });
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

  it("底层方法 reject（进程中途崩溃/超时）→ IPC handler 原样 rejection 传播给调用方", async () => {
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

  it("pi:close → stop 子进程 + 摘除注册表", async () => {
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
