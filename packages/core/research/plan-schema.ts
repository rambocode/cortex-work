// Planner 输出的运行时校验与清洗（spec §10.1、§10.3）。
//
// 这是 **防 Prompt Injection 与防模型幻觉的关键闸门**：ResearchPlan 与 PlannerDecision 都由 LLM
// 生成，而 LLM 的输入里含有搜索摘要等不可信文本。任何未经本文件清洗的模型输出都不得进入编排层。
//
// 两条不同的失败哲学（刻意不对称，见各函数注释）：
// - parseResearchPlan：初始计划是整个 Session 的地基，结构性错误一律**整体拒绝**并重试 Planner。
// - parsePlannerDecision：Gap 决策只影响「要不要再来一轮」，坏字段**删除后降级为 finish**，
//   让 Session 用已有证据收尾，而不是让整个研究失败。
//
// 命名风格：全 camelCase（TS 领域层）。发往 Go Search Server 的 snake_case 转换在 ./search-api。
import { z } from "zod";

import { clampResearchBudget } from "./budget";
import { SEARCH_LIMITS, countUtf8Chars, truncateToChars } from "./search-api";
import type {
  CompletionCriteria,
  PlannedQuery,
  PlannerDecision,
  ResearchBudget,
  ResearchMode,
  ResearchPlan,
} from "./types";

// ---------------------------------------------------------------------------
// 输出侧 schema：ResearchPlan / PlannerDecision 的「合法形状」定义
// ---------------------------------------------------------------------------

/// 时间范围枚举。与 ./types 的 ResearchTimeRange、Go 侧的 time_range 同集合。
const researchTimeRangeSchema = z.enum(["day", "week", "month", "year", "all"]);

/// 已清洗过的单条查询。text 的上限按 code point 计（与 Go 的 rune 计数一致，见 ./search-api）。
const plannedQuerySchema = z.object({
  queryId: z.string().min(1),
  subquestionId: z.string().min(1),
  text: z
    .string()
    .min(1)
    .refine((value) => countUtf8Chars(value) <= SEARCH_LIMITS.maxQueryChars, {
      message: `查询文本超过 ${SEARCH_LIMITS.maxQueryChars} 字符`,
    }),
  language: z.string().min(1).optional(),
  categories: z.array(z.string().min(1)).optional(),
  timeRange: researchTimeRangeSchema.optional(),
  domainAllowlist: z.array(z.string().min(1)).optional(),
  domainBlocklist: z.array(z.string().min(1)).optional(),
  limit: z.int().min(1).max(SEARCH_LIMITS.maxResultsPerQuery).optional(),
});

const researchSubquestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  rationale: z.string().optional(),
});

const researchScopeSchema = z.object({
  language: z.string().min(1).optional(),
  timeRange: researchTimeRangeSchema.optional(),
  regions: z.array(z.string().min(1)).optional(),
});

/// 预算的合法形状。真正的取值由 ./budget 的 clampResearchBudget 保证，这里只做最后的兜底断言。
const researchBudgetSchema = z.object({
  maxRounds: z.int().min(0),
  maxQueries: z.int().min(0),
  maxCandidates: z.int().min(0),
  maxDocuments: z.int().min(0),
  maxBrowserFetches: z.int().min(0),
  maxDurationMs: z.number().min(0),
  maxEvidenceCharsToModel: z.int().min(0),
});

const completionCriteriaSchema = z.object({
  minSourcesPerSubquestion: z.int().min(0),
  minIndependentDomains: z.int().min(0),
  requirePrimarySource: z.boolean(),
  requireContradiction: z.boolean(),
  minimumRelevance: z.number().min(0).max(1),
});

/// **已清洗** ResearchPlan 的运行时形状（spec §8.1）。
/// 它是 parseResearchPlan 的最后一道闸门，也可被持久化层用来校验读回的旧 Plan——
/// 两者共用同一个 schema，保证「解析器认可的」与「schema 认可的」永远不会漂移。
export const researchPlanSchema = z.object({
  schemaVersion: z.literal(1),
  objective: z.string().min(1),
  scope: researchScopeSchema,
  subquestions: z.array(researchSubquestionSchema).min(1),
  initialQueries: z.array(plannedQuerySchema).min(1),
  budget: researchBudgetSchema,
  completion: completionCriteriaSchema,
});

/// **已清洗** PlannerDecision 的运行时形状（spec §10.3），按 action 判别。
export const plannerDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search_more"),
    reason: z.string(),
    queries: z.array(plannedQuerySchema).min(1),
  }),
  z.object({
    action: z.literal("fetch_more"),
    reason: z.string(),
    candidateIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({ action: z.literal("finish"), reason: z.string() }),
]);

// ---------------------------------------------------------------------------
// 输入侧 schema：宽松接收模型输出，只在「不可修复」的地方失败
// ---------------------------------------------------------------------------

/// 模型给出的单条查询。queryId 允许缺失（后续自动补），limit/domain 列表后续再夹取；
/// 但枚举值一律不容错——未知 timeRange 说明模型没按 schema 输出，继续解析只会掩盖问题。
const plannedQueryInputSchema = z.object({
  queryId: z.string().optional(),
  subquestionId: z.string().min(1),
  text: z.string().refine((value) => value.trim().length > 0, { message: "查询文本不能为空" }),
  language: z.string().min(1).optional(),
  categories: z.array(z.string()).optional(),
  timeRange: researchTimeRangeSchema.optional(),
  domainAllowlist: z.array(z.string()).optional(),
  domainBlocklist: z.array(z.string()).optional(),
  limit: z.number().optional(),
});

type PlannedQueryInput = z.infer<typeof plannedQueryInputSchema>;

/// 模型给出的 Plan。budget 与 completion 刻意不在此校验：它们由本文件自行归一，
/// 模型写坏了也不该导致整份计划作废（预算有硬上限兜底，阈值有默认值兜底）。
const researchPlanInputSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  objective: z.string().refine((value) => value.trim().length > 0, { message: "objective 不能为空" }),
  scope: researchScopeSchema.optional(),
  subquestions: z.array(researchSubquestionSchema).min(1, { message: "至少需要一个子问题" }),
  initialQueries: z.array(plannedQueryInputSchema).min(1, { message: "至少需要一条初始查询" }),
});

const plannerDecisionInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search_more"),
    reason: z.string().optional(),
    queries: z.array(plannedQueryInputSchema),
  }),
  z.object({
    action: z.literal("fetch_more"),
    reason: z.string().optional(),
    candidateIds: z.array(z.string()),
  }),
  z.object({ action: z.literal("finish"), reason: z.string().optional() }),
]);

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/// 计划解析结果。warnings 是「已被修复的问题」，errors 是「无法修复、必须重试 Planner」。
export type ParseResearchPlanResult =
  | { ok: true; plan: ResearchPlan; warnings: string[] }
  | { ok: false; errors: string[] };

/// 决策解析结果。语义同上；注意 decision 可能是被降级后的 finish。
export type ParsePlannerDecisionResult =
  | { ok: true; decision: PlannerDecision; warnings: string[] }
  | { ok: false; errors: string[] };

/// parseResearchPlan 的上下文。allowedDomains / blockedDomains 缺省表示「不额外约束」，
/// 域名格式清洗仍会执行。
export interface ParseResearchPlanContext {
  mode: ResearchMode;
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
}

/// parsePlannerDecision 的上下文。knownCandidateIds 允许传数组（调用方常直接持有列表），
/// 内部统一转成 Set，避免 O(n²) 查找。
export interface ParsePlannerDecisionContext {
  knownCandidateIds: ReadonlySet<string> | readonly string[];
  subquestionIds: readonly string[];
}

// ---------------------------------------------------------------------------
// 清洗工具
// ---------------------------------------------------------------------------

/// 模型**绝不允许**给出的字段名（spec §10.1「模型不得生成 URL」）。
/// 为什么是黑名单而不是「靠 zod 剥离未知字段」：zod 会静默丢弃，我们需要留下 warning ——
/// 模型开始编 URL 通常意味着提示词被注入或 Planner 提示写歪了，这个信号必须可观测。
const URL_FIELD_NAMES = new Set([
  "url",
  "urls",
  "link",
  "links",
  "href",
  "hrefs",
  "uri",
  "uris",
  "source",
  "sources",
  "site",
  "sites",
  "website",
  "websites",
]);

/// warning 上限。畸形模型输出可能产生上千条 warning，而 warning 会被日志与持久化带走。
const MAX_WARNINGS = 100;

/// 带封顶的 warning 收集器。
interface WarningSink {
  push(message: string): void;
  readonly warnings: string[];
}

function createWarningSink(limit = MAX_WARNINGS): WarningSink {
  const warnings: string[] = [];
  let truncated = false;
  return {
    warnings,
    push(message: string) {
      if (warnings.length < limit) {
        warnings.push(message);
        return;
      }
      // 只追加一条截断提示，之后静默丢弃，避免 warning 本身变成 DoS。
      if (!truncated) {
        truncated = true;
        warnings.push(`[plan.warnings_truncated] warning 过多，仅保留前 ${limit} 条`);
      }
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/// 递归删除任意层级上的 URL 类字段，返回重建后的新结构（不修改入参）。
/// path 用于生成可定位的 warning，例如 `initialQueries[0].url`。
function stripUrlFields(value: unknown, path: string, sink: WarningSink): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => stripUrlFields(item, `${path}[${index}]`, sink));
  }
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    if (URL_FIELD_NAMES.has(key.toLowerCase())) {
      sink.push(`[plan.url_dropped] 丢弃模型生成的 URL 字段：${childPath}`);
      continue;
    }
    result[key] = stripUrlFields(item, childPath, sink);
  }
  return result;
}

/// 查询去重的归一化：trim + 折叠所有空白 + 转小写。
/// 只用于比较，不改写实际发出的文本（大小写可能影响某些搜索引擎的结果）。
function normalizeQueryText(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

/// 合法域名的保守形态：小写字母数字与 `-`、至少一个点、不含 scheme/端口/路径。
/// 这条正则同时挡住「把整条 URL 塞进 domainAllowlist」这种绕过「模型不得生成 URL」的路子。
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/// 归一化单个域名条目；形态非法返回 undefined。
function normalizeDomain(entry: string): string | undefined {
  const normalized = entry.trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN_PATTERN.test(normalized) ? normalized : undefined;
}

/// domain 是否落在某个允许域之内（自身或其子域）。
function matchesDomainScope(domain: string, scope: readonly string[]): boolean {
  return scope.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return domain === normalized || domain.endsWith(`.${normalized}`);
  });
}

/// 清洗查询的 allowlist：格式非法、超出 ctx.allowedDomains、命中 ctx.blockedDomains 的条目全部删除。
/// 返回 undefined 表示「清洗后为空，等价于不限制域名」。
function cleanAllowlist(
  entries: readonly string[] | undefined,
  ctx: { allowedDomains?: readonly string[]; blockedDomains?: readonly string[] },
  label: string,
  sink: WarningSink,
): string[] | undefined {
  if (!entries) return undefined;
  const kept: string[] = [];
  for (const entry of entries) {
    const domain = normalizeDomain(entry);
    if (!domain) {
      sink.push(`[plan.domain_dropped] ${label} 移除形态非法的域名：${entry}`);
      continue;
    }
    if (ctx.allowedDomains && ctx.allowedDomains.length > 0 && !matchesDomainScope(domain, ctx.allowedDomains)) {
      sink.push(`[plan.domain_dropped] ${label} 移除超出允许范围的域名：${domain}`);
      continue;
    }
    if (ctx.blockedDomains && matchesDomainScope(domain, ctx.blockedDomains)) {
      sink.push(`[plan.domain_dropped] ${label} 移除已被全局屏蔽的域名：${domain}`);
      continue;
    }
    if (!kept.includes(domain)) kept.push(domain);
  }
  return kept.length > 0 ? kept : undefined;
}

/// 清洗查询的 blocklist：**只做格式清洗，不受 allowedDomains 约束**。
/// 理由：blocklist 只会收紧检索范围，模型多屏蔽几个域名不构成安全或成本风险，
/// 而按 allowlist 去过滤 blocklist 在语义上是自相矛盾的（屏蔽一个本来就不允许的域是 no-op）。
function cleanBlocklist(
  entries: readonly string[] | undefined,
  label: string,
  sink: WarningSink,
): string[] | undefined {
  if (!entries) return undefined;
  const kept: string[] = [];
  for (const entry of entries) {
    const domain = normalizeDomain(entry);
    if (!domain) {
      sink.push(`[plan.domain_dropped] ${label} 移除形态非法的域名：${entry}`);
      continue;
    }
    if (!kept.includes(domain)) kept.push(domain);
  }
  return kept.length > 0 ? kept : undefined;
}

/// 生成不冲突的 queryId：模型给的 id 可用就用，缺失或撞车则退回按序号生成。
function resolveQueryId(desired: string, used: ReadonlySet<string>, index: number): string {
  if (desired.length > 0 && !used.has(desired)) return desired;
  let candidate = `q_${index + 1}`;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `q_${index + 1}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/// 查询清洗的可配置项。unknownSubquestion 决定「引用了不存在的子问题」是拒绝还是删除，
/// 这是 Plan 与 Decision 两条路径唯一的行为差异。
interface CleanQueriesOptions {
  subquestionIds: ReadonlySet<string>;
  unknownSubquestion: "reject" | "drop";
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
  /// warning / error 里的字段路径前缀，如 `initialQueries`。
  label: string;
}

/// 查询数组的统一清洗：归属校验 → 超长截断 → 同 subquestion 内去重 → queryId 补齐 → 域名与 limit 夹取。
///
/// 顺序是有讲究的：先截断再去重，才能让「只在 512 字之后不同」的两条查询被判为重复；
/// 先去重再补 queryId，才不会让被丢弃的重复项白占一个自动生成的 id。
function cleanQueries(
  rawQueries: readonly PlannedQueryInput[],
  options: CleanQueriesOptions,
  sink: WarningSink,
): { queries: PlannedQuery[]; errors: string[] } {
  const queries: PlannedQuery[] = [];
  const errors: string[] = [];
  const seenTexts = new Set<string>();
  const usedIds = new Set<string>();

  rawQueries.forEach((raw, index) => {
    const at = `${options.label}[${index}]`;
    const subquestionId = raw.subquestionId.trim();
    if (!options.subquestionIds.has(subquestionId)) {
      if (options.unknownSubquestion === "reject") {
        errors.push(`[plan.invalid] ${at}.subquestionId 引用了不存在的子问题：${subquestionId}`);
      } else {
        sink.push(`[decision.invalid_subquestion] ${at} 引用了不存在的子问题，已删除：${subquestionId}`);
      }
      return;
    }

    let text = raw.text.trim();
    if (countUtf8Chars(text) > SEARCH_LIMITS.maxQueryChars) {
      text = truncateToChars(text, SEARCH_LIMITS.maxQueryChars);
      sink.push(`[plan.query_truncated] ${at}.text 超过 ${SEARCH_LIMITS.maxQueryChars} 字符，已截断`);
    }

    const dedupeKey = `${subquestionId} ${normalizeQueryText(text)}`;
    if (seenTexts.has(dedupeKey)) {
      sink.push(`[plan.duplicate_query] ${at} 与同一子问题下的既有查询重复，已删除`);
      return;
    }
    seenTexts.add(dedupeKey);

    const desiredId = raw.queryId?.trim() ?? "";
    const queryId = resolveQueryId(desiredId, usedIds, index);
    if (queryId !== desiredId) {
      sink.push(`[plan.query_id_assigned] ${at}.queryId 缺失或重复，已改写为 ${queryId}`);
    }
    usedIds.add(queryId);

    // 逐字段白名单重建：模型给的任何额外字段都不会进入编排层。
    const query: PlannedQuery = { queryId, subquestionId, text };
    if (raw.language) query.language = raw.language;
    const categories = raw.categories?.map((item) => item.trim()).filter((item) => item.length > 0);
    if (categories && categories.length > 0) query.categories = categories;
    if (raw.timeRange) query.timeRange = raw.timeRange;

    const allowlist = cleanAllowlist(
      raw.domainAllowlist,
      { allowedDomains: options.allowedDomains, blockedDomains: options.blockedDomains },
      `${at}.domainAllowlist`,
      sink,
    );
    if (allowlist) query.domainAllowlist = allowlist;
    const blocklist = cleanBlocklist(raw.domainBlocklist, `${at}.domainBlocklist`, sink);
    if (blocklist) query.domainBlocklist = blocklist;

    const limit = clampQueryLimit(raw.limit, at, sink);
    if (limit !== undefined) query.limit = limit;

    queries.push(query);
  });

  return { queries, errors };
}

/// 把 limit 夹到 1..maxResultsPerQuery；非有限数直接丢弃该字段（服务端有默认值）。
function clampQueryLimit(limit: number | undefined, at: string, sink: WarningSink): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) {
    sink.push(`[plan.limit_clamped] ${at}.limit 不是有限数，已丢弃`);
    return undefined;
  }
  const clamped = Math.min(SEARCH_LIMITS.maxResultsPerQuery, Math.max(1, Math.round(limit)));
  if (clamped !== limit) {
    sink.push(`[plan.limit_clamped] ${at}.limit ${limit} 已夹取为 ${clamped}`);
  }
  return clamped;
}

/// 完成判据的默认值。模型经常整段省略 completion，缺省值必须是「保守但可达成」的：
/// 每个子问题 2 个来源、2 个独立域名，相关性下限 0.4；不强制一手来源与矛盾检索，
/// 那两项由 Consumer 按场景显式打开（Deep Research 会要求一手来源）。
const DEFAULT_COMPLETION: CompletionCriteria = {
  minSourcesPerSubquestion: 2,
  minIndependentDomains: 2,
  requirePrimarySource: false,
  requireContradiction: false,
  minimumRelevance: 0.4,
};

/// 读取非负整数，非法时回落默认值。
function readCount(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.round(value);
}

/// 归一化 completion：坏值回落默认而非拒绝整份计划——它是「研究到什么程度算够」的阈值，
/// 不是安全边界，写坏了最多影响停止时机，不会造成越权或数据外泄。
function normalizeCompletion(raw: unknown): CompletionCriteria {
  if (!isPlainObject(raw)) return { ...DEFAULT_COMPLETION };
  const relevance = raw.minimumRelevance;
  return {
    minSourcesPerSubquestion: readCount(
      raw,
      "minSourcesPerSubquestion",
      DEFAULT_COMPLETION.minSourcesPerSubquestion,
    ),
    minIndependentDomains: readCount(
      raw,
      "minIndependentDomains",
      DEFAULT_COMPLETION.minIndependentDomains,
    ),
    requirePrimarySource:
      typeof raw.requirePrimarySource === "boolean"
        ? raw.requirePrimarySource
        : DEFAULT_COMPLETION.requirePrimarySource,
    requireContradiction:
      typeof raw.requireContradiction === "boolean"
        ? raw.requireContradiction
        : DEFAULT_COMPLETION.requireContradiction,
    minimumRelevance:
      typeof relevance === "number" && Number.isFinite(relevance)
        ? Math.min(1, Math.max(0, relevance))
        : DEFAULT_COMPLETION.minimumRelevance,
  };
}

/// 把 zod 的 issue 列表转成可读的一行式错误，供日志与 Planner 重试提示使用。
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `[plan.invalid] ${path.length > 0 ? path : "<root>"}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// 对外解析函数
// ---------------------------------------------------------------------------

/// 校验并清洗 Initial Planner 的输出（spec §10.1）。
///
/// 清洗顺序即安全顺序：**先剥 URL 字段**（在任何字段被读取之前），再做结构校验，
/// 最后才是预算与域名的夹取。任何一步产生 error 都会整体拒绝——初始计划错了就该重试 Planner，
/// 带着半个坏计划往下跑只会在几分钟后以更难定位的方式失败。
export function parseResearchPlan(
  raw: unknown,
  ctx: ParseResearchPlanContext,
): ParseResearchPlanResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["[plan.invalid] <root>: 计划必须是一个 JSON 对象"] };
  }

  const sink = createWarningSink();
  const stripped = stripUrlFields(raw, "", sink) as Record<string, unknown>;

  if (stripped.schemaVersion === undefined) {
    sink.push("[plan.schema_version_filled] 模型未给出 schemaVersion，已按当前版本补 1");
  }

  const parsed = researchPlanInputSchema.safeParse(stripped);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };

  // 子问题 id 是查询归属的唯一键，重复会让「查询属于哪个子问题」变得不可判定，只能拒绝。
  const subquestionIds = new Set<string>();
  const duplicateIds: string[] = [];
  for (const subquestion of parsed.data.subquestions) {
    if (subquestionIds.has(subquestion.id)) duplicateIds.push(subquestion.id);
    subquestionIds.add(subquestion.id);
  }
  if (duplicateIds.length > 0) {
    return {
      ok: false,
      errors: [`[plan.invalid] subquestions: 子问题 id 重复：${duplicateIds.join(", ")}`],
    };
  }

  const { queries, errors } = cleanQueries(
    parsed.data.initialQueries,
    {
      subquestionIds,
      unknownSubquestion: "reject",
      allowedDomains: ctx.allowedDomains,
      blockedDomains: ctx.blockedDomains,
      label: "initialQueries",
    },
    sink,
  );
  if (errors.length > 0) return { ok: false, errors };

  const budgetOverride = isPlainObject(stripped.budget)
    ? (stripped.budget as Partial<ResearchBudget>)
    : undefined;

  const candidate = {
    schemaVersion: 1 as const,
    objective: parsed.data.objective.trim(),
    scope: parsed.data.scope ?? {},
    subquestions: parsed.data.subquestions,
    initialQueries: queries,
    budget: clampResearchBudget(ctx.mode, budgetOverride),
    completion: normalizeCompletion(stripped.completion),
  };

  // 用导出的严格 schema 做最后一道自检：清洗逻辑与 schema 若有分歧，在这里立刻暴露。
  const finalCheck = researchPlanSchema.safeParse(candidate);
  if (!finalCheck.success) return { ok: false, errors: formatIssues(finalCheck.error) };

  const plan: ResearchPlan = finalCheck.data;
  return { ok: true, plan, warnings: sink.warnings };
}

/// 校验并清洗 Gap Planner 的决策（spec §10.3）。
///
/// 与 parseResearchPlan 的不对称：这里对可修复的问题一律「删除 + 降级」。
/// 未知 candidateId 或未知 subquestionId 说明模型在幻想不存在的候选，
/// 删干净之后若无事可做就降级为 finish —— 用已有证据收尾，好过让整个 Session 失败。
export function parsePlannerDecision(
  raw: unknown,
  ctx: ParsePlannerDecisionContext,
): ParsePlannerDecisionResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["[plan.invalid] <root>: 决策必须是一个 JSON 对象"] };
  }

  const sink = createWarningSink();
  const stripped = stripUrlFields(raw, "", sink) as Record<string, unknown>;

  const parsed = plannerDecisionInputSchema.safeParse(stripped);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };

  const reason = parsed.data.reason ?? "";

  if (parsed.data.action === "finish") {
    return { ok: true, decision: { action: "finish", reason }, warnings: sink.warnings };
  }

  if (parsed.data.action === "fetch_more") {
    const known =
      parsed.data.candidateIds.length === 0
        ? new Set<string>()
        : toIdSet(ctx.knownCandidateIds);
    const candidateIds: string[] = [];
    for (const rawId of parsed.data.candidateIds) {
      const id = rawId.trim();
      if (id.length === 0 || !known.has(id)) {
        sink.push(`[decision.unknown_candidate] 删除未知的候选 id：${rawId}`);
        continue;
      }
      if (!candidateIds.includes(id)) candidateIds.push(id);
    }
    if (candidateIds.length === 0) {
      sink.push("[decision.downgraded_to_finish] fetch_more 的候选全部无效，已降级为 finish");
      return { ok: true, decision: { action: "finish", reason }, warnings: sink.warnings };
    }
    return { ok: true, decision: { action: "fetch_more", reason, candidateIds }, warnings: sink.warnings };
  }

  const { queries } = cleanQueries(
    parsed.data.queries,
    {
      subquestionIds: toIdSet(ctx.subquestionIds),
      unknownSubquestion: "drop",
      label: "queries",
    },
    sink,
  );
  if (queries.length === 0) {
    sink.push("[decision.downgraded_to_finish] search_more 没有可执行的查询，已降级为 finish");
    return { ok: true, decision: { action: "finish", reason }, warnings: sink.warnings };
  }

  const decision: PlannerDecision = { action: "search_more", reason, queries };
  const finalCheck = plannerDecisionSchema.safeParse(decision);
  if (!finalCheck.success) return { ok: false, errors: formatIssues(finalCheck.error) };
  return { ok: true, decision, warnings: sink.warnings };
}

/// 把「数组或 Set」统一成 Set，避免在循环里做 O(n) 查找。
function toIdSet(ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return Array.isArray(ids) ? new Set(ids) : (ids as ReadonlySet<string>);
}
