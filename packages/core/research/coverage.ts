// CRE 覆盖度评估与停止判定（spec §10.2、§8.1）。
//
// 这里回答两个问题：「每个子问题研究够了吗」和「整轮循环该不该停」。两者都必须是
// **纯函数、可解释、可回放**的——Gap Planner 是 LLM，它只被允许在这些确定性结论之上
// 决定「下一步搜什么」，绝不能由它自己宣布「我觉得研究够了」。
//
// 独立来源计数的两条关键规则（否则「一篇稿子被转载十次」会被算成十个来源）：
// 1. 同一重复簇（duplicateOf 指向同一代表文档）只算一个来源；
// 2. 同一 authorityGroup 的镜像域名只算一个独立域名（缺省时退化为 domain 本身）。
//
// 命名风格：TS 领域模型，camelCase。

import type { SourceType } from "./evidence";
import type {
  CompletionCriteria,
  CoverageReport,
  ResearchBudget,
  ResearchSubquestion,
} from "./types";

/// 参与覆盖度计算的最小 chunk 投影。刻意不接收 EvidenceChunk 全量结构：
/// 评估只需要「归属哪个文档」和「与各子问题的相关性」，不需要正文，
/// 这样这一层永远不可能把证据正文泄漏到日志或模型里。
export interface CoverageChunkInput {
  chunkId: string;
  documentId: string;
  /// key 是 ResearchSubquestion.id，value 是 0~1 的相关性。
  subquestionScores: Record<string, number>;
}

/// 参与覆盖度计算的最小文档投影。
export interface CoverageDocumentInput {
  documentId: string;
  domain: string;
  sourceType?: SourceType;
  /// 命中重复簇时指向代表文档；链式指向会被收敛到最终代表。
  duplicateOf?: string;
  /// 同一组织的镜像站点归为同一权威组；缺省时按 domain 计。
  authorityGroup?: string;
}

/// 已识别的矛盾证据（同一子问题下互相冲突的 chunk 组）。
export interface CoverageContradiction {
  subquestionId: string;
  chunkIds: string[];
}

/// evaluateCoverage 的入参。
export interface CoverageInput {
  subquestions: ResearchSubquestion[];
  criteria: CompletionCriteria;
  chunks: CoverageChunkInput[];
  documents: CoverageDocumentInput[];
  contradictions?: CoverageContradiction[];
}

/// 已消耗的非时间类预算。decideStop 用它判断「预算用尽」。
/// 与 ResearchBudget 的字段一一对应，缺省项表示「调用方没有统计，不参与判定」。
export interface ResearchUsage {
  queries?: number;
  candidates?: number;
  documents?: number;
  browserFetches?: number;
  evidenceCharsToModel?: number;
}

/// averageRelevance 保留 4 位小数：浮点求和会产生 0.6000000000000001 这类噪声，
/// 它会污染快照测试与 UI 展示，而覆盖度判定本身根本不需要那么高精度。
const RELEVANCE_PRECISION = 4;

/// 收敛 duplicateOf 链，得到重复簇的代表文档 id。带步数上限，防止脏数据里的环导致死循环。
function resolveRepresentative(documentId: string, byId: Map<string, CoverageDocumentInput>): string {
  let current = documentId;
  for (let hops = 0; hops < 32; hops += 1) {
    const next = byId.get(current)?.duplicateOf;
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/// 计算单个子问题的覆盖度。
function evaluateSubquestion(
  subquestion: ResearchSubquestion,
  input: CoverageInput,
  byId: Map<string, CoverageDocumentInput>,
): CoverageReport {
  const { criteria } = input;

  // 只有达到相关性下限的 chunk 才算「支撑这个子问题」，低分 chunk 不参与任何计数
  const relevant = input.chunks
    .map((chunk) => ({ chunk, score: chunk.subquestionScores[subquestion.id] ?? 0 }))
    .filter((entry) => entry.score >= criteria.minimumRelevance && entry.score > 0);

  const representatives = new Set<string>();
  const authorities = new Set<string>();
  const primaries = new Set<string>();

  for (const { chunk } of relevant) {
    const representativeId = resolveRepresentative(chunk.documentId, byId);
    representatives.add(representativeId);
    const document = byId.get(representativeId);
    // documents 里查不到时退化为按 documentId 计一个独立来源：宁可少合并，也不要凭空丢来源
    authorities.add(document?.authorityGroup ?? document?.domain ?? representativeId);
    if (document?.sourceType === "primary") primaries.add(representativeId);
  }

  const contradictionCount = (input.contradictions ?? []).filter(
    (item) => item.subquestionId === subquestion.id,
  ).length;

  const averageRelevance =
    relevant.length === 0
      ? 0
      : Number(
          (relevant.reduce((sum, entry) => sum + entry.score, 0) / relevant.length).toFixed(
            RELEVANCE_PRECISION,
          ),
        );

  const bestChunkIds = [...relevant]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.chunk.chunkId);

  const sourceCount = representatives.size;
  const independentDomainCount = authorities.size;
  const primarySourceCount = primaries.size;

  const missing: string[] = [];
  if (sourceCount === 0) {
    missing.push("尚无任何相关来源");
  } else {
    if (sourceCount < criteria.minSourcesPerSubquestion) {
      missing.push(`独立来源不足（${sourceCount}/${criteria.minSourcesPerSubquestion}）`);
    }
    if (independentDomainCount < criteria.minIndependentDomains) {
      missing.push(`独立域名不足（${independentDomainCount}/${criteria.minIndependentDomains}）`);
    }
    if (criteria.requirePrimarySource && primarySourceCount === 0) {
      missing.push("缺少一手来源");
    }
    if (criteria.requireContradiction && contradictionCount === 0) {
      missing.push("缺少交叉验证或反面证据");
    }
  }

  const status: CoverageReport["status"] =
    sourceCount === 0 ? "missing" : missing.length > 0 ? "weak" : "sufficient";

  return {
    subquestionId: subquestion.id,
    status,
    sourceCount,
    independentDomainCount,
    primarySourceCount,
    contradictionCount,
    averageRelevance,
    bestChunkIds,
    missing,
  };
}

/// 逐个子问题产出覆盖度报告（顺序与入参一致，便于 UI 稳定渲染）。
export function evaluateCoverage(input: CoverageInput): CoverageReport[] {
  const byId = new Map(input.documents.map((document) => [document.documentId, document]));
  return input.subquestions.map((subquestion) => evaluateSubquestion(subquestion, input, byId));
}

/// decideStop 的入参。usage 可选：调用方统计了多少就传多少，没传的维度不参与判定。
export interface StopDecisionInput {
  coverage: CoverageReport[];
  roundsUsed: number;
  budget: ResearchBudget;
  elapsedMs: number;
  usage?: ResearchUsage;
}

/// 停止判定结果。reason 是 zh-Hans 人类可读文案，会进 Session 记录与 UI。
export interface StopDecision {
  stop: boolean;
  reason: string;
}

/// 非时间类预算的判定表。放成数据而不是一串 if，是为了新增预算维度时只改一行。
const BUDGET_GATES: ReadonlyArray<{
  label: string;
  used: (usage: ResearchUsage) => number | undefined;
  limit: (budget: ResearchBudget) => number;
}> = [
  // 只有文档数是“后续搜索和抓取都没有意义”的全局硬门。
  // 查询/候选耗尽仍可 fetch_more，Browser 耗尽仍可 HTTP 抓取，报告字符数只约束最终 prompt。
  { label: "文档数", used: (u) => u.documents, limit: (b) => b.maxDocuments },
];

/// 判断编排循环是否该停止（spec §8.1）。
///
/// 判定顺序刻意是「达标 → 轮数 → 时长 → 其它预算」：达标是最好的结局，即使同时也用满了
/// 轮数，也应当告诉用户「研究完成」而不是「轮数耗尽」。
///
/// 注意 coverage 为空数组时**不**视为达标：那是「还没评估过」而非「全部满足」，
/// 空集合上的全称量词恒真会让首轮直接停在零证据状态。
export function decideStop(input: StopDecisionInput): StopDecision {
  const { coverage, roundsUsed, budget, elapsedMs } = input;

  if (coverage.length > 0 && coverage.every((report) => report.status === "sufficient")) {
    return { stop: true, reason: "全部子问题覆盖度已达标" };
  }

  if (roundsUsed >= budget.maxRounds) {
    return { stop: true, reason: `轮数已用尽（${roundsUsed}/${budget.maxRounds}）` };
  }

  if (elapsedMs >= budget.maxDurationMs) {
    const used = Math.round(elapsedMs / 1000);
    const limit = Math.round(budget.maxDurationMs / 1000);
    return { stop: true, reason: `时长已用尽（${used}/${limit} 秒）` };
  }

  const usage = input.usage ?? {};
  for (const gate of BUDGET_GATES) {
    const used = gate.used(usage);
    const limit = gate.limit(budget);
    if (used !== undefined && used >= limit) {
      return { stop: true, reason: `预算已用尽（${gate.label} ${used}/${limit}）` };
    }
  }

  return { stop: false, reason: "仍有子问题未达标，可继续下一轮" };
}
