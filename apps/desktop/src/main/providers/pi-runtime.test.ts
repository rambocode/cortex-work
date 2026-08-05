// pi 运行时 probe 的埋点与端点解析单测。两件事必须钉死：
//   1. 连接测试的**五步轨迹**（runtime / resolve / auth / request / response）逐步上报，
//      且失败时先把 error 步骤推出去再抛——面板靠它显示「卡在哪一步」；
//   2. probe 用的是**贴过 baseUrl 覆盖**的模型。不贴的话测试会绕开用户配的自建网关去打
//      官方端点，出现「测试通过但聊天不通」这种最难查的假象。

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  overrides: {} as Record<string, string>,
  /** 记录 completeSimple 实际收到的模型（用于断言 baseUrl 覆盖已生效）。 */
  lastModel: undefined as { id: string; baseUrl: string } | undefined,
  stopReason: "end_turn" as string,
}));

vi.mock("./prefs", () => ({ getBaseUrlOverride: (id: string) => state.overrides[id] }));
vi.mock("./credentials", () => ({ createSafeStorageCredentialStore: () => ({}) }));
vi.mock("./custom-provider-registry", () => ({ syncCustomProvidersInto: async () => undefined }));
vi.mock("../log", () => ({ createLogger: () => ({ error: () => undefined, warn: () => undefined }) }));

// pi-ai 是纯 ESM 且经变量 specifier 动态 import（见 pi-runtime 文件头）；这里按同一路径拦截。
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (providerId: string, modelId: string) => ({
      id: modelId,
      provider: providerId,
      api: "openai-completions",
      baseUrl: "https://official.example/v1",
    }),
    getModels: () => [],
    checkAuth: async () => ({ type: "api-key", source: "ACME_API_KEY" }),
    completeSimple: async (model: { id: string; baseUrl: string }) => {
      state.lastModel = model;
      return {
        content: [{ type: "text", text: "pong" }],
        usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: {} },
        stopReason: state.stopReason,
        errorMessage: state.stopReason === "error" ? "上游拒绝" : undefined,
      };
    },
  }),
}));

import { getPiAuthRuntime, setPiAuthRuntimeForTests } from "./pi-runtime";
import type { ProviderConnectionTestStep } from "./contract";

beforeEach(() => {
  state.overrides = {};
  state.lastModel = undefined;
  state.stopReason = "end_turn";
  // 传 null 会连带清掉缓存的 models promise，保证各用例互不串。
  setPiAuthRuntimeForTests(null);
});

describe("probe 的步骤埋点", () => {
  it("五步按序上报，每步都是 running → 终态", async () => {
    const steps: ProviderConnectionTestStep[] = [];
    await getPiAuthRuntime().probe("acme", "m-1", { onStep: (s) => steps.push(s) });

    expect(steps.map((s) => `${s.id}:${s.state}`)).toEqual([
      "runtime:running",
      "runtime:ok",
      "resolve:running",
      "resolve:ok",
      "auth:running",
      "auth:ok",
      "request:running",
      "request:ok",
      "response:running",
      "response:ok",
    ]);
    // 参数与结果摘要都得落在 detail 上，否则面板只剩一排没有信息量的对勾。
    expect(steps.find((s) => s.id === "resolve" && s.state === "ok")?.detail).toContain("openai-completions");
    expect(steps.find((s) => s.id === "auth" && s.state === "ok")?.detail).toContain("ACME_API_KEY");
    expect(steps.find((s) => s.id === "request" && s.state === "running")?.detail).toContain("maxTokens 16");
    expect(steps.find((s) => s.id === "response" && s.state === "ok")?.detail).toContain("pong");
  });

  it("失败时先推 error 步骤再抛：前面成功的步骤不能因异常而丢失", async () => {
    state.stopReason = "error";
    const steps: ProviderConnectionTestStep[] = [];
    await expect(getPiAuthRuntime().probe("acme", "m-1", { onStep: (s) => steps.push(s) })).rejects.toThrow("上游拒绝");

    expect(steps.filter((s) => s.state === "ok").map((s) => s.id)).toEqual(["runtime", "resolve", "auth", "request"]);
    expect(steps.at(-1)).toMatchObject({ id: "response", state: "error" });
  });
});

describe("probe 的端点解析", () => {
  it("无覆盖时走官方端点", async () => {
    await getPiAuthRuntime().probe("acme", "m-1");
    expect(state.lastModel?.baseUrl).toBe("https://official.example/v1");
  });

  it("有覆盖时贴上覆盖地址——否则测试会绕开用户配的自建网关", async () => {
    state.overrides = { acme: "https://my-gw.example/v1" };
    const steps: ProviderConnectionTestStep[] = [];
    await getPiAuthRuntime().probe("acme", "m-1", { onStep: (s) => steps.push(s) });

    expect(state.lastModel?.baseUrl).toBe("https://my-gw.example/v1");
    // resolve 步的 detail 也要如实报出生效端点，这是面板上「发去哪儿」的唯一凭据。
    expect(steps.find((s) => s.id === "resolve" && s.state === "ok")?.detail).toContain("https://my-gw.example/v1");
  });
});
