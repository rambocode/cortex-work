// 引用校验薄封装的测试：伪造引用被删、CitationRef 从证据链回填、无支撑段落被标记。
import { describe, expect, it } from "vitest";
import { fixtureChunk, fixtureDocument } from "./repository-fixtures";
import { validateResearchReport } from "./citation-validator";

const DOCUMENTS = [fixtureDocument({ documentId: "d1" })];
const CHUNKS = [fixtureChunk({ chunkId: "c1", documentId: "d1" })];

describe("validateResearchReport", () => {
  it("保留已知引用并回填 CitationRef（标题/URL/页码/时间来自证据链，不信模型）", () => {
    const { report } = validateResearchReport({
      markdown: "node:sqlite 仍是实验特性[^c1]。",
      chunks: CHUNKS,
      documents: DOCUMENTS,
      generatedAt: "2026-07-25T00:05:00.000Z",
    });

    expect(report.citations).toEqual([
      {
        chunkId: "c1",
        documentId: "d1",
        title: "node:sqlite docs",
        url: "https://nodejs.org/api/sqlite.html",
        page: 1,
        retrievedAt: "2026-07-25T00:01:30.000Z",
        textHash: CHUNKS[0]!.textHash,
      },
    ]);
    expect(report.markdown).toContain("[^c1]");
    expect(report.unsupportedSections).toEqual([]);
  });

  it("未知 chunkId 的伪造引用被物理删除，段落被标为 unsupported（§19.1.6）", () => {
    const { report, removedChunkIds } = validateResearchReport({
      markdown: "地球是平的[^forged]。",
      chunks: CHUNKS,
      documents: DOCUMENTS,
      generatedAt: "2026-07-25T00:05:00.000Z",
    });

    expect(removedChunkIds).toEqual(["forged"]);
    expect(report.markdown).not.toContain("forged");
    expect(report.citations).toEqual([]);
    expect(report.unsupportedSections).toHaveLength(1);
    // 段落标识是「校验后 markdown 的偏移区间」，UI 据此精确高亮。
    expect(report.unsupportedSections[0]).toMatch(/^\d+-\d+$/);
  });

  it("引用指向的文档缺失时该引用被丢弃（不留悬空 CitationRef）", () => {
    const { report } = validateResearchReport({
      markdown: "一句话[^c1]。",
      chunks: CHUNKS,
      documents: [],
      generatedAt: "2026-07-25T00:05:00.000Z",
    });
    expect(report.citations).toEqual([]);
  });
});
