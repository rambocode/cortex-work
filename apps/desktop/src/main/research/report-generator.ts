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

/// 来源标题与正文一样是不可信网页数据。标题只用于帮助模型辨认来源，不能允许一个畸形
/// `<title>` 独占整份 prompt（真实 GitHub 页面曾产生 63k 字符标题并挤掉其余全部证据）。
const MAX_SOURCE_TITLE_CHARS = 200;

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

/// 推导本次报告的输出 token 上限。
///
/// **它是安全阀，不是篇幅指令**：报告该写多长由用户在研究目标里的表述决定
/// （"简要说明" / "详尽综述" 模型自己读得懂），配置层不预设字数——两套长度真源必然打架，
/// 而且用户改不了配置里的那套。这里只保证「不会因为一次失控生成烧穿配额」，
/// 并让上限与本次喂进去的材料量同向缩放（档位判定见 tierOf）。
export function resolveReportMaxTokens(input: { budget: ResearchBudget }): number {
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
  /// 计划要求的最低相关性；低于该值的片段不得进入报告 prompt。
  minimumRelevance?: number;
  /// 报告时间戳；缺省取 deps.now()。
  generatedAt?: string;
  signal?: AbortSignal;
  /// 正文的流式增量。传了才向网关要求流式。
  ///
  /// 只用于展示：真正落库的是下面 validateResearchReport 的产物（伪造引用已被删掉），
  /// 与流出去的草稿可能有细微差别。**降级路径不发增量**——那份摘要与草稿完全是两份东西，
  /// 边写边被替换会让用户以为报告写坏了。
  onDelta?: (delta: string) => void;
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
  // 最多允许一次质量重试，因此每次调用最多使用总出站预算的一半；两次相加仍不突破
  // ResearchBudget.maxEvidenceCharsToModel 的 Session 级硬上限。
  const promptBudgetPerCall = Math.max(
    1,
    Math.floor(input.budget.maxEvidenceCharsToModel / 2),
  );
  const prepared = buildBudgetedReportPrompt(input, sections, promptBudgetPerCall);
  const first = await requestMarkdown(
    input,
    deps,
    prepared.userPrompt,
    prepared.includedChunks,
    promptBudgetPerCall,
  );
  let promptEvidenceChars = first.promptEvidenceChars;
  let validated = validateResearchReport({
    markdown: first.markdown,
    chunks: input.chunks,
    documents: input.documents ?? [],
    generatedAt,
  }).report;

  if (hasInsufficientSourceDiversity(validated, prepared.includedChunks)) {
    // 第一份草稿已经流给 UI；重试若继续流式会把第二份完整报告直接拼在第一份后面。
    const { onDelta: _dropRetryDelta, ...retryInput } = input;
    const retried = await requestMarkdown(
      retryInput,
      deps,
      prepared.userPrompt,
      prepared.includedChunks,
      promptBudgetPerCall,
      true,
    );
    promptEvidenceChars += retried.promptEvidenceChars;
    validated = validateResearchReport({
      markdown: retried.markdown,
      chunks: input.chunks,
      documents: input.documents ?? [],
      generatedAt,
    }).report;
    if (hasInsufficientSourceDiversity(validated, prepared.includedChunks)) {
      validated = validateResearchReport({
        markdown: fallbackMarkdown({ ...input, chunks: prepared.includedChunks }),
        chunks: input.chunks,
        documents: input.documents ?? [],
        generatedAt,
      }).report;
    }
  }

  const uniqueIncludedChunks =
    promptEvidenceChars > 0
      ? new Map(prepared.includedChunks.map((chunk) => [chunk.chunkId, chunk]))
      : new Map<string, EvidenceChunk>();
  const eligibleChunkIds = new Set(
    sections.flatMap((section) => section.chunks.map((chunk) => chunk.chunkId)),
  );
  const citedDocumentIds = new Set(validated.citations.map((citation) => citation.documentId));
  const citedChunkIds = new Set(validated.citations.map((citation) => citation.chunkId));
  return {
    ...validated,
    generationStats: {
      availableDocumentCount: input.documents?.length ?? 0,
      availableChunkCount: input.chunks.length,
      includedDocumentCount: new Set(
        [...uniqueIncludedChunks.values()].map((chunk) => chunk.documentId),
      ).size,
      includedChunkCount: uniqueIncludedChunks.size,
      citedDocumentCount: citedDocumentIds.size,
      citedChunkCount: citedChunkIds.size,
      promptEvidenceChars,
      promptTruncated: uniqueIncludedChunks.size < eligibleChunkIds.size,
    },
  };
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
    return [
      {
        heading: input.objective,
        chunks: rank(allowed, undefined, maxChunks, input.minimumRelevance ?? 0),
      },
    ];
  }
  return subquestions.map((subquestion) => ({
    heading: subquestion.text,
    chunks: rank(allowed, subquestion.id, maxChunks, input.minimumRelevance ?? 0),
  }));
}

/// 按相关性排序并截断。同分时用 chunkId 兜底，保证同一输入永远得到同一 prompt
///（这也是 prompt 缓存能命中的前提）。
function rank(
  chunks: readonly EvidenceChunk[],
  subquestionId: string | undefined,
  maxChunks: number,
  minimumRelevance: number,
): EvidenceChunk[] {
  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: subquestionId ? (chunk.subquestionScores[subquestionId] ?? 0) : chunk.objectiveScore,
    }))
    .filter((entry) => entry.score > 0 && entry.score >= minimumRelevance)
    .sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId));

  // 先给每篇文档一个席位，再允许同一文档补第二个片段。否则一篇长页面很容易凭多个
  // 同分 chunk 吃完小预算，报告看似“引用很多”却没有来源多样性。
  const chunksByDocument = new Map<string, EvidenceChunk[]>();
  for (const { chunk } of ranked) {
    const bucket = chunksByDocument.get(chunk.documentId) ?? [];
    bucket.push(chunk);
    chunksByDocument.set(chunk.documentId, bucket);
  }
  const selected: EvidenceChunk[] = [];
  for (let pass = 0; pass < 2 && selected.length < maxChunks; pass += 1) {
    for (const bucket of chunksByDocument.values()) {
      const chunk = bucket[pass];
      if (!chunk) continue;
      selected.push(chunk);
      if (selected.length >= maxChunks) break;
    }
  }
  return selected;
}

/// 调模型拿 markdown；任何失败路径都回落到确定性摘要。
async function requestMarkdown(
  input: ReportGenerationInput,
  deps: ReportGeneratorDeps,
  userPrompt: string,
  fallbackChunks: readonly EvidenceChunk[],
  maxPromptChars: number,
  retryForDiversity = false,
): Promise<{ markdown: string; promptEvidenceChars: number }> {
  const result = await deps.gateway.call({
    purpose: "report",
    systemPrompt: retryForDiversity
      ? `${REPORT_SYSTEM_PROMPT}\n\n上一次报告虽然收到了多篇独立来源，却只引用了一篇。请重新撰写，并在证据支持的前提下引用至少两篇不同来源。`
      : REPORT_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: resolveReportMaxTokens(input),
    maxPromptChars,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onDelta ? { onDelta: input.onDelta } : {}),
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
    return {
      markdown: fallbackMarkdown({ ...input, chunks: fallbackChunks }),
      // no_provider_configured 在选型阶段返回，一个字节都没有出站；其它失败态按已尝试
      // 发送计账，宁可保守高估也不能悄悄突破隐私预算。
      promptEvidenceChars:
        !result.ok && result.code === "no_provider_configured"
          ? 0
          : Math.min([...userPrompt].length, maxPromptChars),
    };
  }
  return {
    markdown: result.text,
    promptEvidenceChars: Math.min([...userPrompt].length, maxPromptChars),
  };
}

/// 按“每个子问题一条，再进入下一轮”的顺序装配证据。网关的截断仍是最后安全阀，
/// 但正常报告 prompt 必须在进入网关前已经满足预算，否则尾部章节会系统性消失。
function buildBudgetedReportPrompt(
  input: ReportGenerationInput,
  sections: readonly ReportSection[],
  limit: number,
): { userPrompt: string; includedChunks: EvidenceChunk[] } {
  type PromptItem = { chunkId: string; title: string; excerpt: string };
  const documentById = new Map((input.documents ?? []).map((item) => [item.documentId, item]));
  const titleOf = (chunk: EvidenceChunk): string =>
    excerptTitle(documentById.get(chunk.documentId)?.title ?? "未知来源");
  const selected: PromptItem[][] = sections.map(() => []);
  const selectedChunks: EvidenceChunk[][] = sections.map(() => []);
  const render = (): string =>
    buildReportUserPrompt({
      objective: input.objective,
      sections: sections.map((section, index) => ({
        heading: section.heading,
        items: selected[index] ?? [],
      })),
    });

  const maxDepth = Math.max(0, ...sections.map((section) => section.chunks.length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const chunk = sections[sectionIndex]?.chunks[depth];
      if (!chunk) continue;
      const bucket = selected[sectionIndex]!;
      const chunkBucket = selectedChunks[sectionIndex]!;
      bucket.push({
        chunkId: chunk.chunkId,
        title: titleOf(chunk),
        excerpt: excerptOf(chunk.text),
      });
      chunkBucket.push(chunk);
      if ([...render()].length > limit) {
        bucket.pop();
        chunkBucket.pop();
      }
    }
  }
  return { userPrompt: render(), includedChunks: selectedChunks.flat() };
}

function hasInsufficientSourceDiversity(
  report: ResearchReport,
  includedChunks: readonly EvidenceChunk[],
): boolean {
  const availableDocuments = new Set(includedChunks.map((chunk) => chunk.documentId));
  if (availableDocuments.size < 2) return false;
  return new Set(report.citations.map((citation) => citation.documentId)).size < 2;
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

function excerptTitle(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const points = [...flat];
  return points.length <= MAX_SOURCE_TITLE_CHARS
    ? flat
    : `${points.slice(0, MAX_SOURCE_TITLE_CHARS).join("")}…`;
}
