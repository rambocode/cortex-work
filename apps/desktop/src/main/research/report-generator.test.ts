// LLM 报告生成器的行为测试（spec §10.4、§19.1.6）。
//
// 两条红线各有一个用例：
// - 模型编造 chunkId → 引用被删、该段标 unsupported；
// - 模型不可用 → 降级为确定性证据摘要，而不是让 Session 失败。
import { describe, expect, it } from "vitest";
import { clampResearchBudget } from "@cortex-work/core/research/budget";
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type { ModelCallInput, ModelCallResult } from "./policy-aware-model-gateway";
import { generateReport } from "./report-generator";

function fakeGateway(...responses: ModelCallResult[]): {
  gateway: { call(input: ModelCallInput): Promise<ModelCallResult> };
  calls: ModelCallInput[];
} {
  const calls: ModelCallInput[] = [];
  let index = 0;
  return {
    calls,
    gateway: {
      call: async (input) => {
        calls.push(input);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return response ?? { ok: false, code: "call_failed", message: "no response" };
      },
    },
  };
}

function ok(text: string): ModelCallResult {
  return { ok: true, text, providerId: "p", model: "m", isLocal: false };
}

const PUBLIC_TEXT = "node:sqlite 在 Node 22 上可用，但仍被标记为实验特性，生产前需评估。";
/// 只出现在正文里、不出现在目标/标题里的判别串。
const BODY_MARKER = "仍被标记为实验特性";
const MEMORY_TEXT = "用户的私人记忆：上周与投资人的会议纪要，不得出站。";

function chunk(id: string, documentId: string, text: string, trustZone: EvidenceChunk["trustZone"]): EvidenceChunk {
  return {
    chunkId: id,
    documentId,
    text,
    textHash: `hash_${id}`,
    objectiveScore: 0.8,
    subquestionScores: { sq_1: 0.8 },
    trustZone,
  };
}

function document(id: string, trustZone: ResearchDocument["policy"]["trustZone"]): ResearchDocument {
  return {
    documentId: id,
    source: { sourceType: "documentation", trustZone, locator: `https://nodejs.org/${id}`, domain: "nodejs.org" },
    title: `文档 ${id}`,
    contentHash: `content_${id}`,
    mediaType: "text/html",
    fetchMethod: "http",
    fetchedAt: "2026-07-25T09:00:00.000Z",
    contentRef: `blob:${id}`,
    textLength: 40,
    policy: {
      trustZone,
      allowSearchServer: trustZone === "public_web",
      allowCloudModel: trustZone === "public_web",
      allowCrossSessionReuse: trustZone === "public_web",
    },
  };
}

const BUDGET = clampResearchBudget("standard");

const INPUT = {
  objective: "调研 node:sqlite 是否可用于生产",
  subquestions: [{ id: "sq_1", text: "node:sqlite 的稳定性状态" }],
  chunks: [chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web")],
  documents: [document("doc_1", "public_web")],
  policy: "evidence_allowed" as const,
  budget: BUDGET,
  generatedAt: "2026-07-25T10:00:00.000Z",
};

describe("generateReport 的引用校验（spec §19.1.6）", () => {
  it("模型编造未知 chunkId 时该引用被删，且失去支撑的段落被标 unsupported", async () => {
    const { gateway } = fakeGateway(
      ok("node:sqlite 仍是实验特性[^ch_1]。\n\n它已经完全可用于生产[^ch_forged]。"),
    );
    const report = await generateReport(INPUT, { gateway });

    expect(report.markdown).toContain("[^ch_1]");
    expect(report.markdown).not.toContain("ch_forged");
    expect(report.citations.map((item) => item.chunkId)).toEqual(["ch_1"]);
    expect(report.unsupportedSections).toHaveLength(1);
    // 引用的元数据一律取自我们自己的证据链，而不是模型输出
    expect(report.citations[0]).toMatchObject({
      documentId: "doc_1",
      title: "文档 doc_1",
      textHash: "hash_ch_1",
      retrievedAt: "2026-07-25T09:00:00.000Z",
    });
  });
});

describe("generateReport 的出站过滤（spec §10.4）", () => {
  it("evidence_allowed 下不允许出站的来源不会进入 prompt", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport(
      {
        ...INPUT,
        chunks: [
          chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web"),
          chunk("ch_2", "doc_2", MEMORY_TEXT, "memory"),
        ],
        documents: [document("doc_1", "public_web"), document("doc_2", "memory")],
      },
      { gateway },
    );

    const prompt = calls[0]!.userPrompt;
    expect(prompt).toContain(BODY_MARKER);
    expect(prompt).not.toContain("私人记忆");
    expect(prompt).not.toContain("ch_2");
  });

  it("metadata_only 下 prompt 只有标题与域名，正文一个字都不出现", async () => {
    const { gateway, calls } = fakeGateway(ok("找到了官方来源[^ch_1]。"));
    await generateReport({ ...INPUT, policy: "metadata_only" }, { gateway });

    const prompt = calls[0]!.userPrompt;
    expect(prompt).toContain("nodejs.org");
    expect(prompt).toContain("文档 doc_1");
    expect(prompt).not.toContain(BODY_MARKER);
    // 同时把正文交给网关做第二道守卫
    expect(calls[0]!.forbiddenEvidenceTexts).toContain(PUBLIC_TEXT);
    expect(calls[0]!.policy).toBe("metadata_only");
  });

  it("metadata_only 下未获批准来源的标题与域名同样不出站（spec §19.3.3）", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport(
      {
        ...INPUT,
        policy: "metadata_only",
        chunks: [
          chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web"),
          chunk("ch_2", "doc_2", MEMORY_TEXT, "memory"),
        ],
        documents: [document("doc_1", "public_web"), document("doc_2", "memory")],
      },
      { gateway },
    );

    expect(calls[0]!.userPrompt).not.toContain("doc_2");
    expect(calls[0]!.userPrompt).toContain("doc_1");
  });

  it("local_only 下允许把正文交给本地模型（数据不出本机）", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport({ ...INPUT, policy: "local_only" }, { gateway });
    expect(calls[0]!.userPrompt).toContain(BODY_MARKER);
  });

  it("出站预算被传给网关", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport(INPUT, { gateway });
    expect(calls[0]!.maxPromptChars).toBe(BUDGET.maxEvidenceCharsToModel);
  });
});

describe("generateReport 的降级", () => {
  it("local_only 无本地模型时降级为确定性证据摘要，而不是失败", async () => {
    const { gateway } = fakeGateway({
      ok: false,
      code: "local_model_unavailable",
      message: "没有本地模型",
    });
    const report = await generateReport({ ...INPUT, policy: "local_only" }, { gateway });

    expect(report.markdown).toContain("node:sqlite");
    expect(report.markdown).toContain("[^ch_1]");
    expect(report.citations.map((item) => item.chunkId)).toEqual(["ch_1"]);
    expect(report.generatedAt).toBe("2026-07-25T10:00:00.000Z");
  });

  it("模型调用失败时降级为确定性证据摘要", async () => {
    const { gateway } = fakeGateway({ ok: false, code: "call_failed", message: "HTTP 500" });
    const report = await generateReport(INPUT, { gateway });
    expect(report.markdown).toContain("[^ch_1]");
  });

  it("模型返回空正文时降级为确定性证据摘要", async () => {
    const { gateway } = fakeGateway(ok("   "));
    const report = await generateReport(INPUT, { gateway });
    expect(report.markdown).toContain("[^ch_1]");
  });

  it("没有任何证据时仍产出可用的报告骨架（不抛错）", async () => {
    const { gateway } = fakeGateway({ ok: false, code: "call_failed", message: "x" });
    const report = await generateReport({ ...INPUT, chunks: [], documents: [] }, { gateway });
    expect(report.markdown.length).toBeGreaterThan(0);
    expect(report.citations).toEqual([]);
  });
});

describe("报告输出预算", () => {
  /// 现状的两个问题：
  ///   1. 输出 token 固定 3000，而输入侧 maxEvidenceCharsToModel 按模式分档
  ///      （quick 20k / standard 60k / deep 120k 字符）。deep 喂 6 倍证据却用同样的输出
  ///      预算，报告必然覆盖不全——用户看到的就是「读了很多、写得很少」。
  ///   2. `output.maxWords` 在 core 的类型与 consumer 预设里都存在（report 预设写的是
  ///      3000 words），但报告生成器**从不消费它**，用户指定的长度被静默忽略。
  ///
  /// 3000 token 对中文约等于 2000 字，作为一篇带引用的研究报告确实偏薄。
  function captureMaxTokens(): {
    gateway: { call: (input: ModelCallInput) => Promise<ModelCallResult>; preflight: () => never };
    seen: Array<number | undefined>;
  } {
    const seen: Array<number | undefined> = [];
    return {
      gateway: {
        call: async (input: ModelCallInput) => {
          seen.push(input.maxTokens);
          return ok("# 报告\n\n正文[^ch_1]。");
        },
        preflight: (() => {
          throw new Error("本用例不该走 preflight");
        }) as never,
      },
      seen,
    };
  }

  it("maxWords 存在时按它推导输出预算（中文 1 字 ≈ 1 token，留余量）", async () => {
    const { gateway, seen } = captureMaxTokens();
    await generateReport(
      { ...INPUT, output: { format: "report" as const, maxWords: 3000, requireCitations: true } },
      { gateway },
    );
    // 3000 字 → 至少 4500 token，绝不能还是原来那个固定的 3000。
    expect(seen[0]!).toBeGreaterThanOrEqual(4500);
  });

  it("没有 maxWords 时按模式分档：deep 的输出预算必须大于 quick", async () => {
    const quick = captureMaxTokens();
    await generateReport({ ...INPUT, budget: clampResearchBudget("quick") }, { gateway: quick.gateway });
    const deep = captureMaxTokens();
    await generateReport({ ...INPUT, budget: clampResearchBudget("deep") }, { gateway: deep.gateway });
    expect(deep.seen[0]!).toBeGreaterThan(quick.seen[0]!);
  });

  it("输出预算有硬上限（避免一个畸形 maxWords 把单次调用烧穿）", async () => {
    const { gateway, seen } = captureMaxTokens();
    await generateReport(
      { ...INPUT, output: { format: "report" as const, maxWords: 10_000_000, requireCitations: true } },
      { gateway },
    );
    expect(seen[0]!).toBeLessThanOrEqual(32_000);
  });
});

describe("每节证据条数也要按模式分档", () => {
  /// 只放大输出预算是不够的：模型手上只有 8 条摘录时，让它写 9000 字只会得到注水。
  /// 输入材料量与输出长度必须一起放大，否则「报告变长」只是幻觉。
  function manyChunks(n: number): EvidenceChunk[] {
    return Array.from({ length: n }, (_, i) => chunk(`ch_${i}`, "doc_1", PUBLIC_TEXT, "public_web"));
  }

  function capturePrompt(): {
    gateway: { call: (input: ModelCallInput) => Promise<ModelCallResult>; preflight: () => never };
    prompts: string[];
  } {
    const prompts: string[] = [];
    return {
      gateway: {
        call: async (input: ModelCallInput) => {
          prompts.push(input.userPrompt);
          return ok("# 报告\n\n正文[^ch_0]。");
        },
        preflight: (() => {
          throw new Error("本用例不该走 preflight");
        }) as never,
      },
      prompts,
    };
  }

  it("deep 模式送进 prompt 的 chunk 数多于 quick", async () => {
    const chunks = manyChunks(40);
    const quick = capturePrompt();
    await generateReport(
      { ...INPUT, chunks, budget: clampResearchBudget("quick") },
      { gateway: quick.gateway },
    );
    const deep = capturePrompt();
    await generateReport(
      { ...INPUT, chunks, budget: clampResearchBudget("deep") },
      { gateway: deep.gateway },
    );

    const countRefs = (prompt: string): number => (prompt.match(/ch_\d+/g) ?? []).length;
    expect(countRefs(deep.prompts[0]!)).toBeGreaterThan(countRefs(quick.prompts[0]!));
  });
});
