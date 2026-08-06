// 扩展 UI 桥单测。最要紧的一条:**任何路径都不能让 pi 的 execute 永久挂起**——
// 取消 / 超时 / 派发失败 / 会话终止,四条都必须把 Promise 结算掉。

import { describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../ipc/agent-trace", () => ({ recordAgentTrace: vi.fn(), recordStreamDelta: vi.fn() }));

import { createPiUiBridge } from "./ui-context";
import type { PiUiRequest } from "../../ipc/types";

// pi 的 ExtensionUIContext 收窄视图:只声明测试用到的成员(真实对象是 unknown,见 ui-context.ts)。
interface UiCtx {
  select(title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

function setup(
  opts: { sentinel?: string; jsReplSentinel?: string; onUiRequest?: (r: PiUiRequest) => void } = {},
) {
  const requests: PiUiRequest[] = [];
  const notes: Array<{ message: string; level: string }> = [];
  let n = 0;
  const bridge = createPiUiBridge({
    onUiRequest:
      opts.onUiRequest ??
      ((r) => {
        requests.push(r);
      }),
    onNotify: (message, level) => notes.push({ message, level }),
    ...(opts.sentinel ? { askQuestionSentinel: opts.sentinel } : {}),
    ...(opts.jsReplSentinel ? { jsReplSentinel: opts.jsReplSentinel } : {}),
    makeId: () => `id-${++n}`,
  });
  return { bridge, ctx: bridge.context as UiCtx, requests, notes };
}

describe("对话框往返", () => {
  it("confirm:请求形状与 PiUiRequest 契约一致,应答回填 confirmed", async () => {
    const { bridge, ctx, requests } = setup();
    const p = ctx.confirm("执行确认", "要跑 bash 吗?");
    expect(requests[0]).toEqual({
      type: "extension_ui_request",
      id: "id-1",
      method: "confirm",
      title: "执行确认",
      message: "要跑 bash 吗?",
      timeout: undefined,
    });
    bridge.respond("id-1", { confirmed: true });
    await expect(p).resolves.toBe(true);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("select / input / editor 用 {value} 回填,cancelled 回默认值", async () => {
    const { bridge, ctx } = setup();
    const sel = ctx.select("选一个", ["a", "b"]);
    bridge.respond("id-1", { value: "b" });
    await expect(sel).resolves.toBe("b");

    const inp = ctx.input("填点什么");
    bridge.respond("id-2", { cancelled: true });
    await expect(inp).resolves.toBeUndefined();

    const ed = ctx.editor("编辑", "prefill");
    bridge.respond("id-3", { cancelled: true });
    await expect(ed).resolves.toBeUndefined();
  });

  it("cancelled 的 confirm 回 false(不是 reject——用户点取消不是错误)", async () => {
    const { bridge, ctx } = setup();
    const p = ctx.confirm("t", "m");
    bridge.respond("id-1", { cancelled: true });
    await expect(p).resolves.toBe(false);
  });

  it("重复回写幂等,未知 id 静默丢弃", async () => {
    const { bridge, ctx } = setup();
    const p = ctx.confirm("t", "m");
    bridge.respond("id-1", { confirmed: true });
    expect(() => bridge.respond("id-1", { confirmed: false })).not.toThrow();
    expect(() => bridge.respond("nope", { cancelled: true })).not.toThrow();
    await expect(p).resolves.toBe(true);
  });
});

describe("不挂起保证", () => {
  it("timeout 到点按默认值结算", async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = setup();
      const p = ctx.confirm("t", "m", { timeout: 50 });
      vi.advanceTimersByTime(60);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("已 abort 的 signal 直接返回默认值,不登记 pending", async () => {
    const { bridge, ctx } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(ctx.confirm("t", "m", { signal: ac.signal })).resolves.toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("中途 abort 也会结算", async () => {
    const { ctx } = setup();
    const ac = new AbortController();
    const p = ctx.select("t", ["a"], { signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toBeUndefined();
  });

  it("没有 UI 出口时立刻按默认值结算(单发路径无审批 UI)", async () => {
    const bridge = createPiUiBridge({ onNotify: () => {} });
    const ctx = bridge.context as UiCtx;
    await expect(ctx.confirm("t", "m")).resolves.toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("派发出口抛错(renderer 已销毁)也按默认值结算", async () => {
    const { ctx } = setup({
      onUiRequest: () => {
        throw new Error("WebContents destroyed");
      },
    });
    await expect(ctx.confirm("t", "m")).resolves.toBe(false);
  });

  it("cancelAll 解锁全部挂起项(会话 stop 的关键)", async () => {
    const { bridge, ctx } = setup();
    const a = ctx.confirm("t", "m");
    const b = ctx.select("t", ["x"]);
    expect(bridge.pendingCount()).toBe(2);
    bridge.cancelAll();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBeUndefined();
    expect(bridge.pendingCount()).toBe(0);
  });
});

describe("askquestion 借道", () => {
  const sentinel = "@@CORTEX_ASKQ:abc@@";

  it("命中 sentinel 的 input 被归一为 askquestion 富信封", async () => {
    const { bridge, ctx, requests } = setup({ sentinel });
    const envelope = { groups: [{ question: "选哪个?", options: [{ label: "A" }, { label: "B" }], recommended: 1 }] };
    const p = ctx.input(`${sentinel}${JSON.stringify(envelope)}`);
    const req = requests[0]!;
    expect(req.method).toBe("askquestion");
    if (req.method !== "askquestion") throw new Error("unreachable");
    // host 不信任入站 id / 推荐位:id 按位置重写、推荐项被提到第一个。
    expect(req.envelope.groups[0]!.id).toBe("g0");
    expect(req.envelope.groups[0]!.options[0]!.label).toBe("B");
    expect(req.envelope.groups[0]!.recommended).toBe(0);
    bridge.respond(req.id, { value: '{"answers":[]}' });
    await expect(p).resolves.toBe('{"answers":[]}');
  });

  it("信封坏掉时透传为裸 input(不静默吞,便于定位 pi 版本漂移)", () => {
    const { ctx, requests } = setup({ sentinel });
    void ctx.input(`${sentinel}{不是 JSON`);
    expect(requests[0]!.method).toBe("input");
    expect(logMocks.logger.warn).toHaveBeenCalled();
  });

  it("没有 sentinel 前缀的 input 不受影响", () => {
    const { ctx, requests } = setup({ sentinel });
    void ctx.input("普通输入");
    expect(requests[0]!.method).toBe("input");
  });
});

describe("jsrepl 借道（askquestion 同轨）", () => {
  const jsReplSentinel = "@@CORTEX_JSREPL:xyz@@";

  it("命中 jsrepl sentinel 的 input 被归一为 method:jsrepl,三态回写照常", async () => {
    const { bridge, ctx, requests } = setup({ jsReplSentinel });
    const p = ctx.input(`${jsReplSentinel}${JSON.stringify({ title: "算数", code: "1+1" })}`);
    const req = requests[0]!;
    expect(req.method).toBe("jsrepl");
    if (req.method !== "jsrepl") throw new Error("unreachable");
    expect(req.envelope).toEqual({ title: "算数", code: "1+1" });
    bridge.respond(req.id, { value: '{"ok":true,"output":"2"}' });
    await expect(p).resolves.toBe('{"ok":true,"output":"2"}');
  });

  it("两个 sentinel 并存互不串道;jsrepl 信封坏掉透传裸 input", () => {
    const askSentinel = "@@CORTEX_ASKQ:abc@@";
    const { ctx, requests } = setup({ sentinel: askSentinel, jsReplSentinel });
    void ctx.input(`${jsReplSentinel}${JSON.stringify({ title: "t", code: "x" })}`);
    void ctx.input(`${askSentinel}${JSON.stringify({ groups: [{ question: "q", options: [{ label: "A" }] }] })}`);
    void ctx.input(`${jsReplSentinel}{"title":"t"}`); // 缺 code → 校验失败
    expect(requests[0]!.method).toBe("jsrepl");
    expect(requests[1]!.method).toBe("askquestion");
    expect(requests[2]!.method).toBe("input");
    expect(logMocks.logger.warn).toHaveBeenCalled();
  });
});

describe("notify", () => {
  it("是 fire-and-forget:走事件出口而不是对话框队列", () => {
    const { bridge, ctx, requests, notes } = setup();
    ctx.notify("done", "warning");
    ctx.notify("plain");
    expect(requests).toEqual([]);
    expect(bridge.pendingCount()).toBe(0);
    expect(notes).toEqual([
      { message: "done", level: "warning" },
      { message: "plain", level: "info" },
    ]);
  });
});
