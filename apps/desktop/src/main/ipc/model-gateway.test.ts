// Gateway IPC 边界的契约测试。
//
// 这一层几乎没有逻辑，但它承载两条**只会静默失灵、不会报错**的跨进程约定，
// 各自都实际踩过或差点踩到，所以必须钉住：
//   1. 事件以单对象 `{ requestId, event }` 发送 —— preload 按这个形状解包；
//      形状错配时渲染端只会「流式什么都收不到」，没有任何异常。
//   2. 流式必须带 requestId —— 它是渲染端唯一的取消句柄与事件路由键。

import { beforeEach, describe, expect, it, vi } from "vitest";

let catalog: ReturnType<typeof fakeCatalog> | undefined;
vi.mock("../providers/catalog", () => ({ getProviderCatalog: () => catalog }));

/** 捕获 ipcMain.handle 注册的 handler，直接调用它们（不起真 Electron）。 */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { createFakePiRuntime, fakeCatalog } from "../providers/__fixtures__/fake-pi-runtime";
import { PROVIDER_IPC } from "../providers/contract";
import { setPiGatewayRuntimeForTests } from "../providers/pi-runtime";
import { registerModelGatewayHandlers } from "./model-gateway";

const REQ = { providerId: "p1", modelId: "m1", messages: [{ role: "user" as const, content: "hi" }] };

/** 假 sender：记录 `webContents.send` 的原始入参，用来断言事件形状。 */
function fakeSender() {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    event: { sender: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
  };
}

beforeEach(() => {
  handlers.clear();
  catalog = fakeCatalog();
  registerModelGatewayHandlers();
});

describe("modelGateway:stream", () => {
  it("事件以单对象 {requestId, event} 发送（preload 按这个形状解包，两侧必须同改）", async () => {
    setPiGatewayRuntimeForTests(createFakePiRuntime({ texts: ["嗨"], chunk: (t) => [...t] }));
    const { sent, event } = fakeSender();

    const result = await handlers.get(PROVIDER_IPC.gatewayStream)!(event, { ...REQ, requestId: "r1" });

    expect(result).toEqual({ ok: true, text: "嗨", usage: expect.any(Object) });
    expect(sent.every((s) => s.channel === PROVIDER_IPC.gatewayEvent)).toBe(true);
    expect(sent[0]!.payload).toEqual({ requestId: "r1", event: { type: "text", delta: "嗨" } });
    expect(sent.at(-1)!.payload).toEqual({ requestId: "r1", event: { type: "done", ok: true, text: "嗨" } });
    setPiGatewayRuntimeForTests(null);
  });

  it("缺 requestId → config 阻断，且一个事件都不发（不让它跑起来再静默失灵）", async () => {
    const runtime = createFakePiRuntime();
    setPiGatewayRuntimeForTests(runtime);
    const { sent, event } = fakeSender();

    const result = await handlers.get(PROVIDER_IPC.gatewayStream)!(event, REQ);

    expect(result).toMatchObject({ ok: false, errorKind: "config" });
    expect(sent).toHaveLength(0);
    expect(runtime.calls).toHaveLength(0);
    setPiGatewayRuntimeForTests(null);
  });

  it("空白 requestId 等同缺失", async () => {
    setPiGatewayRuntimeForTests(createFakePiRuntime());
    const { event } = fakeSender();
    const result = await handlers.get(PROVIDER_IPC.gatewayStream)!(event, { ...REQ, requestId: "   " });
    expect(result).toMatchObject({ ok: false, errorKind: "config" });
    setPiGatewayRuntimeForTests(null);
  });
});

describe("modelGateway:complete / abort", () => {
  it("单发不要求 requestId（不带 = 发出去就等结果，语义完整）", async () => {
    setPiGatewayRuntimeForTests(createFakePiRuntime({ texts: ["ok"] }));
    const result = await handlers.get(PROVIDER_IPC.gatewayComplete)!({}, REQ);
    expect(result).toMatchObject({ ok: true, text: "ok" });
    setPiGatewayRuntimeForTests(null);
  });

  it("abort 收裸 requestId 字符串并回 {ok}（形状与 preload 一致）", async () => {
    expect(await handlers.get(PROVIDER_IPC.gatewayAbort)!({}, "不存在的请求")).toEqual({ ok: false });
  });
});
