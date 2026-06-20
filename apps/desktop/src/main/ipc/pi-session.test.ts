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
    switchSession: vi.fn().mockResolvedValue({ success: true, data: { cancelled: false } }),
    getState: vi.fn().mockResolvedValue({ success: true, data: { sessionId: "sess-x" } }),
    getSessionStats: vi.fn().mockResolvedValue({ success: true, data: { messageCount: 3 } }),
    stop: vi.fn(),
    respondUi: vi.fn(),
    onEvent: (_ev: unknown) => {}, // 构造时由 PiRpcSession mock 覆盖为真实回调（按实例存,支持多会话路由验证）
    onUiRequest: (_req: unknown) => {}, // 同上,UI 请求路由用例据此 fire
  });
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const onEventRef: { current: ((ev: unknown) => void) | null } = { current: null };
  const instances: ReturnType<typeof makeSession>[] = [];
  // 必须用普通 function(可 new),箭头函数不可作构造器。
  const PiRpcSession = vi.fn(function (
    _transport: unknown,
    onEvent: (ev: unknown) => void,
    onUiRequest?: (req: unknown) => void,
  ) {
    onEventRef.current = onEvent; // 末个会话的回调（单会话用例用）
    const inst = makeSession();
    inst.onEvent = onEvent; // 按实例存,多会话路由用例据此分别 fire
    if (onUiRequest) inst.onUiRequest = onUiRequest;
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
    writeApprovalExtension: vi.fn(() => "/ext/approval.js"),
    writeCustomToolExtension: vi.fn(() => "/ext/sample-tools.js"),
    writeSlashCommandExtension: vi.fn(() => "/ext/sample-commands.js"),
    writeAskQuestionExtension: vi.fn(() => "/ext/askquestion.js"),
    assertSpawnCwd: vi.fn(),
    spawnEnvFor: vi.fn(() => ({})),
    readImageBytes: vi.fn(async () => ({ mimeType: "image/png", base64: "AAAA" })),
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
vi.mock("../agents/pi-extensions", () => ({
  writeApprovalExtension: h.writeApprovalExtension,
  writeCustomToolExtension: h.writeCustomToolExtension,
  writeSlashCommandExtension: h.writeSlashCommandExtension,
  writeAskQuestionExtension: h.writeAskQuestionExtension,
}));
vi.mock("./cli", () => ({ assertSpawnCwd: h.assertSpawnCwd, spawnEnvFor: h.spawnEnvFor }));
vi.mock("./image", () => ({ readImageBytes: h.readImageBytes }));

import { registerPiSessionHandlers, killAllPiSessions, piSessionCount, filterLoadableExtensionPaths } from "./pi-session";

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
  h.onEventRef.current = null;
  h.PiRpcSession.mockClear();
  h.buildRpcArgs.mockClear();
  h.spawnPiRpc.mockClear();
  h.writePiExtension.mockClear();
  h.writeApprovalExtension.mockClear();
  h.writeCustomToolExtension.mockClear();
  h.writeSlashCommandExtension.mockClear();
  h.writeAskQuestionExtension.mockClear();
  h.spawnEnvFor.mockClear();
  h.readImageBytes.mockClear();
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
  it("无 provider:仅 askquestion 常驻注入,buildRpcArgs+spawn+构造会话,就绪后回 sessionId,注册表 +1", async () => {
    const { result } = await open();
    expect(h.writePiExtension).not.toHaveBeenCalled();
    expect(h.writeAskQuestionExtension).toHaveBeenCalledWith(expect.stringContaining("@@CORTEX_ASKQ"));
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

describe("阶段3 extension 装配（pi:open 按开关注入）", () => {
  it("enableToolApproval → writeApprovalExtension + extraExtensionPaths 含其路径", async () => {
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/p", enableToolApproval: true, approvalTools: ["bash"] };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.writeApprovalExtension).toHaveBeenCalledWith(["bash"]);
    expect(req.extraExtensionPaths).toContain("/ext/approval.js");
  });

  it("三开关全开 → 三个样例 + askquestion 常驻,extraExtensionPaths 四条", async () => {
    const req: PiOpenRequest = {
      uiSessionId: "u1",
      cwd: "/p",
      enableToolApproval: true,
      enableSampleTools: true,
      enableSampleCommands: true,
    };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(req.extraExtensionPaths).toEqual([
      "/ext/approval.js",
      "/ext/sample-tools.js",
      "/ext/sample-commands.js",
      "/ext/askquestion.js",
    ]);
  });

  it("无开关 → 不生成样例 extension,但 askquestion 常驻注入(每会话高熵 sentinel)", async () => {
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/p" };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.writeApprovalExtension).not.toHaveBeenCalled();
    expect(h.writeAskQuestionExtension).toHaveBeenCalledWith(expect.stringContaining("@@CORTEX_ASKQ"));
    expect(req.extraExtensionPaths).toEqual(["/ext/askquestion.js"]);
  });

  it("provider + 审批共存:provider extension 与审批 extension 都生成,互不影响", async () => {
    const provider = { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "k", models: [] };
    const req: PiOpenRequest = { uiSessionId: "u1", cwd: "/p", provider, enableToolApproval: true };
    await h.handlers.get("pi:open")!(fakeEvent(), req);
    expect(h.writePiExtension).toHaveBeenCalledWith(provider); // provider 注入不动
    expect(req.piExtensionPath).toBe("/ext/deepseek.js");
    expect(req.extraExtensionPaths).toEqual(["/ext/approval.js", "/ext/askquestion.js"]);
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
    h.PiRpcSession.mockImplementationOnce(function (_t: unknown, _onEvent: (ev: unknown) => void) {
      h.instances.push(sess);
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

describe("filterLoadableExtensionPaths（U7 坏 -e 隔离）", () => {
  it("仅保留存在的绝对路径,剔除不存在/相对路径（防 fail-hard 拖垮会话）", () => {
    // process.execPath 必为存在的绝对路径;另两个失效。
    expect(filterLoadableExtensionPaths([process.execPath, "/nope/missing-ext.js", "rel/x.js"])).toEqual([
      process.execPath,
    ]);
  });
  it("空 / undefined → []", () => {
    expect(filterLoadableExtensionPaths(undefined)).toEqual([]);
    expect(filterLoadableExtensionPaths([])).toEqual([]);
  });
});
