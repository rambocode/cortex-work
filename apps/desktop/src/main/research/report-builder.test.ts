// 确定性证据报告生成的测试（P5 无 LLM，报告即"带引用的证据摘要"）。
import { describe, expect, it } from "vitest";
import { fixtureChunk, fixtureDocument, fixturePlan } from "./repository-fixtures";
import { buildEvidenceReport } from "./report-builder";

const PLAN = fixturePlan();
const DOCUMENTS = [fixtureDocument({ documentId: "d1" })];

describe("buildEvidenceReport", () => {
  it("按子问题分节，每条证据后跟可校验的引用标记", () => {
    const markdown = buildEvidenceReport({
      plan: PLAN,
      chunks: [
        fixtureChunk({ chunkId: "c1", documentId: "d1", subquestionScores: { "sq-1": 0.9 } }),
        fixtureChunk({
          chunkId: "c2",
          documentId: "d1",
          text: "另一段证据。",
          subquestionScores: { "sq-1": 0.5 },
        }),
      ],
      documents: DOCUMENTS,
    });

    expect(markdown).toContain(`# ${PLAN.objective}`);
    expect(markdown).toContain("## node:sqlite 的 API 稳定性如何");
    expect(markdown).toContain("[^c1]");
    expect(markdown).toContain("[^c2]");
    // 高分证据排在前面
    expect(markdown.indexOf("[^c1]")).toBeLessThan(markdown.indexOf("[^c2]"));
  });

  it("没有证据的子问题显式写明，而不是留白装作已回答", () => {
    const markdown = buildEvidenceReport({ plan: PLAN, chunks: [], documents: DOCUMENTS });
    expect(markdown).toContain("未找到可引用的证据");
    expect(markdown).not.toContain("[^");
  });

  it("受 maxEvidenceChars 闸门约束，超出后不再追加证据", () => {
    const chunks = Array.from({ length: 20 }, (_, index) =>
      fixtureChunk({
        chunkId: `c${index}`,
        documentId: "d1",
        text: "证据".repeat(200),
        subquestionScores: { "sq-1": 1 - index / 100 },
      }),
    );

    const markdown = buildEvidenceReport({
      plan: PLAN,
      chunks,
      documents: DOCUMENTS,
      maxEvidenceChars: 500,
    });
    expect(markdown.length).toBeLessThan(2000);
    expect(markdown).toContain("[^c0]");
    expect(markdown).not.toContain("[^c19]");
  });

  it("单条证据被截断到摘录上限，避免整篇正文进报告", () => {
    const markdown = buildEvidenceReport({
      plan: PLAN,
      chunks: [
        fixtureChunk({ chunkId: "c1", documentId: "d1", text: "x".repeat(5000), subquestionScores: { "sq-1": 1 } }),
      ],
      documents: DOCUMENTS,
    });
    expect(markdown).toContain("…");
    expect(markdown.length).toBeLessThan(1500);
  });
});
