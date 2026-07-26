// 知识沉淀的测试。
//
// **第一条是红线（KTD10）**：本模块永远只产出 pending 候选。它决定的是「什么东西会被
// 提议写进用户的长期记忆」，一条错误的记忆会污染之后每一轮对话，所以边界逐条锁死。
import { describe, expect, it } from "vitest";
import type { ResearchSessionView } from "@cortex-work/core/research/types";
import type { CitationRef } from "@cortex-work/core/research/evidence";

import {
  MAX_MEMORY_CANDIDATES_PER_SESSION,
  extractKnowledgeFromReport,
} from "./knowledge-extractor";

function citation(chunkId: string): CitationRef {
  return {
    chunkId,
    documentId: `doc-${chunkId}`,
    title: `来源 ${chunkId}`,
    retrievedAt: "2026-07-26T00:00:00Z",
    textHash: `hash-${chunkId}`,
  };
}

function view(markdown: string, chunkIds: string[] = ["c1", "c2"]): ResearchSessionView {
  return {
    summary: {
      sessionId: "ses-1",
      consumer: "deep_research",
      objective: "调研向量数据库选型",
      mode: "standard",
      status: "completed",
      createdAt: "2026-07-26T00:00:00Z",
      updatedAt: "2026-07-26T00:00:00Z",
      roundCount: 2,
      documentCount: 5,
      chunkCount: 20,
    },
    report: {
      markdown,
      citations: chunkIds.map(citation),
      unsupportedSections: [],
      generatedAt: "2026-07-26T00:00:00Z",
    },
  };
}

let seq = 0;
const deps = {
  now: () => new Date("2026-07-26T12:00:00Z"),
  newId: () => `id-${++seq}`,
};

describe("KTD10 红线", () => {
  it("**产出的候选恒为 pending**，绝不出现 approved", () => {
    const result = extractKnowledgeFromReport({
      view: view("向量库 A 的召回率优于 B[^c1]。生态成熟度上 B 更好[^c2]。"),
      ...deps,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.status).toBe("pending");
      expect(candidate.approvedAt).toBeUndefined();
    }
  });

  it("每条候选都带 chunkId（无 provenance 的条目不该进记忆）", () => {
    const result = extractKnowledgeFromReport({
      view: view("向量库 A 的召回率优于 B[^c1]。"),
      ...deps,
    });
    for (const candidate of result.candidates) {
      expect(candidate.citationChunkIds.length).toBeGreaterThan(0);
    }
  });
});

describe("只从被引用的句子提取", () => {
  it("没有引用标记的句子一律跳过（那是模型推断，不是可溯源事实）", () => {
    const result = extractKnowledgeFromReport({
      view: view("综上所述，选型应当因地制宜。向量库 A 的召回率优于 B[^c1]。"),
      ...deps,
    });
    expect(result.candidates.map((c) => c.text)).toEqual(["向量库 A 的召回率优于 B。"]);
  });

  /// 报告落库前 citation-validator 会删掉伪造引用，但这里再核一次——
  /// 放过一条就等于把幻觉写进长期记忆。
  it("引用了报告未登记的 chunkId 的句子被丢弃", () => {
    const result = extractKnowledgeFromReport({
      view: view("这是模型编的一条引用[^不存在的id]。", ["c1"]),
      ...deps,
    });
    expect(result.candidates).toEqual([]);
    expect(result.items).toEqual([]);
  });

  it("报告缺失时返回空（未完成的会话不该产生候选）", () => {
    const empty = view("x");
    delete empty.report;
    expect(extractKnowledgeFromReport({ view: empty, ...deps })).toEqual({
      items: [],
      candidates: [],
    });
  });
});

describe("候选文本清洗", () => {
  it("剥掉引用标记，留下干净可读的一句话", () => {
    const result = extractKnowledgeFromReport({
      view: view("向量库 A 的召回率优于 B[^c1]。"),
      ...deps,
    });
    expect(result.candidates[0]!.text).toBe("向量库 A 的召回率优于 B。");
    expect(result.candidates[0]!.text).not.toContain("[^");
  });

  it("剥掉 Markdown 结构符号（候选里不该出现 ## 与列表符）", () => {
    const result = extractKnowledgeFromReport({
      view: view("## 小节标题\n\n- **向量库 A** 的召回率优于 B[^c1]。"),
      ...deps,
    });
    const text = result.candidates[0]!.text;
    expect(text).not.toContain("#");
    expect(text).not.toContain("**");
    expect(text.startsWith("-")).toBe(false);
  });

  it("过短的片段跳过（标题残片、连接词）", () => {
    const result = extractKnowledgeFromReport({ view: view("好[^c1]。"), ...deps });
    expect(result.candidates).toEqual([]);
  });

  it("过长的句子跳过（记忆是每轮常驻开销，单条太长会挤掉其它记忆）", () => {
    const long = `${"长".repeat(300)}[^c1]。`;
    expect(extractKnowledgeFromReport({ view: view(long), ...deps }).candidates).toEqual([]);
  });

  it("同一句话出现两次（摘要 + 正文）只产出一条候选", () => {
    const result = extractKnowledgeFromReport({
      view: view("向量库 A 的召回率优于 B[^c1]。\n\n向量库 A 的召回率优于 B[^c1]。"),
      ...deps,
    });
    expect(result.candidates).toHaveLength(1);
  });
});

describe("知识条目", () => {
  it("subject 取研究目标（UI 按它聚合）", () => {
    const result = extractKnowledgeFromReport({
      view: view("向量库 A 的召回率优于 B[^c1]。"),
      ...deps,
    });
    expect(result.items[0]!.subject).toBe("调研向量数据库选型");
  });

  it("多条引用支撑 → high；单条 → medium", () => {
    const result = extractKnowledgeFromReport({
      view: view("两个来源都说 A 更好[^c1][^c2]。只有一个来源说 B 更快[^c1]。"),
      ...deps,
    });
    expect(result.items[0]!.confidence).toBe("high");
    expect(result.items[1]!.confidence).toBe("medium");
  });

  it("候选与知识条目一一对应（knowledgeId 可回查）", () => {
    const result = extractKnowledgeFromReport({
      view: view("向量库 A 的召回率优于 B[^c1]。生态成熟度上 B 更好[^c2]。"),
      ...deps,
    });
    expect(result.candidates).toHaveLength(result.items.length);
    for (const candidate of result.candidates) {
      expect(result.items.some((item) => item.knowledgeId === candidate.knowledgeId)).toBe(true);
    }
  });
});

describe("数量上限", () => {
  it("单次沉淀不超过上限（一屏读不完的待批清单等于没有审批）", () => {
    const many = Array.from({ length: 40 }, (_v, i) => `这是第 ${i} 条可引用的研究结论[^c1]。`).join(
      "\n\n",
    );
    const result = extractKnowledgeFromReport({ view: view(many), ...deps });
    expect(result.candidates).toHaveLength(MAX_MEMORY_CANDIDATES_PER_SESSION);
    expect(result.items).toHaveLength(MAX_MEMORY_CANDIDATES_PER_SESSION);
  });
});
