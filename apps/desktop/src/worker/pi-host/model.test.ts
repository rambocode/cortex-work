// worker 侧模型解析的单测。
//
// 最要紧的一条是「解析不出模型必须响亮失败」：静默降级会让 pi 走自己的 findInitialModel
// 兜底链换一个用户从没选过的供应商——用户以为在用选定模型、实际不是。

import { describe, expect, it, vi } from "vitest";

import type { PiOpenRequest } from "../../main/ipc/types";

const runtimeMocks = vi.hoisted(() => ({ loadPiCodingAgent: vi.fn() }));

vi.mock("../../main/agents/pi-inproc/runtime", () => ({
  loadPiCodingAgent: runtimeMocks.loadPiCodingAgent,
}));

const { createWorkerModelResolver } = await import("./model");

interface FakeRuntime {
  providers: Array<{ id: string }>;
  models: Record<string, unknown[]>;
  registered: Array<{ id: string; config: { baseUrl?: string } }>;
}

function fakeRuntime(init: Partial<FakeRuntime> = {}) {
  const state: FakeRuntime = {
    providers: init.providers ?? [{ id: "anthropic" }],
    models: init.models ?? { anthropic: [{ id: "claude-x", provider: "anthropic" }] },
    registered: [],
  };
  const runtime = {
    getProviders: () => state.providers,
    getModels: (providerId?: string) => (providerId ? (state.models[providerId] ?? []) : []),
    getModel: (providerId: string, modelId: string) =>
      (state.models[providerId] ?? []).find((m) => (m as { id: string }).id === modelId),
    registerProvider: (id: string, config: { baseUrl?: string }) => state.registered.push({ id, config }),
  };
  return { runtime, state };
}

function mockModule(runtime: unknown, createSpy = vi.fn()) {
  runtimeMocks.loadPiCodingAgent.mockResolvedValue({
    ModelRuntime: {
      create: createSpy.mockResolvedValue(runtime),
    },
  });
  return createSpy;
}

const CREDENTIALS = { read: vi.fn(), list: vi.fn(), modify: vi.fn(), delete: vi.fn() } as never;
const BASE: PiOpenRequest = { uiSessionId: "ui-1", cwd: "/tmp" };

describe("createWorkerModelResolver", () => {
  it("注入 RPC 凭据仓、关闭建时联网刷新（KTD1 + 不让一次网络超时拖住开会话）", async () => {
    const { runtime } = fakeRuntime();
    const create = mockModule(runtime);
    await createWorkerModelResolver(CREDENTIALS)({ ...BASE, providerId: "anthropic" });
    expect(create).toHaveBeenCalledWith({ credentials: CREDENTIALS, allowModelNetwork: false });
  });

  it("给定 providerId + model → 精确解析", async () => {
    const { runtime } = fakeRuntime();
    mockModule(runtime);
    const sel = await createWorkerModelResolver(CREDENTIALS)({
      ...BASE,
      providerId: "anthropic",
      model: "claude-x",
    });
    expect(sel.model).toEqual({ id: "claude-x", provider: "anthropic" });
    expect(sel.modelRuntime).toBe(runtime);
  });

  it("只有 providerId → 取该供应商第一个模型", async () => {
    const { runtime } = fakeRuntime();
    mockModule(runtime);
    const sel = await createWorkerModelResolver(CREDENTIALS)({ ...BASE, providerId: "anthropic" });
    expect(sel.model).toEqual({ id: "claude-x", provider: "anthropic" });
  });

  it("没有 providerId → 不猜模型，但仍交出 modelRuntime（它承载整个注册表与凭据通道）", async () => {
    const { runtime } = fakeRuntime();
    mockModule(runtime);
    const sel = await createWorkerModelResolver(CREDENTIALS)(BASE);
    expect(sel.model).toBeUndefined();
    expect(sel.modelRuntime).toBe(runtime);
  });

  it("模型不存在 → 响亮失败，绝不返回「没有 model」的结果", async () => {
    const { runtime } = fakeRuntime();
    mockModule(runtime);
    await expect(
      createWorkerModelResolver(CREDENTIALS)({ ...BASE, providerId: "anthropic", model: "不存在" }),
    ).rejects.toThrow(/模型不存在/);
  });

  it("供应商没有可用模型 → 响亮失败", async () => {
    const { runtime } = fakeRuntime({ providers: [{ id: "x" }], models: {} });
    mockModule(runtime);
    await expect(createWorkerModelResolver(CREDENTIALS)({ ...BASE, providerId: "x" })).rejects.toThrow(
      /没有可用模型/,
    );
  });

  it("baseUrl 覆盖登记到注册表，且绝不下发 models / apiKey", async () => {
    const { runtime, state } = fakeRuntime();
    mockModule(runtime);
    await createWorkerModelResolver(CREDENTIALS)({
      ...BASE,
      providerId: "anthropic",
      provider: { id: "anthropic", baseUrl: "https://gw.example.com", models: [], apiKey: "sk-x" },
    });
    expect(state.registered).toEqual([{ id: "anthropic", config: { baseUrl: "https://gw.example.com" } }]);
  });

  it("baseUrl 指向注册表里没有的供应商 → 跳过（留痕，不静默）", async () => {
    const { runtime, state } = fakeRuntime();
    mockModule(runtime);
    await createWorkerModelResolver(CREDENTIALS)({
      ...BASE,
      providerId: "anthropic",
      provider: { id: "我的自建", baseUrl: "https://x", models: [] },
    });
    expect(state.registered).toEqual([]);
  });

  it("ModelRuntime 建失败不缓存（装包/权限修好后无需重开会话）", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("加载失败"));
    runtimeMocks.loadPiCodingAgent.mockResolvedValue({ ModelRuntime: { create } });
    const resolve = createWorkerModelResolver(CREDENTIALS);
    await expect(resolve(BASE)).rejects.toThrow("加载失败");

    const { runtime } = fakeRuntime();
    create.mockResolvedValueOnce(runtime);
    await expect(resolve(BASE)).resolves.toMatchObject({ modelRuntime: runtime });
  });
});
