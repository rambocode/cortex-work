// 确定性证据报告生成器（P5 版）。
//
// **本阶段刻意不接 LLM**：U5 的范围是"Search → Candidate → Worker → Evidence → Citation"的
// 单轮闭环，报告生成器（spec §10.4 的 LLM Report Generator）属于 U7。在它到位之前，
// 用一个纯函数把证据按子问题排版成带引用的摘要——它天然满足"每条事实都有引用"，
// 也让 Citation Validator 的链路在 P5 就能被端到端验证。
//
// 接 LLM 之后本文件仍有用：它是 Report Generator 失败/被取消时的降级产物。
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type { ResearchPlan } from "@cortex-work/core/research/types";

/// 单条证据摘录的字符上限。报告是给人读的索引，不是正文副本；
/// 全文照搬会让 markdown 膨胀到几百 KB，也会把正文原样带进后续的模型上下文。
const MAX_EXCERPT_CHARS = 320;

/// 每个子问题最多列出的证据条数。
const MAX_CHUNKS_PER_SUBQUESTION = 5;

/// 报告生成入参。
export interface EvidenceReportInput {
  plan: ResearchPlan;
  chunks: readonly EvidenceChunk[];
  documents: readonly ResearchDocument[];
  /// 出站证据字符总闸门（取 budget.maxEvidenceCharsToModel）。缺省取计划里的预算值。
  maxEvidenceChars?: number;
}

/// 生成带引用标记的 markdown。引用语法与 core/research/citation 的 `[^chunkId]` 一致——
/// 两边不一致会导致所有引用被当成伪造删掉。
export function buildEvidenceReport(input: EvidenceReportInput): string {
  const budget = input.maxEvidenceChars ?? input.plan.budget.maxEvidenceCharsToModel;
  const documentById = new Map(input.documents.map((document) => [document.documentId, document]));

  const lines: string[] = [
    `# ${input.plan.objective}`,
    "",
    "## 执行摘要",
    "",
    "- 当前报告由确定性证据摘要器生成，仅整理可回溯证据，不补写模型推断。",
    `- 研究计划包含 ${input.plan.subquestions.length} 个子问题，当前有 ${input.documents.length} 篇已抓取文档和 ${input.chunks.length} 个证据片段。`,
    "",
    "## 研究范围与方法",
    "",
    "- 方法：按子问题相关性排序证据，并为每条摘录保留片段级引用。",
    `- 证据字符预算：${budget}。`,
    "",
  ];
  let spent = 0;

  for (const subquestion of input.plan.subquestions) {
    lines.push(`## ${subquestion.text}`, "");

    const relevant = input.chunks
      .map((chunk) => ({ chunk, score: chunk.subquestionScores[subquestion.id] ?? 0 }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId))
      .slice(0, MAX_CHUNKS_PER_SUBQUESTION);

    let listed = 0;
    for (const { chunk } of relevant) {
      const excerpt = excerptOf(chunk.text);
      // 预算闸门：超出后停止追加，但**不静默截断已写出的句子**——半句话配一个引用会
      // 让读者以为来源支持了一个残缺的断言。
      if (spent + excerpt.length > budget) break;
      spent += excerpt.length;
      listed += 1;

      const document = documentById.get(chunk.documentId);
      const origin = document ? `（来源：${document.title}）` : "";
      lines.push(`- ${excerpt}[^${chunk.chunkId}]${origin}`);
    }

    if (listed === 0) lines.push("未找到可引用的证据。");
    lines.push("");
  }

  lines.push(
    "## 综合分析与争议",
    "",
    "- 确定性降级模式不执行跨来源推理；请结合各子问题证据检查一致结论与冲突。",
    "",
    "## 关键洞察与应用建议",
    "",
    "- 当前产物可作为证据索引；恢复可用研究模型后，可重新生成完整分析和行动建议。",
    "",
    "## 局限与待验证问题",
    "",
    "- 未找到证据的子问题仍需补充检索。",
    "- 当前摘要不把搜索候选或无引用内容当作研究结论。",
    "",
    "## 结论",
    "",
    "- 本报告保留了现有证据链，但未替代完整的模型综合分析。",
    "",
  );

  return lines.join("\n").trimEnd() + "\n";
}

/// 摘录：压掉换行并截断到上限。压换行是因为列表项里的裸换行会破坏 markdown 结构，
/// 进而让 Citation Validator 的段落划分错位。
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_EXCERPT_CHARS ? flat : `${flat.slice(0, MAX_EXCERPT_CHARS)}…`;
}
