// 单轮研究编排（spec §9、§10、U5）：plan(可选) → search → selectCandidates →
// worker.fetch_prepare → evidence → citation。
//
// 三条硬约束，改这个文件前先读一遍：
//
// 1. **状态推进必须过 canTransition**（SessionStateWriter）。非法转移抛错而不是静默写库——
//    一个悄悄从 completed 跳回 searching 的 Session 会让证据的因果链彻底不可信。
// 2. **每次外部调用都包在 runOperation 里**（spec §9.1）：pending → 调用 → 校验 → 单事务写入
//    → 标记 committed。apply 是同步的，所以一切异步准备工作（写 blob、算 coverage）
//    都必须在 execute 阶段做完。
// 3. **取消后终态必须是 cancelled**（spec §19.1.3），不管取消发生在 search / fetch / report
//    哪个阶段；已提交的证据一条都不能丢。
//
// P7 起本文件是**多轮**编排：plan → [search → fetch → evaluate → decide]* → report。
// 三个模型相关的能力全部是注入点（deps.planInitial / deps.planGap / deps.generateReport），
// 缺省时退化成 P5 的确定性行为（种子计划 + 单轮 + 证据摘要）——编排骨架不依赖 LLM 可用。
import { SEARCH_LIMITS, buildSearchBatchRequest } from "@cortex-work/core/research/search-api";
import { decideStop } from "@cortex-work/core/research/coverage";
import type { SearchBatchRequest, SearchBatchResponse } from "@cortex-work/core/research/search-api";
import { clampResearchBudget } from "@cortex-work/core/research/budget";
import { canonicalizeUrl } from "@cortex-work/core/research/url-safety";
import { needsStealthFetch } from "@cortex-work/core/research/stealth-domains";
import { DEFAULT_SOURCE_POLICIES } from "@cortex-work/core/research/trust-policy";
import type { EvidenceChunk, ResearchDocument, SearchCandidate } from "@cortex-work/core/research/evidence";
import type { WORKER_RESULT_SCHEMAS, WorkerMethod } from "@cortex-work/core/research/protocol";
import type {
  CoverageReport,
  PlannedQuery,
  PlannerDecision,
  ResearchActivityEvent,
  ResearchBudget,
  ResearchEvent,
  ResearchMode,
  ResearchPlan,
  ReportGenerationStats,
  ResearchRound,
  ResearchSessionView,
} from "@cortex-work/core/research/types";
import type { z } from "zod";
import { selectCandidates, toSearchCandidates } from "./candidate-selector";
import { validateResearchReport, type ValidatedResearchReport } from "./citation-validator";
import { evaluateSessionCoverage } from "./coverage-evaluator";
import { OperationCancelledError, runOperation } from "./operation-runner";
import { buildEvidenceReport } from "./report-builder";
import type { ResearchRepository } from "./research-repository";
import { SessionStateWriter } from "./session-state";
import {
  mapFetchPrepareResult,
  toWorkerCandidates,
  type MappedFetchResult,
  type WorkerFetchPrepareParams,
  type WorkerFetchPrepareResult,
} from "./worker-mapping";

/// Worker 单次抓取允许的总字节数（50 MiB）。协议要求 main 下发硬上限，
/// Worker 侧也会自行强制一遍（不能假设对方已经夹过）。
const MAX_TOTAL_FETCH_BYTES = 50 * 1024 * 1024;

/// 报告草稿的节流阈值：攒够 200 字或 120ms 发一条 IPC。
/// 两个条件是「或」：慢模型靠时间兜底（不会长时间不动），快模型靠字数兜底（不会刷屏）。
const DRAFT_FLUSH_CHARS = 200;
const DRAFT_FLUSH_MS = 120;

/// Gap Planner 决策的流水文案（zh-Hans，直接进 UI；UI 侧不再翻一次以免两处漂移）。
const DECISION_LABELS: Record<PlannerDecision["action"], string> = {
  search_more: "补充检索",
  fetch_more: "补充抓取",
  finish: "证据充分，收尾撰写",
};

/// 抓取并发与单请求超时。与 spec §19.4 的性能基线一致（Browser 并发另由 Worker 控制）。
const HTTP_CONCURRENCY = 6;
const PER_HOST_CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 20_000;

/// 种子计划的默认完成标准。刻意宽松：P5 只跑一轮，严格标准只会让每个子问题都显示"未达标"，
/// 反而失去信噪比。真正的多轮判定在 P7。
const SEED_COMPLETION = {
  minSourcesPerSubquestion: 2,
  minIndependentDomains: 2,
  requirePrimarySource: false,
  requireContradiction: false,
  minimumRelevance: 0.2,
} as const;

type WorkerResultOf<M extends WorkerMethod> = z.infer<(typeof WORKER_RESULT_SCHEMAS)[M]>;

/// 编排层需要的 Search Client 最小面（生产由 SearchServerClient 满足）。
export interface SearchClientLike {
  searchBatch(request: SearchBatchRequest, signal?: AbortSignal): Promise<SearchBatchResponse>;
}

/// 编排层需要的 Worker 最小面（生产由 ResearchWorkerProcess 满足）。
export interface ResearchWorkerLike {
  /// onProgress：Worker 在这次请求期间上报的进度（协议里的 type:"event"，按 operation_id 路由）。
  /// 抓取一批 URL 动辄几十秒，没有它的话 UI 只能停在「抓取中 0/N」直到整批结束。
  request<M extends WorkerMethod>(
    method: M,
    params: unknown,
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<WorkerResultOf<M>>;
}

/// 编排层需要的 blob 写入面（生产由 ResearchBlobStore 满足）。
export interface BlobWriterLike {
  putBlob(contentHash: string, text: string): Promise<string>;
}

/// 报告生成器注入点。P7 接 LLM 时替换默认实现；signal 必须被尊重，否则取消会卡在报告阶段。
export interface ReportGeneratorOutput {
  markdown: string;
  generationStats?: ReportGenerationStats;
}

export type ReportGenerator = (input: {
  plan: ResearchPlan;
  chunks: readonly EvidenceChunk[];
  documents: readonly ResearchDocument[];
  coverage: readonly CoverageReport[];
  rounds?: readonly ResearchRound[];
  signal: AbortSignal;
  /// 正文增量回调。实现方支持流式时应逐段调用；不支持就忽略（编排层只是拿不到草稿）。
  onDelta?: (delta: string) => void;
}) => Promise<string | ReportGeneratorOutput>;

/// Initial Planner 注入点（P7）。budget 是 Session 的**权威预算**，实现必须原样带回计划里。
export interface InitialPlannerInput {
  objective: string;
  mode: ResearchMode;
  budget: ResearchBudget;
  signal: AbortSignal;
}
export type InitialPlanner = (input: InitialPlannerInput) => Promise<ResearchPlan>;

/// Gap Planner 注入点（P7）。
///
/// **入参形状即隔离契约（spec §10.3、§6.1 第 2 条）**：这里只有覆盖度、已执行查询文本、
/// 剩余预算、缺口摘要和候选元数据（id/标题/域名），**没有任何网页正文、Memory 或本地路径**。
/// 想给 Gap Planner 加信息，先确认新字段不会把抓取到的正文带进模型。
export interface GapPlannerInput {
  plan: ResearchPlan;
  roundIndex: number;
  coverage: readonly CoverageReport[];
  executedQueries: readonly string[];
  remainingBudget: ResearchBudget;
  missingSummary: readonly string[];
  /// 尚未抓取的候选（只有元数据）。
  candidates: readonly { candidateId: string; title: string; domain: string }[];
  /// 允许出现在 fetch_more 里的候选 id 全集。
  knownCandidateIds: readonly string[];
  signal: AbortSignal;
}
export type GapPlanner = (input: GapPlannerInput) => Promise<PlannerDecision>;

/// 一轮的驱动方式：带着查询去搜索，或按 Gap Planner 的 fetch_more 只抓指定候选。
type RoundStep =
  | { kind: "search"; queries: readonly PlannedQuery[] }
  | { kind: "fetch"; candidateIds: readonly string[] };

interface RoundSearchResult {
  candidates: SearchCandidate[];
  queryIds: string[];
}

/// 多轮循环的跨轮内存态。
///
/// 为什么用可变对象而不是每轮重新读库：一次 run 内的轮次是连续的，重复 getSession 只会
/// 让每轮多一次全量读（含正文）。**只在事务提交成功后并入**，回滚的批次不得污染它。
/// 崩溃后这些状态会由下一次 run 的 getSession 重新装配，因此不需要持久化。
interface LoopContext {
  documents: ResearchDocument[];
  chunks: EvidenceChunk[];
  /// 本次 run 见过的全部候选（fetch_more 只能从中挑）。
  candidates: SearchCandidate[];
  /// 已执行查询的文本，供 Gap Planner 避免重复出题。
  executedQueries: string[];
  subquestionByQueryId: Map<string, string>;
  coverage: readonly CoverageReport[];
}

/// 编排器依赖。全部显式注入——这是它能在零 Electron / 零网络 / 零 SQLite 下被测的前提。
export interface OrchestratorDeps {
  repository: ResearchRepository;
  blobStore: BlobWriterLike;
  searchClient: SearchClientLike;
  worker: ResearchWorkerLike;
  /// KTD9 的隔离键，用于跨 Session 复用查询。
  userScope: string;
  now?: () => Date;
  newId?: () => string;
  emit?: (event: ResearchEvent) => void;
  /// 中止意图：cancel（默认）收敛到 cancelled，pause 收敛到 paused。
  abortIntent?: () => "cancel" | "pause";
  generateReport?: ReportGenerator;
  /// 缺省时沿用已有计划或种子计划（P5 行为）。
  planInitial?: InitialPlanner;
  /// 缺省时单轮收尾（P5 行为）：没有 Gap Planner 就没有第二轮。
  planGap?: GapPlanner;
  /// 域名黑名单（用户/企业配置）。
  blockedDomains?: readonly string[];
  /// agent-browser 绝对路径；缺省表示 Browser 降级不可用，Worker 只走 HTTP。
  agentBrowserBinary?: string;
  /// 服务端 stealth 抓取（Camoufox）。缺省 = 该路径不可用，行为与从前一致（只发一轮）。
  ///
  /// **注入的是「抓一个 URL」而不是客户端实例**：编排层不该知道凭据、baseUrl、workspaceId
  /// 的存在——那些由 runtime 装配时闭包捕获。这样编排层的测试也不必构造一个假 HTTP 服务。
  stealthFetch?: StealthFetchLike;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// stealth 抓取的最小能力。返回原始 HTML，交给 Worker 走既有抽取管线。
export interface StealthFetchLike {
  fetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; html: string; finalUrl: string }>;
}

/// 单轮编排器。一个实例可服务多个 Session（无每 Session 状态），并发由上层 service 控制。
export class ResearchOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /// 跑完一轮研究。取消是**正常结束**（不抛错），失败会写 failed 并把异常抛给调用方。
  async run(sessionId: string, signal: AbortSignal): Promise<void> {
    const view = await this.deps.repository.getSession(sessionId, "evidence");
    if (!view) throw new Error(`未知的研究 Session：${sessionId}`);

    // onStatus：每次状态落库都广播。有它之后，paused / interrupted 这些 stage 与 done
    // 都表达不了的状态也能实时到达 renderer（此前只能等下一次 list() 才看得到）。
    const state = new SessionStateWriter(this.deps.repository, sessionId, view.summary.status, {
      ...(this.deps.now ? { now: this.deps.now } : {}),
      onStatus: (status) => this.emit({ type: "status", sessionId, status }),
    });

    try {
      await this.runLoop(view, state, signal);
    } catch (err) {
      const cancelled = err instanceof OperationCancelledError || signal.aborted;
      await this.settle(state, err, cancelled);
      if (!cancelled) throw err;
    }
  }

  // ── 主流程 ────────────────────────────────────────────────────────────────

  private async runLoop(
    view: ResearchSessionView,
    state: SessionStateWriter,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionId = view.summary.sessionId;
    // 每次 run 用一个新的 runId 铸造 operation id。
    // 为什么不用「sessionId + 轮次」这种确定性 id：崩溃重启后 main 无法把上一轮的在途候选
    // 重新装配回内存（仓储没有"读候选"的接口），因此恢复只能以**新一轮**的形式续跑；
    // 已提交的证据不会重复抓取，靠的是 alreadyFetched 去重而不是 operation id 复用。
    const runId = this.newId();

    // 1. planning ──────────────────────────────────────────────────────────
    await state.to("planning");
    this.emit({ type: "stage", sessionId, stage: "planning" });
    const plan = await this.resolvePlan(view, signal);

    // 跨轮累积的内存态。**只加不改**：已提交的证据是下一轮去重、覆盖度评估与
    // Gap Planner 输入的唯一依据；崩溃后这些会由新一轮的 getSession 重新装配。
    const context: LoopContext = {
      documents: [...(view.documents ?? [])],
      chunks: [...(view.chunks ?? [])],
      candidates: [],
      executedQueries: [],
      subquestionByQueryId: new Map(
        plan.initialQueries.map((query) => [query.queryId, query.subquestionId]),
      ),
      coverage: view.coverage ?? [],
    };

    let roundIndex = view.rounds?.length ?? 0;
    let step: RoundStep = { kind: "search", queries: plan.initialQueries };
    /// 驱动本轮的决策（首轮由初始计划驱动，因此为空——与 ResearchRound.decision 的语义一致）。
    let drivingDecision: PlannerDecision["action"] | undefined;

    // 2~4. [search → fetch → evaluate] 循环 ─────────────────────────────────
    for (;;) {
      this.emit({
        type: "round",
        sessionId,
        roundIndex,
        ...(drivingDecision ? { decision: drivingDecision } : {}),
      });
      const remaining = await this.remainingBudget(sessionId, plan.budget);
      const searched = await this.runSearchPhase({
        sessionId,
        state,
        signal,
        runId,
        roundIndex,
        step,
        remaining,
        context,
      });
      await this.runFetchPhase({
        view,
        plan,
        state,
        signal,
        runId,
        roundIndex,
        step,
        remaining,
        context,
        roundCandidates: searched.candidates,
        executedQueryIds: searched.queryIds,
        ...(drivingDecision ? { drivingDecision } : {}),
      });

      // evaluating：停止判定（确定性）优先于 Gap Planner（模型）。
      // 顺序不可换——预算耗尽时不该再花一次模型调用去问「要不要继续」。
      await state.to("evaluating");
      this.emit({ type: "stage", sessionId, stage: "evaluating" });
      const decision = await this.decideNext({ sessionId, plan, context, signal });
      this.activity(sessionId, "decision", DECISION_LABELS[decision.action], roundIndex);
      if (decision.action === "finish") break;

      roundIndex += 1;
      drivingDecision = decision.action;
      step =
        decision.action === "search_more"
          ? { kind: "search", queries: decision.queries }
          : { kind: "fetch", candidateIds: decision.candidateIds };
    }

    // 5. reporting ─────────────────────────────────────────────────────────
    await state.to("reporting");
    this.emit({ type: "stage", sessionId, stage: "reporting" });
    this.activity(sessionId, "report", "开始撰写报告");
    // 重新读一次：报告要基于**已提交**的全部证据，而不是内存里这一轮的增量。
    const committed = await this.deps.repository.getSession(sessionId, "evidence");
    const chunks = committed?.chunks ?? context.chunks;
    const documents = committed?.documents ?? context.documents;
    const coverage = committed?.coverage ?? context.coverage;

    await runOperation({
      repository: this.deps.repository,
      sessionId,
      operationId: `op_${runId}_report`,
      kind: "report",
      signal,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      execute: async (innerSignal) => {
        // 报告是整个研究里最慢的一步：不把增量推出去，用户就只能盯着一个「撰写中」发呆。
        const draft = this.createDraftStream(sessionId);
        const generated = await this.generateReport({
          plan,
          chunks,
          documents,
          coverage,
          rounds: committed?.rounds ?? [],
          signal: innerSignal,
          onDelta: draft.push,
        }).finally(draft.flush);
        // 引用校验是产物落库前的最后一道闸：未知 chunkId 的伪造引用在这里被物理删除。
        const validated = validateResearchReport({
          markdown: generated.markdown,
          chunks,
          documents,
          generatedAt: this.nowIso(),
        });
        return {
          ...validated,
          report: {
            ...validated.report,
            ...(generated.generationStats
              ? { generationStats: generated.generationStats }
              : {}),
          },
        };
      },
      validate: (validated: ValidatedResearchReport) => {
        if (validated.report.markdown.trim().length === 0) throw new Error("报告正文为空");
      },
      apply: (tx, validated: ValidatedResearchReport) => {
        tx.insertReport(validated.report);
        tx.insertCitations(validated.report.citations);
        tx.consumeBudget({
          evidenceCharsToModel: validated.report.generationStats?.promptEvidenceChars ?? 0,
        });
      },
    });

    // 6. completed ─────────────────────────────────────────────────────────
    await state.to("completed");
    this.emit({ type: "done", sessionId, status: "completed" });
  }

  /// 搜索阶段。fetch_more 驱动的轮次没有新查询，直接跳过（不消耗查询预算）。
  private async runSearchPhase(input: {
    sessionId: string;
    state: SessionStateWriter;
    signal: AbortSignal;
    runId: string;
    roundIndex: number;
    step: RoundStep;
    remaining: ResearchBudget;
    context: LoopContext;
  }): Promise<RoundSearchResult> {
    const { sessionId, step, context } = input;
    if (step.kind !== "search") return { candidates: [], queryIds: [] };

    await input.state.to("searching");
    this.emit({ type: "stage", sessionId, stage: "searching" });
    const queries = step.queries.slice(0, Math.max(0, input.remaining.maxQueries));
    const allCandidates: SearchCandidate[] = [];
    const executedQueryIds: string[] = [];
    // 候选预算是全 Session 预算，不能让首轮一次吃完。按剩余轮数均摊，未用完的额度自然
    // 留到后续轮次；最后一轮 remaining.maxRounds=1 时可使用全部余量。
    let candidateSlots = Math.max(
      0,
      Math.ceil(input.remaining.maxCandidates / Math.max(1, input.remaining.maxRounds)),
    );

    // Search Server 每次最多接收 8 条查询。这里显式分批，而不是依赖 buildSearchBatchRequest
    // 静默截断；否则 UI/round 记录 16 条，线上却只执行前 8 条。
    for (let offset = 0; offset < queries.length; offset += SEARCH_LIMITS.maxQueriesPerRequest) {
      const batch = queries.slice(offset, offset + SEARCH_LIMITS.maxQueriesPerRequest);
      const batchIndex = Math.floor(offset / SEARCH_LIMITS.maxQueriesPerRequest);
      const searchRequest = buildSearchBatchRequest({
        requestId: `op_${input.runId}_r${input.roundIndex}_search_b${batchIndex}`,
        sessionId,
        queries: batch,
      });
      if (searchRequest.queries.length === 0) continue;
      const remainingQueryCount = queries.length - offset;
      const batchCandidateSlots = Math.min(
        candidateSlots,
        Math.ceil((candidateSlots * batch.length) / Math.max(1, remainingQueryCount)),
      );

      const searched = await runOperation({
        repository: this.deps.repository,
        sessionId,
        operationId: searchRequest.request_id,
        kind: "search",
        signal: input.signal,
        ...(this.deps.now ? { now: this.deps.now } : {}),
        execute: async (innerSignal) => {
          const response = await this.deps.searchClient.searchBatch(searchRequest, innerSignal);
          const candidates = takeCandidatesByQuery(
            toSearchCandidates(response, { newId: () => this.newId() }),
            batchCandidateSlots,
          );
          return { response, candidates };
        },
        validate: ({ response }) => {
          if (response.request_id !== searchRequest.request_id) {
            throw new Error("搜索响应的 request_id 与请求不一致");
          }
        },
        apply: (tx, { candidates }) => {
          tx.insertCandidates(candidates, input.roundIndex);
          tx.consumeBudget({ queries: searchRequest.queries.length, candidates: candidates.length });
        },
      });

      candidateSlots = Math.max(0, candidateSlots - searched.candidates.length);
      allCandidates.push(...searched.candidates);
      const sentIds = new Set(searchRequest.queries.map((query) => query.query_id));
      for (const query of batch) {
        if (!sentIds.has(query.queryId)) continue;
        executedQueryIds.push(query.queryId);
        context.subquestionByQueryId.set(query.queryId, query.subquestionId);
        context.executedQueries.push(query.text);
        this.activity(sessionId, "query", query.text, input.roundIndex);
      }
    }

    context.candidates.push(...allCandidates);
    return { candidates: allCandidates, queryIds: executedQueryIds };
  }

  /// 抓取阶段：选候选 → Worker → 写 blob → 单事务提交（轮次 + 文档 + chunk + 覆盖度）。
  private async runFetchPhase(input: {
    view: ResearchSessionView;
    plan: ResearchPlan;
    state: SessionStateWriter;
    signal: AbortSignal;
    runId: string;
    roundIndex: number;
    step: RoundStep;
    remaining: ResearchBudget;
    context: LoopContext;
    roundCandidates: readonly SearchCandidate[];
    executedQueryIds: readonly string[];
    drivingDecision?: PlannerDecision["action"];
  }): Promise<void> {
    const { sessionId } = input.view.summary;
    const { context, plan } = input;

    // fetch_more 的候选池来自**历史全部候选**（本轮没有搜索），search 轮只看本轮结果。
    let pool: readonly SearchCandidate[];
    if (input.step.kind === "search") {
      pool = input.roundCandidates;
    } else {
      const wanted = new Set(input.step.candidateIds);
      pool = context.candidates.filter((candidate) => wanted.has(candidate.candidateId));
    }
    const selected = selectCandidates({
      candidates: pool,
      alreadyFetched: alreadyFetchedUrls(context.documents),
      budget: input.remaining,
      subquestionByQueryId: context.subquestionByQueryId,
      prioritySubquestionIds: prioritizedSubquestions(plan, context.coverage),
      ...(this.deps.blockedDomains ? { blockedDomains: [...this.deps.blockedDomains] } : {}),
    });

    await input.state.to("fetching");
    this.emit({
      type: "stage",
      sessionId,
      stage: "fetching",
      progress: { completed: 0, total: selected.length },
    });

    const startedAt = this.nowIso();
    const fetchOperationId = `op_${input.runId}_r${input.roundIndex}_fetch`;
    const queryIds = input.step.kind === "search" ? [...input.executedQueryIds] : [];

    const fetched = await runOperation({
      repository: this.deps.repository,
      sessionId,
      operationId: fetchOperationId,
      kind: "fetch",
      signal: input.signal,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      execute: async (innerSignal) => {
        const mapped =
          selected.length === 0
            ? emptyFetchResult()
            : await this.fetchViaWorker({
                plan,
                selected,
                candidates: context.candidates,
                knownDocuments: context.documents,
                subquestionByQueryId: context.subquestionByQueryId,
                operationId: fetchOperationId,
                limits: input.remaining,
                signal: innerSignal,
                // Worker 的进度直接转成阶段进度。total 以 Worker 报的为准（它才知道
                // 自己实际在抓几个），缺失时回落到我们选中的候选数。
                onProgress: (progress) =>
                  this.emit({
                    type: "stage",
                    sessionId,
                    stage: "fetching",
                    progress: {
                      completed: progress.completed,
                      total: progress.total || selected.length,
                    },
                  }),
              });

        // 正文必须在提交**之前**落 blob：apply 是同步的，不能在事务里 await（spec §9.1）。
        // 提交失败时留下的 blob 是孤儿，由 §19.3.4 的 GC 回收，不会造成数据不一致。
        for (const document of mapped.documents) {
          const text = mapped.texts.get(document.documentId);
          if (text !== undefined) await this.deps.blobStore.putBlob(document.contentHash, text);
        }

        const coverage = evaluateSessionCoverage({
          subquestions: plan.subquestions,
          criteria: plan.completion,
          chunks: [...context.chunks, ...mapped.chunks],
          documents: [...context.documents, ...mapped.documents],
        });
        return { mapped, coverage };
      },
      validate: ({ mapped }) => {
        // 响应可信性：Worker 越过 main 下发的硬上限就是协议违规，整笔拒绝而不是截断后照收。
        if (mapped.documents.length > input.remaining.maxDocuments) {
          throw new Error("Worker 返回的文档数超过下发上限");
        }
        if (mapped.stats.browserFetches > input.remaining.maxBrowserFetches) {
          throw new Error("Worker 的 Browser 抓取次数超过下发上限");
        }
      },
      apply: (tx, { mapped, coverage }) => {
        const round: ResearchRound = {
          roundIndex: input.roundIndex,
          startedAt,
          endedAt: this.nowIso(),
          queryIds,
          candidateCount: input.roundCandidates.length,
          documentCount: mapped.documents.length,
          chunkCount: mapped.chunks.length,
          // 记录的是「驱动本轮的决策」（首轮为空），与 ResearchRound.decision 的语义一致。
          ...(input.drivingDecision ? { decision: input.drivingDecision } : {}),
        };
        tx.insertRound(round);
        tx.insertDocuments(mapped.documents);
        tx.insertChunks(mapped.chunks);
        tx.insertDuplicateClusters(mapped.clusters);
        tx.upsertCoverage(input.roundIndex, coverage);
        tx.consumeBudget({
          rounds: 1,
          documents: mapped.documents.length,
          browserFetches: mapped.stats.browserFetches,
          durationMs: mapped.stats.durationMs,
        });
      },
    });

    // 提交成功后才并入内存态：回滚的那一批绝不能影响后续轮次的去重与覆盖度。
    context.documents.push(...fetched.mapped.documents);
    context.chunks.push(...fetched.mapped.chunks);
    context.coverage = fetched.coverage;
    // 流水只在**提交成功后**发：先发再提交的话，一次回滚会让用户看到几篇根本没入库的来源。
    for (const document of fetched.mapped.documents) {
      // source.domain 是映射层已经算好的域名；缺失时才从 locator（URL）现取。
      const host = document.source.domain ?? hostnameOf(document.source.locator);
      this.activity(sessionId, "document", host, input.roundIndex);
    }
    this.reportDegradations(sessionId, fetched.mapped);
  }

  /// 决定下一步：**先跑确定性的 decideStop，再问 Gap Planner**。
  ///
  /// 这个顺序是硬约束：轮数 / 时长 / 预算任一耗尽就必须强制收尾，
  /// 绝不让模型有机会说「再来一轮」——否则一个总是回答 search_more 的模型能把预算烧穿。
  private async decideNext(input: {
    sessionId: string;
    plan: ResearchPlan;
    context: LoopContext;
    signal: AbortSignal;
  }): Promise<PlannerDecision> {
    const { context, plan } = input;
    const spend = await this.deps.repository.getBudgetSpend(input.sessionId);
    const stop = decideStop({
      coverage: [...context.coverage],
      roundsUsed: spend.rounds,
      budget: plan.budget,
      elapsedMs: spend.durationMs,
      usage: {
        queries: spend.queries,
        candidates: spend.candidates,
        documents: spend.documents,
        browserFetches: spend.browserFetches,
        evidenceCharsToModel: spend.evidenceCharsToModel,
      },
    });
    if (stop.stop) return { action: "finish", reason: stop.reason };
    if (!this.deps.planGap) return { action: "finish", reason: "未启用多轮规划" };

    const fetchedUrls = alreadyFetchedUrls(context.documents);
    const unfetched = context.candidates.filter((candidate) => {
      const canonical = canonicalizeUrl(candidate.canonicalUrl ?? candidate.url);
      return canonical !== null && !fetchedUrls.has(canonical);
    });

    const remainingBudget = await this.remainingBudget(input.sessionId, plan.budget);
    const executableCandidates = selectCandidates({
      candidates: unfetched,
      alreadyFetched: fetchedUrls,
      budget: remainingBudget,
      subquestionByQueryId: context.subquestionByQueryId,
      prioritySubquestionIds: prioritizedSubquestions(plan, context.coverage),
      ...(this.deps.blockedDomains ? { blockedDomains: [...this.deps.blockedDomains] } : {}),
    });
    const canSearchMore =
      remainingBudget.maxQueries > 0 &&
      remainingBudget.maxCandidates > 0 &&
      remainingBudget.maxDocuments > 0;
    const fetchableCandidateIds = executableCandidates.map((candidate) => candidate.candidateId);
    const executableCandidateIdSet = new Set(fetchableCandidateIds);
    const canFetchMore = fetchableCandidateIds.length > 0;
    if (!canSearchMore && !canFetchMore) {
      return { action: "finish", reason: "没有可执行的补充检索或抓取动作，使用已有证据收尾" };
    }

    try {
      const decision = await this.deps.planGap({
        plan,
        roundIndex: spend.rounds,
        // 传副本：context 是本次 run 的可变累积态，把它的数组直接交给注入实现，
        // 对方存下引用后会看到「自己收到的输入在后续轮次里自己变了」。
        coverage: [...context.coverage],
        executedQueries: [...context.executedQueries],
        remainingBudget,
        missingSummary: context.coverage.flatMap((report) =>
          report.missing.map((item) => `${report.subquestionId}：${item}`),
        ),
        // 只传元数据（id / 标题 / 域名）——正文、snippet 一律不出现在 Gap Planner 的视野里。
        candidates: executableCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          title: candidate.title,
          domain: candidate.domain,
        })),
        knownCandidateIds: fetchableCandidateIds,
        signal: input.signal,
      });
      if (decision.action === "search_more" && !canSearchMore) {
        if (canFetchMore) {
          return {
            action: "fetch_more",
            reason: "候选发现额度已耗尽，改为抓取已发现但未抓取的来源",
            candidateIds: fetchableCandidateIds,
          };
        }
        return { action: "finish", reason: "检索预算已耗尽，使用已有证据收尾" };
      }
      // 空决策（模型给了 search_more 却没有查询）会导致一轮空转，直接收尾。
      if (decision.action === "search_more" && decision.queries.length === 0) {
        return { action: "finish", reason: "补充查询为空，使用已有证据收尾" };
      }
      if (decision.action === "fetch_more" && decision.candidateIds.length === 0) {
        return { action: "finish", reason: "补充候选为空，使用已有证据收尾" };
      }
      if (decision.action === "fetch_more") {
        const candidateIds = decision.candidateIds.filter((candidateId) =>
          executableCandidateIdSet.has(candidateId),
        );
        if (candidateIds.length === 0) {
          return { action: "finish", reason: "补充候选不可抓取，使用已有证据收尾" };
        }
        return { ...decision, candidateIds };
      }
      return decision;
    } catch (err) {
      if (input.signal.aborted) throw err;
      // Gap 决策失败不该让整个 Session 失败：用已有证据收尾。
      this.deps.logger?.warn("[research] Gap 规划失败，按 finish 收尾", err);
      return { action: "finish", reason: "补充规划失败，使用已有证据收尾" };
    }
  }

  /// 取本次编排使用的计划：首轮且注入了 Initial Planner 时重新规划，否则沿用已有/种子计划。
  ///
  /// 为什么只在首轮重新规划：Session 创建时就落了一份**种子计划**当预算载体，
  /// 「有计划」并不代表「已经规划过」。而一旦有了证据（rounds > 0），
  /// 改写计划会让已提交证据的子问题归属失效，因此续跑一律沿用原计划。
  private async resolvePlan(view: ResearchSessionView, signal: AbortSignal): Promise<ResearchPlan> {
    const existing = view.plan ?? null;
    const isFirstRound = (view.rounds?.length ?? 0) === 0;
    if (this.deps.planInitial && isFirstRound) {
      const budget = existing?.budget ?? clampResearchBudget(view.summary.mode);
      try {
        const plan = await this.deps.planInitial({
          objective: view.summary.objective,
          mode: view.summary.mode,
          budget,
          signal,
        });
        await this.deps.repository.savePlan(view.summary.sessionId, plan);
        return plan;
      } catch (err) {
        if (signal.aborted) throw err;
        // Planner 自身已有降级路径；走到这里说明它彻底崩了，此时沿用种子计划继续研究。
        this.deps.logger?.warn("[research] 初始规划失败，沿用种子计划", err);
      }
    }
    return existing ?? (await this.saveSeedPlan(view));
  }
  // ── 各阶段的实现细节 ──────────────────────────────────────────────────────

  /// 调 Worker 抓取并映射成领域对象。
  private async fetchViaWorker(input: {
    plan: ResearchPlan;
    selected: readonly SearchCandidate[];
    /// 历史全部候选（用于把 Worker 返回的 candidate_id 反查回域名与来源类型）。
    candidates: readonly SearchCandidate[];
    /// 本 Session 已提交的文档（跨轮累积），用于指纹去重与 duplicate_of 收敛。
    knownDocuments: readonly ResearchDocument[];
    /// queryId → subquestionId，跨轮累积；缺了它后续轮次的 chunk 会失去子问题归属。
    subquestionByQueryId: ReadonlyMap<string, string>;
    operationId: string;
    limits: ResearchBudget;
    signal: AbortSignal;
    /// Worker 的抓取进度回调（转成 stage:fetching 事件给 UI）。
    onProgress?: (progress: { completed: number; total: number }) => void;
  }): Promise<MappedFetchResult> {
    const params: WorkerFetchPrepareParams = {
      operation_id: input.operationId,
      objective: input.plan.objective,
      subquestions: input.plan.subquestions.map((item) => ({ id: item.id, text: item.text })),
      candidates: toWorkerCandidates(input.selected),
      // 已抓取过的内容指纹：Worker 命中即跳过抓取，只回 duplicate_of（省一次网络往返）。
      known_fingerprints: input.knownDocuments.map((document) => {
        const fingerprint: WorkerFetchPrepareParams["known_fingerprints"][number] = {
          document_id: document.documentId,
          content_hash: document.contentHash,
        };
        if (document.simhash !== undefined) fingerprint.simhash = document.simhash;
        return fingerprint;
      }),
      policy: {
        trust_zone: "public_web",
        allow_search_server: DEFAULT_SOURCE_POLICIES.public_web.allowSearchServer,
        allow_cloud_model: DEFAULT_SOURCE_POLICIES.public_web.allowCloudModel,
        allow_cross_session_reuse: DEFAULT_SOURCE_POLICIES.public_web.allowCrossSessionReuse,
      },
      limits: {
        max_documents: Math.max(1, input.limits.maxDocuments),
        max_browser_fetches: input.limits.maxBrowserFetches,
        max_total_bytes: MAX_TOTAL_FETCH_BYTES,
        max_duration_ms: Math.max(1, Math.round(input.limits.maxDurationMs)),
        http_concurrency: HTTP_CONCURRENCY,
        per_host_concurrency: PER_HOST_CONCURRENCY,
        request_timeout_ms: REQUEST_TIMEOUT_MS,
      },
      // Browser 降级的域名白名单只能来自**我们选中的候选**（spec §12.3）：
      // 让 Worker 自己推导等于把白名单交给了不可信的页面内容。
      allowed_domains: [...new Set(input.selected.map((candidate) => candidate.domain))],
    };
    if (this.deps.agentBrowserBinary) params.agent_browser_binary = this.deps.agentBrowserBinary;

    let raw = await this.requestWorkerWithCancel(params, input.signal, input.onProgress);
    if (raw.operation_id !== params.operation_id) {
      throw new Error("Worker 响应的 operation_id 与请求不一致");
    }

    // 服务端 stealth 降级：本地抓不到、且域名在清单里的候选，交给服务端 Camoufox 抓，
    // 再把 HTML 经 prefetched 发第二轮 fetch_prepare 走同一套抽取管线。
    const prefetched = await this.stealthPrefetch(raw, input.selected, input.signal);
    if (prefetched.length > 0) {
      const retryParams: WorkerFetchPrepareParams = {
        ...params,
        // 换一个 operation_id：同一个 id 发两次请求会让 Worker 侧的取消与进度归属错乱。
        operation_id: `${params.operation_id}:stealth`,
        // 只重抓这些候选。带上全部候选会让已经成功的那些再抓一遍，白烧带宽。
        candidates: params.candidates.filter((c) =>
          prefetched.some((item) => item.candidate_id === c.candidate_id),
        ),
        prefetched,
      };
      const retryRaw = await this.requestWorkerWithCancel(
        retryParams,
        input.signal,
        input.onProgress,
      );
      // 合并：第二轮的产出并进第一轮，并把已被救回的候选从 failures 里摘掉。
      const rescued = new Set(retryRaw.documents.map((d) => d.candidate_id));
      raw = {
        ...raw,
        documents: [...raw.documents, ...retryRaw.documents],
        chunks: [...raw.chunks, ...retryRaw.chunks],
        failures: [
          ...raw.failures.filter((f) => !rescued.has(f.candidate_id)),
          // 第二轮自己的失败（比如抓回来的是反爬壳页面、抽不出正文）要保留，
          // 否则用户看到的是「这个候选凭空消失了」。
          ...retryRaw.failures,
        ],
      };
    }

    return mapFetchPrepareResult(raw, {
      newId: () => this.newId(),
      candidates: new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate])),
      subquestionByQueryId: input.subquestionByQueryId,
      knownDocumentIdByHash: new Map(
        input.knownDocuments.map((document) => [document.contentHash, document.documentId]),
      ),
    });
  }

  /// 对「本地抓不到 + 域名命中清单」的候选做服务端 stealth 抓取。
  ///
  /// 两个条件必须同时满足（见 core/research/stealth-domains 的说明）：服务端每次要起一个
  /// Camoufox（约 5s、并发上限 2），且抓取 URL 会离开本机，这条路径必须是窄的。
  ///
  /// **unconfigured 立刻中止整批**：它表示「服务端没装这个组件」，不是「这个候选失败」。
  /// 逐候选各撞一次往返是最糟的表现形式（10 个候选 = 白等 50 秒）。
  private async stealthPrefetch(
    raw: WorkerFetchPrepareResult,
    selected: readonly SearchCandidate[],
    signal: AbortSignal,
  ): Promise<NonNullable<WorkerFetchPrepareParams["prefetched"]>> {
    const stealth = this.deps.stealthFetch;
    if (!stealth) return [];

    const byId = new Map(selected.map((c) => [c.candidateId, c]));
    const out: NonNullable<WorkerFetchPrepareParams["prefetched"]> = [];

    for (const failure of raw.failures) {
      if (signal.aborted) break;
      // 只对「值得用浏览器重试」的失败降级，判定与 Worker 侧 shouldFallbackToBrowser 同口径：
      // 403/429 是被拦，空正文是渲染不出来 —— 都可能被真浏览器救回。
      const worthRetry =
        failure.code === "empty_content" ||
        (failure.code === "http_error" &&
          (failure.http_status === 403 || failure.http_status === 429));
      if (!worthRetry) continue;

      const candidate = byId.get(failure.candidate_id);
      if (!candidate || !needsStealthFetch(candidate.domain)) continue;

      try {
        const result = await stealth.fetch(candidate.url, signal);
        out.push({
          candidate_id: failure.candidate_id,
          html: result.html,
          final_url: result.finalUrl || candidate.url,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "unconfigured") {
          this.deps.logger?.info?.("[research] 服务端 stealth 抓取未配置，跳过该路径");
          break;
        }
        if (code === "cancelled") break;
        // 其余失败只影响这一个候选：它的原始 HTTP 失败会照常留在 failures 里。
        this.deps.logger?.warn("[research] 服务端 stealth 抓取失败", { code });
      }
    }
    return out;
  }

  /// 发 fetch_prepare 并让它可被取消。
  ///
  /// RPC 客户端本身没有 abort 语义（协议里取消是**另一条消息**），所以取消要做两件事：
  /// 给 Worker 发 cancel 让它停止在途抓取（best-effort，不等 ack），同时立刻让本次调用失败。
  /// 不等 ack 的理由：Worker 可能正卡在一个 20 秒超时的连接上，等它回话会让"取消"看起来没反应。
  private requestWorkerWithCancel(
    params: WorkerFetchPrepareParams,
    signal: AbortSignal,
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<WorkerFetchPrepareResult> {
    if (signal.aborted) return Promise.reject(new OperationCancelledError(params.operation_id));
    const pending = this.deps.worker.request("fetch_prepare", params, onProgress);

    return new Promise<WorkerFetchPrepareResult>((resolve, reject) => {
      const onAbort = (): void => {
        void this.deps.worker
          .request("cancel", { operation_id: params.operation_id })
          .catch(() => {});
        reject(new OperationCancelledError(params.operation_id));
      };
      // 取消可能恰好发生在"请求已发出、监听器还没挂上"这个同步窗口里
      //（Worker 的 request 实现会同步跑到第一个 await）。少了这一句，那一瞬间的取消
      // 就不会通知到 Worker，它会继续把整轮抓取跑完，白烧带宽与 Browser 额度。
      if (signal.aborted) {
        onAbort();
        pending.catch(() => {});
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      // 即使已经因取消 reject 过，这里仍然要挂上 handler：否则 Worker 稍后真的失败时
      // 会变成一条 unhandledRejection。
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /// 报告草稿的节流推送器。
  ///
  /// 为什么必须节流：模型逐 token 回吐，一篇 5000 字的报告能产生上千次回调，
  /// 每次都发一条 IPC 会把渲染进程的事件队列灌满（UI 反而更卡）。攒够字数或攒够时间才发一条，
  /// 收尾时 flush 掉尾巴——少了 flush，报告的最后一段会永远停在草稿之外。
  private createDraftStream(sessionId: string): {
    push: (delta: string) => void;
    flush: () => void;
  } {
    let buffer = "";
    let lastFlushAt = Date.now();
    const flush = (): void => {
      if (buffer.length === 0) return;
      this.emit({ type: "report_delta", sessionId, delta: buffer });
      buffer = "";
      lastFlushAt = Date.now();
    };
    return {
      push: (delta) => {
        buffer += delta;
        if (buffer.length >= DRAFT_FLUSH_CHARS || Date.now() - lastFlushAt >= DRAFT_FLUSH_MS) flush();
      },
      flush,
    };
  }

  /// 生成报告正文。默认走确定性证据摘要（P5 无 LLM）。
  private async generateReport(
    input: Parameters<ReportGenerator>[0],
  ): Promise<ReportGeneratorOutput> {
    if (this.deps.generateReport) {
      const output = await this.deps.generateReport(input);
      return typeof output === "string" ? { markdown: output } : output;
    }
    return {
      markdown: buildEvidenceReport({
        plan: input.plan,
        chunks: input.chunks,
        documents: input.documents,
      }),
    };
  }

  /// 为缺少计划的 Session 补一份种子计划并落库。
  private async saveSeedPlan(view: ResearchSessionView): Promise<ResearchPlan> {
    const plan = buildSeedPlan({ objective: view.summary.objective, mode: view.summary.mode });
    await this.deps.repository.savePlan(view.summary.sessionId, plan);
    return plan;
  }

  /// 剩余预算 = 上限 - 已消耗。负数夹到 0，避免"负预算"被当成无限制。
  private async remainingBudget(sessionId: string, budget: ResearchBudget): Promise<ResearchBudget> {
    const spend = await this.deps.repository.getBudgetSpend(sessionId);
    return {
      maxRounds: Math.max(0, budget.maxRounds - spend.rounds),
      maxQueries: Math.max(0, budget.maxQueries - spend.queries),
      maxCandidates: Math.max(0, budget.maxCandidates - spend.candidates),
      maxDocuments: Math.max(0, budget.maxDocuments - spend.documents),
      maxBrowserFetches: Math.max(0, budget.maxBrowserFetches - spend.browserFetches),
      maxDurationMs: Math.max(0, budget.maxDurationMs - spend.durationMs),
      maxEvidenceCharsToModel: Math.max(
        0,
        budget.maxEvidenceCharsToModel - spend.evidenceCharsToModel,
      ),
    };
  }

  /// 把"部分失败"上报成非终态错误事件：单条 URL 抓不到不该让整个 Session 失败，
  /// 但用户有权知道"10 个来源里有 3 个没拿到"。
  private reportDegradations(sessionId: string, mapped: MappedFetchResult): void {
    for (const failure of mapped.failures) {
      // 只带域名不带完整 URL：URL 的 query string 可能含搜索词（§19.3.1）。
      const host = hostnameOf(failure.url);
      this.emit({
        type: "error",
        sessionId,
        code: `fetch_${failure.code}`,
        message: `抓取失败：${host}（${failure.code}）`,
        terminal: false,
      });
      // 同一件事发两条事件是有意的：error 进「未能采信的来源」清单（可回看），
      // activity 只是流水里的一行（会滚走）。两个视图的生命周期不同。
      this.activity(sessionId, "fetch_failed", `${host}（${failure.code}）`);
    }
    if (mapped.notes.length > 0) {
      this.deps.logger?.warn("[research] 映射降级", mapped.notes);
    }
  }

  /// 收尾：取消 → cancelled/paused；失败 → failed。
  ///
  /// 本方法**自身绝不抛错**：它跑在 catch 块里，再抛一次会把原始失败原因盖掉，
  /// 那正是"Session 卡在进行中且日志里只有一条状态写入失败"的经典成因。
  private async settle(state: SessionStateWriter, err: unknown, cancelled: boolean): Promise<void> {
    const sessionId = state.sessionId;
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (cancelled) {
        const intent = this.deps.abortIntent?.() ?? "cancel";
        if (intent === "pause") {
          await state.forceTo("paused");
          return;
        }
        await state.forceTo("cancelled");
        this.emit({ type: "done", sessionId, status: "cancelled" });
        return;
      }
      await state.forceTo("failed", message);
      this.emit({ type: "error", sessionId, code: "research_failed", message, terminal: true });
      this.emit({ type: "done", sessionId, status: "failed" });
    } catch (settleError) {
      this.deps.logger?.warn("[research] 收尾状态写入失败", sessionId, settleError);
    }
  }

  private emit(event: ResearchEvent): void {
    this.deps.emit?.(event);
  }

  /// 发一条执行流水。
  ///
  /// **text 的取值受 spec §19.3.1/§19.3.2 约束**：只允许查询词、域名、决策名与计数——
  /// 完整 URL（query string 可能含搜索词）、网页正文、文档标题都不得出现在这里。
  /// 调用点自己负责把 URL 收敛成域名（hostnameOf）。
  private activity(
    sessionId: string,
    kind: ResearchActivityEvent["kind"],
    text: string,
    roundIndex?: number,
  ): void {
    this.emit({
      type: "activity",
      sessionId,
      at: this.nowIso(),
      kind,
      text,
      ...(roundIndex !== undefined ? { roundIndex } : {}),
    });
  }

  private newId(): string {
    return this.deps.newId ? this.deps.newId() : globalThis.crypto.randomUUID();
  }

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

/// 由研究目标生成一份种子计划（单子问题 + 单查询）。
///
/// 存在的理由：ResearchPlan 是**预算的持久化载体**（仓储的 getSession 不返回 session 行上的
/// 预算），没有计划就没有可跨重启恢复的预算。P7 的 Initial Planner 落地后，
/// 它的输出会直接覆盖这份种子计划，本函数退化为"Planner 失败时的降级产物"。
export function buildSeedPlan(input: {
  objective: string;
  mode: ResearchMode;
  budget?: Partial<ResearchBudget>;
}): ResearchPlan {
  const objective = input.objective.trim();
  const subquestionId = "sq_1";
  return {
    schemaVersion: 1,
    objective,
    scope: {},
    subquestions: [{ id: subquestionId, text: objective }],
    initialQueries: [
      {
        queryId: "q_1",
        subquestionId,
        // 按 code point 截断（与 Go 侧 rune 计数一致），超长查询会被服务端 400 掉。
        text: [...objective].slice(0, SEARCH_LIMITS.maxQueryChars).join(""),
      },
    ],
    budget: clampResearchBudget(input.mode, input.budget),
    completion: { ...SEED_COMPLETION },
  };
}

/// 已抓取文档的 canonical URL 集合，用于候选去重（跨轮次不重复抓同一个页面）。
function alreadyFetchedUrls(documents: readonly ResearchDocument[]): Set<string> {
  const urls = new Set<string>();
  for (const document of documents) {
    const canonical = canonicalizeUrl(document.canonicalUrl ?? document.source.locator);
    if (canonical) urls.add(canonical);
  }
  return urls;
}

function prioritizedSubquestions(
  plan: ResearchPlan,
  coverage: readonly CoverageReport[],
): string[] {
  const statusById = new Map(coverage.map((report) => [report.subquestionId, report.status]));
  const weight = { missing: 0, weak: 1, sufficient: 2 } as const;
  return plan.subquestions
    .map((subquestion, position) => ({
      id: subquestion.id,
      position,
      weight: weight[statusById.get(subquestion.id) ?? "missing"],
    }))
    .sort((a, b) => a.weight - b.weight || a.position - b.position)
    .map((entry) => entry.id);
}

/// 发现阶段也必须按查询交替取样。只在 fetch 选择阶段做公平性已经太晚：如果这里直接
/// slice，Search Server 返回的第一个查询就可能先把候选额度吃完，后续子问题没有候选可选。
function takeCandidatesByQuery(
  candidates: readonly SearchCandidate[],
  limit: number,
): SearchCandidate[] {
  const groups = new Map<string, SearchCandidate[]>();
  for (const candidate of candidates) {
    const bucket = groups.get(candidate.queryId) ?? [];
    bucket.push(candidate);
    groups.set(candidate.queryId, bucket);
  }
  const selected: SearchCandidate[] = [];
  for (let depth = 0; selected.length < limit; depth += 1) {
    let added = false;
    for (const bucket of groups.values()) {
      const candidate = bucket[depth];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

/// 没有候选可抓时的空结果。走与正常路径完全相同的提交流程，
/// 这样"本轮什么都没抓到"同样会留下一条 round 记录，而不是凭空消失。
function emptyFetchResult(): MappedFetchResult {
  return {
    documents: [],
    texts: new Map(),
    chunks: [],
    clusters: [],
    failures: [],
    stats: { httpFetches: 0, browserFetches: 0, totalBytes: 0, durationMs: 0, skippedKnown: 0 },
    notes: [],
  };
}

/// 取主机名用于可展示的错误文案；解析失败给固定占位。
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "<invalid-url>";
  }
}
