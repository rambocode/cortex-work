// 装配层的 LLM 接线契约。
//
// 为什么单独有这个测试：P7 把 Planner / Report Generator 做完并测透了，但 runtime.ts 的
// assembleService() 没有把 createResearchLlmHooks 接上——单测全绿，生产路径却仍是确定性行为，
// 也就是整套多轮 Planner 变成死代码。这类「实现完整但没接线」的缺口，只有针对装配层本身
// 的断言才能挡住。
//
// 这里不启动 Electron（runtime.ts 依赖 app / safeStorage / utilityProcess），只测被抽出来的
// 纯装配判定函数 buildResearchLlmHooks。
import { describe, expect, it } from "vitest";

import type { ResearchSessionSummary } from "@cortex-work/core/research/types";

import { buildResearchLlmHooks } from "./llm-hooks-wiring";

/// 阶段③·4.1 收编后装配层只看「有没有一个完整的模型引用」，不再看 provider 列表。
const CLOUD = { providerId: "cloud", modelId: "gpt-x" };
const LOCAL = { providerId: "local", modelId: "qwen3" };

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
  it("有完整模型引用时装配出三个 LLM 注入项", () => {
    const hooks = buildResearchLlmHooks({
      summary: summary(),
      fallback: CLOUD,
    });

    expect(hooks).not.toBeNull();
    expect(typeof hooks?.planInitial).toBe("function");
    expect(typeof hooks?.planGap).toBe("function");
    expect(typeof hooks?.generateReport).toBe("function");
  });

  it("没有任何模型引用时返回 null（编排层沿用确定性行为，而不是让 Session 失败）", () => {
    expect(buildResearchLlmHooks({ summary: summary() })).toBeNull();
    expect(buildResearchLlmHooks({ summary: summary(), fallback: null })).toBeNull();
  });

  it("引用只有一半时也返回 null（不跨级拼 providerId + modelId）", () => {
    expect(
      buildResearchLlmHooks({
        summary: summary(),
        preference: { providerId: "cloud" },
        fallback: { providerId: "", modelId: "gpt-x" },
      }),
    ).toBeNull();
  });

  it("研究偏好完整时压过全局默认；偏好不完整时整级作废、落全局默认", () => {
    // 装配层不返回引用本身，故用「装没装出来」间接断言两级回落都成立。
    expect(
      buildResearchLlmHooks({ summary: summary(), preference: { providerId: "x", modelId: "y" } }),
    ).not.toBeNull();
    expect(
      buildResearchLlmHooks({ summary: summary(), preference: { providerId: "x" }, fallback: CLOUD }),
    ).not.toBeNull();
  });

  it("模型引用指向已失效的模型时仍装配 hooks —— 阻断由 Pi Model Gateway 负责", () => {
    // 这里刻意**不**在装配层提前拒绝：Gateway 出站前的 config 判定才是单一判定点
    //（计划 §5 的阻断态）。装配层若也判一次，两处规则会漂移，
    // 且会把「你选的模型下线了」误报成「你没配模型」。
    const hooks = buildResearchLlmHooks({
      summary: summary(),
      preference: { providerId: "已删除的供应商", modelId: "不存在的模型" },
    });

    expect(hooks).not.toBeNull();
  });

  it("loopback provider（本地模型）同样正常装配", () => {
    expect(buildResearchLlmHooks({ summary: summary(), fallback: LOCAL })).not.toBeNull();
  });

  it("按 Session 的 consumer 装配（consumer 影响 Planner 的默认来源范围）", () => {
    expect(buildResearchLlmHooks({ summary: summary({ consumer: "chat" }), fallback: CLOUD })).not.toBeNull();
  });
});
