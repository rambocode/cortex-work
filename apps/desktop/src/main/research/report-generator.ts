// LLM 报告生成器（spec §10.4）：把已提交的证据交给模型写成带引用的 Markdown。
//
// 三条约束，每条都有对应的结构性保证而不只是提示词约定：
//
// 1. **只有允许出站的 chunk 进 prompt**：逐来源过 canSendToCloudModel（来源级零信任闸门，
//    memory / local_file / 未批准的来源被剔除；文档元数据缺失时 fail-closed）。
//    这条闸门与「用户选了哪个模型」正交——它回答的是「这份数据本身允不允许被送进模型」。
// 2. **无工具**：模型经 ResearchModelGateway 调用，它的请求体里没有 tools/functions，
//    因此不存在网络、终端、文件写入或 Browser 能力（spec §6.1 第 4 条）。
// 3. **产物必过 Citation Validator**：未知 chunkId 被物理删除，失去支撑的事实段标 unsupported。
//    这里先校验一次是因为**本文件是 LLM 输出进入系统的边界**；编排层落库前还会再校验一次，
//    两次都是纯函数、幂等，重复执行的代价可以忽略，而少任何一次都会留下伪造引用的窗口。
//
// 降级：模型不可用 / 调用失败 / 返回空内容时，回落到 P5 的确定性证据摘要（report-builder）。
// 报告可以没有 LLM 润色，但不能没有——用户已经花了时间与带宽抓取证据，
// 一个「报告生成失败」的空 Session 是最差的结局。
import { canSendToCloudModel } from "@cortex-work/core/research/trust-policy";
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type {
  ResearchBudget,
  ResearchPlan,
  ResearchReport,
  ResearchSubquestion,
} from "@cortex-work/core/research/types";
import { validateResearchReport } from "./citation-validator";
import type { ModelGatewayLike } from "./planner/initial-planner";
import { REPORT_SYSTEM_PROMPT, buildReportUserPrompt } from "./planner/prompts";
import { buildEvidenceReport } from "./report-builder";

/// 单条证据摘录的出站字符上限。与 report-builder 的口径一致：
/// 报告是索引不是正文副本，整段原文进 prompt 只会烧 token 并放大出站面。
const MAX_EXCERPT_CHARS = 600;

/// 每个子问题最多送进模型的证据条数，按模式分档。
///
/// **必须和输出预算一起放大**：模型手上只有 8 条摘录时，让它写 9000 字只会得到注水——
/// 「报告变长」会变成幻觉而不是信息量增加。输入材料量与输出长度是同一个旋钮的两端。
///
/// 上界仍受 maxEvidenceCharsToModel 约束（网关的 truncatePrompt 会截），
/// 所以这里放宽不会突破出站字符闸门，只是让 deep 模式真的用得上它那 120k 的额度。
const MAX_CHUNKS_BY_MODE = {
  quick: 8,
  standard: 16,
  deep: 28,
} as const;

/// 由 budget 反推模式档位。
///
/// budget 里没有 mode 字段，而 maxEvidenceCharsToModel 是唯一能区分三档的量
/// （quick 20k / standard 60k / deep 120k）。阈值取两档中点，用户手动覆盖过预算时
/// 也能落到最接近的一档。
function tierOf(budget: ResearchBudget): keyof typeof MAX_CHUNKS_BY_MODE {
  const chars = budget.maxEvidenceCharsToModel;
  return chars >= 90_000 ? "deep" : chars >= 40_000 ? "standard" : "quick";
}

/// 报告输出的 token 预算。
///
/// **为什么不是一个固定值**：输入侧的 `maxEvidenceCharsToModel` 按模式分档
/// （quick 20k / standard 60k / deep 120k 字符），输出侧却固定 3000 token 的话，
/// deep 模式会「读了 6 倍的材料、写出同样长度的报告」——用户看到的就是一份覆盖不全的摘要。
/// 输入输出必须同向缩放。
///
/// 分档取值：约等于中文 2500 / 5000 / 9000 字。中文大致 1 字 ≈ 1 token，
/// 再乘 1.5 的余量给 markdown 结构与 `[^chunkId]` 引用标记（后者在长报告里能占到 5% 以上）。
const REPORT_MAX_TOKENS_BY_MODE = {
  quick: 4_000,
  standard: 8_000,
  deep: 14_000,
} as const;

/// 输出预算的硬上限。
///
/// 存在的理由：`output.maxWords` 来自调用方（consumer 预设或用户），一个畸形的大值
/// （手滑多打几个 0）会让单次调用烧穿配额甚至触发供应商限流。夹在这里，方向永远偏向可控。
const REPORT_MAX_TOKENS_CEILING = 32_000;

/// 中文场景下「字 → token」的换算余量。1 字 ≈ 1 token，×1.5 覆盖 markdown 结构与引用标记。
const WORDS_TO_TOKENS_RATIO = 1.5;

/// 依据「用户要多长」与「本次模式喂了多少材料」推导输出 token 预算。
///
/// 优先用 `output.maxWords`：它在 core 的类型与 consumer 预设里一直存在（report 预设写的是
/// 3000 words），但此前**从没有人消费它**——用户/预设指定的长度被静默忽略。
/// 缺省时按模式分档，与输入侧的缩放保持同向。
export function resolveReportMaxTokens(input: {
  output?: { maxWords?: number };
  budget: ResearchBudget;
}): number {
  const words = input.output?.maxWords;
  if (typeof words === "number" && Number.isFinite(words) && words > 0) {
    return Math.min(REPORT_MAX_TOKENS_CEILING, Math.ceil(words * WORDS_TO_TOKENS_RATIO));
  }
  // 没有 maxWords 时按模式分档，与输入侧同向缩放（档位判定见 tierOf）。
  return REPORT_MAX_TOKENS_BY_MODE[tierOf(input.budget)];
}

/// 报告生成入参。
export interface ReportGenerationInput {
  objective: string;
  /// 分节依据；缺省时全部证据放在一节里。
  subquestions?: readonly ResearchSubquestion[];
  chunks: readonly EvidenceChunk[];
  /// 用于回填引用元数据（标题 / URL / 抓取时间）。缺失的文档对应的引用会被丢弃。
  documents?: readonly ResearchDocument[];
  budget: ResearchBudget;
  /// 输出要求（格式 / 目标字数 / 是否强制引用）。maxWords 决定输出 token 预算，
  /// 见 resolveReportMaxTokens。
  output?: { format?: string; maxWords?: number; requireCitations?: boolean };
  /// 报告时间戳；缺省取 deps.now()。
  generatedAt?: string;
  signal?: AbortSignal;
}

/// 报告生成依赖。
export interface ReportGeneratorDeps {
  gateway: ModelGatewayLike;
  now?: () => Date;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 生成最终报告（已完成引用校验，可直接落库）。
export async function generateReport(
  input: ReportGenerationInput,
  deps: ReportGeneratorDeps,
): Promise<ResearchReport> {
  const generatedAt = input.generatedAt ?? (deps.now ?? (() => new Date()))().toISOString();
  const sections = buildSections(input);
  const markdown = await requestMarkdown(input, deps, sections);

  return validateResearchReport({
    markdown,
    chunks: input.chunks,
    documents: input.documents ?? [],
    generatedAt,
  }).report;
}

/// 一节 = 一个子问题 + 它下面允许出站的证据。
interface ReportSection {
  heading: string;
  chunks: EvidenceChunk[];
}

/// 按子问题分节，并在此处完成**出站过滤**：逐来源过 canSendToCloudModel。
///
/// 这道闸门是**来源级**的（memory / local_file / 未批准的来源被剔除，见 spec §19.3.3），
/// 与「用户为研究选了哪个模型」无关——后者决定数据去哪，前者决定这份数据允不允许被送进模型。
///
/// 已知取舍：所选模型在本机时，理论上连 memory / local_file 的正文也可以放行
/// （数据根本没离开设备）。这里**不做这个放宽**，因为 M1 的 deep research 只有 public_web
/// 一种来源，那条分支现在是死代码；等 local_file / memory 来源真正落地时，再按网关选型的
/// isLocal 有条件放宽，届时才有真实场景可验证。
function buildSections(input: ReportGenerationInput): ReportSection[] {
  const documentById = new Map((input.documents ?? []).map((item) => [item.documentId, item]));
  const allowed = input.chunks.filter((chunk) => {
    const document = documentById.get(chunk.documentId);
    // 文档缺失时按 fail-closed 处理：拿不到来源策略就不能假定它可以出站。
    if (!document) return false;
    return canSendToCloudModel(document.policy);
  });

  const maxChunks = MAX_CHUNKS_BY_MODE[tierOf(input.budget)];
  const subquestions = input.subquestions ?? [];
  if (subquestions.length === 0) {
    return [{ heading: input.objective, chunks: rank(allowed, undefined, maxChunks) }];
  }
  return subquestions.map((subquestion) => ({
    heading: subquestion.text,
    chunks: rank(allowed, subquestion.id, maxChunks),
  }));
}

/// 按相关性排序并截断。同分时用 chunkId 兜底，保证同一输入永远得到同一 prompt
///（这也是 prompt 缓存能命中的前提）。
function rank(
  chunks: readonly EvidenceChunk[],
  subquestionId: string | undefined,
  maxChunks: number,
): EvidenceChunk[] {
  return chunks
    .map((chunk) => ({
      chunk,
      score: subquestionId ? (chunk.subquestionScores[subquestionId] ?? 0) : chunk.objectiveScore,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId))
    .slice(0, maxChunks)
    .map((entry) => entry.chunk);
}

/// 调模型拿 markdown；任何失败路径都回落到确定性摘要。
async function requestMarkdown(
  input: ReportGenerationInput,
  deps: ReportGeneratorDeps,
  sections: readonly ReportSection[],
): Promise<string> {
  const documentById = new Map((input.documents ?? []).map((item) => [item.documentId, item]));
  const titleOf = (chunk: EvidenceChunk): string =>
    documentById.get(chunk.documentId)?.title ?? "未知来源";
  const userPrompt = buildReportUserPrompt({
    objective: input.objective,
    sections: sections.map((section) => ({
      heading: section.heading,
      items: section.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        title: titleOf(chunk),
        excerpt: excerptOf(chunk.text),
      })),
    })),
  });

  const result = await deps.gateway.call({
    purpose: "report",
    systemPrompt: REPORT_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: resolveReportMaxTokens(input),
    maxPromptChars: input.budget.maxEvidenceCharsToModel,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!result.ok || result.text.trim().length === 0) {
    deps.logger?.warn(
      "[research] 报告生成降级为确定性证据摘要",
      result.ok
        ? { code: "empty_output", provider: result.providerId, model: result.model }
        : {
            code: result.code,
            message: result.message,
            provider: result.providerId,
            model: result.model,
          },
    );
    return fallbackMarkdown(input);
  }
  return result.text;
}

/// 确定性降级产物：复用 P5 的证据摘要生成器。
///
/// buildEvidenceReport 只读 plan 的 objective / subquestions / budget 三项，
/// 因此这里拼一个「够用的」ResearchPlan 即可——不去伪造 initialQueries 之类与报告无关的字段。
function fallbackMarkdown(input: ReportGenerationInput): string {
  const plan: ResearchPlan = {
    schemaVersion: 1,
    objective: input.objective,
    scope: {},
    subquestions: [...(input.subquestions ?? [{ id: "sq_1", text: input.objective }])],
    initialQueries: [],
    budget: input.budget,
    completion: {
      minSourcesPerSubquestion: 1,
      minIndependentDomains: 1,
      requirePrimarySource: false,
      requireContradiction: false,
      minimumRelevance: 0,
    },
  };
  return buildEvidenceReport({
    plan,
    chunks: input.chunks,
    documents: input.documents ?? [],
  });
}

/// 压掉换行并截断到上限（裸换行会破坏 prompt 里的列表结构）。
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= MAX_EXCERPT_CHARS ? flat : `${flat.slice(0, MAX_EXCERPT_CHARS)}…`;
}
