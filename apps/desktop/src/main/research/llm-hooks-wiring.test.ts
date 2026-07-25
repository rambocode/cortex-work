// 装配层的 LLM 接线契约。
//
// 为什么单独有这个测试：P7 把 Planner / Report Generator 做完并测透了，但 runtime.ts 的
// assembleService() 没有把 createResearchLlmHooks 接上——单测全绿，生产路径却仍是确定性行为，
// 也就是整套多轮 Planner 变成死代码。这类「实现完整但没接线」的缺口，只有针对装配层本身
// 的断言才能挡住。
//
// 这里不启动 Electron（runtime.ts 依赖 app / safeStorage / utilityProcess），只测被抽出来的
// 纯装配判定函数 buildResearchLlmHooks。
import { describe, expect, it, vi } from "vitest";

import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";

import { buildResearchLlmHooks } from "./llm-hooks-wiring";

/// 一个指向本机的 provider（loopback），local_only 策略下唯一可用的形态。
const localProviders: ProviderSettings = {
  providers: [
    {
      id: "local",
      name: "本地",
      baseUrl: "http://127.0.0.1:11434/v1",
      endpointFormat: "chat_completions",
      models: [{ id: "qwen3" }],
      enabled: true,
    },
  ],
};

const cloudProviders: ProviderSettings = {
  providers: [
    {
      id: "cloud",
      name: "云",
      baseUrl: "https://api.example.com/v1",
      endpointFormat: "chat_completions",
      models: [{ id: "gpt-x" }],
      enabled: true,
    },
  ],
};

function summary(overrides: Partial<ResearchSessionSummary> = {}): ResearchSessionSummary {
  return {
    sessionId: "s_1",
    consumer: "deep_research",
    objective: "目标",
    mode: "standard",
    status: "created",
    createdAt: "2026-07-25T00:00:00Z",
    updatedAt: "2026-07-25T00:00:00Z",
    roundCount: 0,
    documentCount: 0,
    chunkCount: 0,
    ...overrides,
  } as ResearchSessionSummary;
}

describe("buildResearchLlmHooks", () => {
  it("配置了 provider 时装配出三个 LLM 注入项", () => {
    const hooks = buildResearchLlmHooks({
      summary: summary(),
      modelDataPolicy: "evidence_allowed",
      providerSettings: cloudProviders,
    });

    expect(hooks).not.toBeNull();
    expect(typeof hooks?.planInitial).toBe("function");
    expect(typeof hooks?.planGap).toBe("function");
    expect(typeof hooks?.generateReport).toBe("function");
  });

  it("没有任何 provider 时返回 null（编排层沿用确定性行为，而不是让 Session 失败）", () => {
    const hooks = buildResearchLlmHooks({
      summary: summary(),
      modelDataPolicy: "evidence_allowed",
      providerSettings: { providers: [] },
    });

    expect(hooks).toBeNull();
  });

  it("providerSettings 为 null 时返回 null", () => {
    const hooks = buildResearchLlmHooks({
      summary: summary(),
      modelDataPolicy: "evidence_allowed",
      providerSettings: null,
    });

    expect(hooks).toBeNull();
  });

  it("local_only 且只有云 provider 时仍装配 hooks —— 拒绝出站由网关前置闸负责", async () => {
    // 这里刻意**不**在装配层提前拒绝：网关的 selectResearchModel 才是 spec §19.2.5 的
    // 单一判定点。装配层若也判一次，两处规则会漂移，且会把「无本地模型」误报成「未配置模型」。
    const fetchFn = vi.fn();
    const hooks = buildResearchLlmHooks({
      summary: summary(),
      modelDataPolicy: "local_only",
      providerSettings: cloudProviders,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(hooks).not.toBeNull();
    // 真正调用时必须零出站（降级为确定性种子计划，不抛错）。
    await hooks!.planInitial({
      objective: "目标",
      mode: "standard",
      budget: { maxRounds: 1, maxQueries: 4, maxCandidates: 24, maxDocuments: 8, maxBrowserFetches: 1, maxDurationMs: 90_000, maxEvidenceCharsToModel: 20_000 },
      signal: new AbortController().signal,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("local_only + loopback provider 时正常装配", () => {
    const hooks = buildResearchLlmHooks({
      summary: summary(),
      modelDataPolicy: "local_only",
      providerSettings: localProviders,
    });

    expect(hooks).not.toBeNull();
  });

  it("按 Session 的 consumer 装配（consumer 影响 Planner 的默认来源范围）", () => {
    const hooks = buildResearchLlmHooks({
      summary: summary({ consumer: "chat" }),
      modelDataPolicy: "evidence_allowed",
      providerSettings: cloudProviders,
    });

    expect(hooks).not.toBeNull();
  });
});
