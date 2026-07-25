// 引用校验的薄封装（spec §10.4、§19.1.6）：core 的 validateCitations 只认 markdown +
// 已知 chunkId 集合，本文件负责把它的结论回填成可落库的 ResearchReport。
//
// 防伪造的关键在于**回填方向**：CitationRef 的 title / url / page / retrievedAt / textHash
// 一律从我们自己的证据链里取，**绝不采信模型输出里的任何字段**。模型能决定的只有
// 「引用哪个 chunkId」，其余全是我们查出来的——这样即使模型编造了一个看起来合理的
// 「来源标题 + 链接」，也进不了最终产物。
import { validateCitations } from "@cortex-work/core/research/citation";
import type { CitationRef, EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type { ResearchReport } from "@cortex-work/core/research/types";

/// 校验结果。removedChunkIds 供日志与 UI 提示"模型编了 N 条引用"。
export interface ValidatedResearchReport {
  report: ResearchReport;
  removedChunkIds: string[];
}

/// 校验入参。
export interface ValidateResearchReportInput {
  markdown: string;
  chunks: readonly EvidenceChunk[];
  documents: readonly ResearchDocument[];
  generatedAt: string;
}

/// 校验并组装最终报告。
export function validateResearchReport(input: ValidateResearchReportInput): ValidatedResearchReport {
  const chunkById = new Map(input.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const documentById = new Map(input.documents.map((document) => [document.documentId, document]));

  const result = validateCitations({
    markdown: input.markdown,
    knownChunkIds: new Set(chunkById.keys()),
  });

  const citations: CitationRef[] = [];
  for (const chunkId of result.citedChunkIds) {
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue;
    const document = documentById.get(chunk.documentId);
    // 文档缺失（被 GC / 数据不一致）时丢弃该引用：一条指不回来源的引用没有任何价值，
    // 留着反而让"每条事实都可回溯"的契约名存实亡。
    if (!document) continue;

    const citation: CitationRef = {
      chunkId,
      documentId: document.documentId,
      title: document.title,
      retrievedAt: document.fetchedAt,
      textHash: chunk.textHash,
    };
    const url = document.canonicalUrl ?? document.source.locator;
    if (url) citation.url = url;
    if (chunk.page !== undefined) citation.page = chunk.page;
    citations.push(citation);
  }

  return {
    report: {
      markdown: result.markdown,
      citations,
      // 段落标识用「校验后 markdown 的偏移区间」：删除伪造标记会让原文偏移全部失效，
      // 所以必须以清洗后的文本为坐标系（core 的 UnsupportedSpan 就是这个语义）。
      unsupportedSections: result.unsupportedSpans.map((span) => `${span.start}-${span.end}`),
      generatedAt: input.generatedAt,
    },
    removedChunkIds: result.removedChunkIds,
  };
}
