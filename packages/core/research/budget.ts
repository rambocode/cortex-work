// CRE 预算表与夹取（spec §8.1）。
//
// 定位：预算是「研究跑飞」的唯一硬闸门——轮数、查询数、抓取数、时长和发给模型的字符数
// 全部在这里收口。override 的来源包括渲染进程入参、磁盘上的旧配置、甚至模型生成的 plan，
// **一律不可信**，所以本文件的规则是「脏值静默回落基线，绝不抛错」：一次研究请求不该因为
// 某个字段写成 "8" 而整体失败，但也绝不能因此放大预算。
//
// 运行期计数（已用几轮、已抓几篇）不在这里——那是 main 侧编排器的状态，本文件只有纯计算。
import type { ResearchBudget, ResearchMode } from "./types";

/// 预算的全部字段名。运行时遍历用，同时是「新增字段忘了更新夹取逻辑」的编译期守卫：
/// 类型标注为 Record<keyof ResearchBudget, ...> 派生，漏字段会在 BUDGET_KEYS 的 satisfies 处报错。
const BUDGET_KEYS = [
  "maxRounds",
  "maxQueries",
  "maxCandidates",
  "maxDocuments",
  "maxBrowserFetches",
  "maxDurationMs",
  "maxEvidenceCharsToModel",
] as const satisfies readonly (keyof ResearchBudget)[];

/// 除时长外的字段都必须是整数（半轮研究、2.5 个查询都没有意义）。
/// maxDurationMs 例外：毫秒小数无害，强行取整反而会让「按秒配置 × 1000」之类的计算出现意外偏差。
const MAX_DURATION_KEY: keyof ResearchBudget = "maxDurationMs";

/// 三档模式的默认预算（spec §8.1 表格逐字）。
///
/// 表里未给出的两个字段按下述依据自定：
/// - maxCandidates = maxDocuments × 3：候选只是「线索」，抓取前会因去重、robots、私网、
///   媒体类型不支持等被大量淘汰，经验上要 3 倍候选池才填得满目标文档数。
/// - maxEvidenceCharsToModel：quick 20k / standard 60k / deep 120k 字符，约等于 5k / 15k / 30k
///   token，量级对齐主流模型单次上下文的安全区间，同时是来源级 allowCloudModel 之外的第二道
///   出站闸门（即使来源允许出站，也不会把整个抓取库倒给云模型）。
export const MODE_BUDGETS: Record<ResearchMode, ResearchBudget> = {
  quick: {
    maxRounds: 1,
    maxQueries: 4,
    maxCandidates: 24,
    maxDocuments: 8,
    maxBrowserFetches: 1,
    maxDurationMs: 90_000,
    maxEvidenceCharsToModel: 20_000,
  },
  standard: {
    maxRounds: 3,
    maxQueries: 16,
    maxCandidates: 72,
    maxDocuments: 24,
    maxBrowserFetches: 5,
    maxDurationMs: 600_000,
    maxEvidenceCharsToModel: 60_000,
  },
  deep: {
    maxRounds: 5,
    maxQueries: 32,
    maxCandidates: 150,
    maxDocuments: 50,
    maxBrowserFetches: 10,
    maxDurationMs: 1_800_000,
    maxEvidenceCharsToModel: 120_000,
  },
};

/// 全局硬上限：**任何用户覆盖都会被夹到它以内**，没有例外，也不提供「解除限制」开关。
///
/// 取值依据：约为 deep 档的 2~3 倍，留出重度用户手动加码的空间，同时保证单个 Session 的
/// 最坏情况仍然可控——最长 1 小时、最多 100 篇文档、最多 20 次 Browser 抓取（Browser 是
/// 最贵的降级路径），出站字符数不超过 240k。上调任一值前先确认 Search Server 配额与
/// 本地磁盘/内存占用能承受最坏情况。
export const HARD_BUDGET_CEILING: ResearchBudget = {
  maxRounds: 10,
  maxQueries: 64,
  maxCandidates: 300,
  maxDocuments: 100,
  maxBrowserFetches: 20,
  maxDurationMs: 3_600_000,
  maxEvidenceCharsToModel: 240_000,
};

/// 单个字段的夹取：合法就取 min(值, 硬上限)，不合法就回落基线值。
///
/// 「不合法」刻意定义得很宽：非 number、NaN、±Infinity、小于 1、以及（时长以外的）非整数。
/// 注意 0 与负数走的是**回落基线**而不是「夹到 1」——用户写 0 更可能是配置错误或
/// 序列化丢值，把它当成「只跑 1 轮」会得到一个必然失败的研究，回落到基线才是符合意图的解释。
function clampBudgetField(key: keyof ResearchBudget, raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return fallback;
  if (key !== MAX_DURATION_KEY && !Number.isInteger(raw)) return fallback;
  return Math.min(raw, HARD_BUDGET_CEILING[key]);
}

/// 按模式取基线预算，再用 override 逐字段夹取，得到本次 Session 的最终预算。
///
/// 契约：永不抛错、永不返回超过 HARD_BUDGET_CEILING 的值、永远返回新对象
/// （调用方常把它塞进 ResearchPlan 后就地修改运行期计数，共享引用会污染 MODE_BUDGETS）。
/// 未知 mode（来自旧持久化数据或手改配置）回落到最保守的 quick，宁可少跑也不要跑飞。
export function clampResearchBudget(
  mode: ResearchMode,
  override?: Partial<ResearchBudget>,
): ResearchBudget {
  const baseline = MODE_BUDGETS[mode] ?? MODE_BUDGETS.quick;
  const result: ResearchBudget = { ...baseline };
  if (typeof override !== "object" || override === null) return result;

  for (const key of BUDGET_KEYS) {
    const raw: unknown = (override as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    result[key] = clampBudgetField(key, raw, baseline[key]);
  }
  return result;
}
