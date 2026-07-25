// Coverage 的薄封装：把仓储领域对象投影成 core 纯函数的最小入参（spec §10.2）。
//
// 为什么要这层：core 的 evaluateCoverage 刻意只接收 { chunkId, documentId, subquestionScores }
// 与 { documentId, domain, sourceType, duplicateOf } —— 它**永远拿不到正文**，
// 从结构上杜绝了覆盖度计算把证据正文泄漏到日志或模型里。投影的责任因此落在 main 侧。
import { evaluateCoverage, type CoverageContradiction } from "@cortex-work/core/research/coverage";
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type {
  CompletionCriteria,
  CoverageReport,
  ResearchSubquestion,
} from "@cortex-work/core/research/types";

/// 评估入参：直接收仓储里的领域对象，投影在内部完成。
export interface SessionCoverageInput {
  subquestions: readonly ResearchSubquestion[];
  criteria: CompletionCriteria;
  chunks: readonly EvidenceChunk[];
  documents: readonly ResearchDocument[];
  contradictions?: readonly CoverageContradiction[];
}

/// 评估本 Session 当前证据的覆盖度。
export function evaluateSessionCoverage(input: SessionCoverageInput): CoverageReport[] {
  return evaluateCoverage({
    subquestions: [...input.subquestions],
    criteria: input.criteria,
    chunks: input.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      subquestionScores: chunk.subquestionScores,
    })),
    documents: input.documents.map((document) => {
      const projected: {
        documentId: string;
        domain: string;
        sourceType?: ResearchDocument["source"]["sourceType"];
        duplicateOf?: string;
      } = {
        documentId: document.documentId,
        // 域名缺失时从 locator 反推：所有文档落进同一个空字符串桶会让
        // independentDomainCount 恒为 1，多样性判定形同虚设。
        domain: document.source.domain ?? hostnameOf(document.source.locator),
      };
      if (document.source.sourceType !== undefined) projected.sourceType = document.source.sourceType;
      if (document.duplicateOf !== undefined) projected.duplicateOf = document.duplicateOf;
      return projected;
    }),
    ...(input.contradictions ? { contradictions: [...input.contradictions] } : {}),
  });
}

/// 从 locator 取主机名；不是 URL（本地文件 / memory id）时原样返回，
/// 至少保证不同来源落进不同的桶。
function hostnameOf(locator: string): string {
  try {
    return new URL(locator).hostname;
  } catch {
    return locator;
  }
}
