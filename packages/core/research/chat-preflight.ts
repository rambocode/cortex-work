// 会话发送前置管线的编排：改写 + 意图分类（./query-understand）→ 意图 hint / 联网检索
// （./chat-retrieval）。调用点在 core/personal/messages.ts 的发送路径。
//
// **意图理解是一等公民**：只要桥上有 queryUnderstand（且非附件轮、非超长文本），每次发送都跑，
// 不受「研究引擎总开关 / 会话联网 / 总是先检索」限制；greeting/chitchat/follow_up 的英文行为
// 提示（intentHintAppend）也**无条件注入**。联网检索仍是它的可选下游：仅当 shouldAutoRetrieve
// 三开关成立才 gather，此时意图门控检索（skip 意图不搜）、改写查询喂给 gather。
//
// 失败矩阵（红线，与 chat-retrieval 一脉相承）：
//  - understand 与检索都不具备 → 什么都不发生（无状态事件、无时间线条目）；
//  - 改写链路上任何一步失败（未配模型 / IPC 悬挂 / 超时 / 解析失败）= 「**未改写**」而非
//    「检索失败」→ 检索链路存在时原文照旧进检索，绝不阻断发送；
//  - 意图判定跳过检索是**干净语义**：不注任何 evidence 说明（模型完全不知道检索系统存在），
//    只注行为性 intent hint——evidenceAppend 与 intentHintAppend 互斥，结构上由流程保证。
//
// 依赖全部注入（complete/gather/onStatus），本文件可被 vitest 用 fake 完整覆盖。
import type { GatherRequest, GatherResult } from "./quick-types";
import type { ResearchEngineSettings } from "./settings";
import type { QueryUnderstandIpcRequest, QueryUnderstandIpcResponse } from "../desktop/types";
import {
  CHAT_RETRIEVAL_TIMEOUT_MS,
  retrieveChatEvidenceDetailed,
  shouldAutoRetrieve,
} from "./chat-retrieval";
import {
  QUERY_UNDERSTAND_SYSTEM_PROMPT,
  buildUnderstandUserPrompt,
  composeIntentHintAppend,
  needsRetrieval,
  parseQueryUnderstandResult,
  type ChatHistoryTurn,
  type ChatQueryIntent,
} from "./query-understand";

/// renderer 侧对 understand IPC 的兜底超时：主进程自身已有 5s 硬超时，这里多留 1.5s 余量
/// 只防「IPC 本身悬挂」（主进程忙死/通道异常），二者不是重复计时。
export const UNDERSTAND_IPC_TIMEOUT_MS = 6_500;
/// 改写耗时从检索预算里扣（总预算≈15s 与现状持平），但 gather 至少留 8s——
/// 低于它基本抓不回任何文档，等于白等。
export const MIN_GATHER_TIMEOUT_MS = 8_000;
/// 超长文本没有改写价值（多半是粘贴的大段资料），直接跳过 understand，省一次模型调用。
export const MAX_UNDERSTAND_QUERY_CHARS = 2_000;

/// 时间线条目的状态回调（消费方是 core/personal/retrieval-status.ts）。
/// 状态机：understanding → searching → done | failed；understanding → skipped | done。
///  - done 带 documentCount = 检索执行完成；done **不带** documentCount = 本轮只跑了意图理解
///    （检索链路不成立），渲染方显示「已理解问题」；
///  - skipped 只在「检索链路本来成立、但意图判定跳过」时用。
export type PreflightStatus =
  | { phase: "understanding" }
  | { phase: "searching"; query: string; rewritten: boolean }
  | { phase: "done"; documentCount?: number }
  | { phase: "skipped"; intent: Extract<ChatQueryIntent, "greeting" | "chitchat" | "follow_up"> }
  | { phase: "failed"; reason: string };

export interface ChatPreflightInput {
  gather: ((request: GatherRequest) => Promise<GatherResult>) | undefined;
  /// bridge.queryUnderstand；缺失（web/旧壳）→ 本轮无意图理解。
  complete: ((req: QueryUnderstandIpcRequest) => Promise<QueryUnderstandIpcResponse>) | undefined;
  /// 意图理解模型引用（GeneralSettings.queryUnderstandModel，Agent 设置页）。
  /// 缺省 = 主进程回落全局默认模型。
  modelRef?: { providerId: string; modelId: string } | undefined;
  /// 研究引擎设置：**仅用于判断联网检索链路是否成立**（shouldAutoRetrieve 三开关），
  /// 意图理解不读它。
  settings: ResearchEngineSettings | undefined;
  sessionWebSearch: boolean;
  query: string;
  history: ChatHistoryTurn[];
  /// 附件轮跳过改写：小模型看不到附件内容，「分析这个文件」会被误判成 chitchat/unknown。
  hasAttachments: boolean;
  onStatus?: (status: PreflightStatus) => void;
  timeoutMs?: number;
}

/// evidenceAppend 与 intentHintAppend **互斥**：前者是检索轮的证据段（三语义见 chat-retrieval），
/// 后者是非检索意图轮的行为提示。两者都缺 = 本轮无前置管线介入或无需注入。
export interface ChatPreflightResult {
  evidenceAppend?: string;
  intentHintAppend?: string;
}

const UNDERSTAND_TIMEOUT = Symbol("understand-timeout");

/// 跑一轮前置管线。永不 throw：任何异常都被折叠成上面失败矩阵里的某一格。
export async function runChatPreflight(input: ChatPreflightInput): Promise<ChatPreflightResult> {
  const query = input.query.trim();
  if (query.length === 0) return {};

  // 意图理解门槛（一等公民，无功能开关）：桥存在 + 非附件轮 + 非超长文本。
  const understandEligible =
    !!input.complete && !input.hasAttachments && query.length <= MAX_UNDERSTAND_QUERY_CHARS;
  // 联网检索链路：三开关 + 桥。gather 缺失时与旧语义一致——静默不检索，
  // 也**不发 searching 状态**（发了没有后续会留悬挂条目）。
  const retrievalEligible =
    shouldAutoRetrieve(input.settings, input.sessionWebSearch) && !!input.gather;

  if (!understandEligible && !retrievalEligible) return {};

  const baseTimeoutMs = input.timeoutMs ?? CHAT_RETRIEVAL_TIMEOUT_MS;
  let searchQuery = query;
  let rewritten = false;
  let understandElapsedMs = 0;
  let intent: ChatQueryIntent = "unknown";

  if (understandEligible && input.complete) {
    input.onStatus?.({ phase: "understanding" });
    const startedAt = Date.now();
    try {
      const response = await Promise.race([
        input.complete({
          system: QUERY_UNDERSTAND_SYSTEM_PROMPT,
          user: buildUnderstandUserPrompt(input.history, query),
          // 意图理解模型：Agent 设置页选了就用它，留空由主进程回落全局默认模型。
          ...(input.modelRef ? { providerId: input.modelRef.providerId, modelId: input.modelRef.modelId } : {}),
        }),
        new Promise<typeof UNDERSTAND_TIMEOUT>((resolve) =>
          setTimeout(() => resolve(UNDERSTAND_TIMEOUT), UNDERSTAND_IPC_TIMEOUT_MS),
        ),
      ]);
      understandElapsedMs = Date.now() - startedAt;

      if (response !== UNDERSTAND_TIMEOUT && response.ok) {
        const understood = parseQueryUnderstandResult(response.content, query);
        intent = understood.intent;
        searchQuery = understood.searchQuery;
        rewritten = understood.rewritten;
      }
      // 超时 / no-model / error：按「未改写 + unknown 意图」处理（unknown 归需要检索）。
    } catch {
      // complete 抛异常同样按「未改写」处理——改写绝不阻断发送。
      understandElapsedMs = Date.now() - startedAt;
    }
  }

  // 非检索意图的行为提示**无条件注入**（不依赖检索链路是否存在）。
  const intentHintAppend = composeIntentHintAppend(intent);

  if (!needsRetrieval(intent)) {
    // 意图判定无需检索：检索链路成立 → skipped（「本来要检索但意图判定跳过」）；
    // 检索链路不成立 → done（无 documentCount，渲染为「已理解问题」）。
    input.onStatus?.(
      retrievalEligible
        ? {
            phase: "skipped",
            intent: intent as Extract<ChatQueryIntent, "greeting" | "chitchat" | "follow_up">,
          }
        : { phase: "done" },
    );
    return intentHintAppend ? { intentHintAppend } : {};
  }

  if (!retrievalEligible) {
    // 只跑了意图理解、没有检索链路：终态 done（无 documentCount）。understand 失败也走这里
    // ——渲染方的词汇表里没有「理解失败」，且失败已按「未改写」降级，收敛掉即可。
    if (understandEligible) input.onStatus?.({ phase: "done" });
    return {};
  }

  // ── 检索：改写耗时从预算里扣，保证总时长≈现状。──
  const gatherTimeoutMs = Math.max(MIN_GATHER_TIMEOUT_MS, baseTimeoutMs - understandElapsedMs);
  input.onStatus?.({ phase: "searching", query: searchQuery, rewritten });
  const detailed = await retrieveChatEvidenceDetailed({
    gather: input.gather,
    settings: input.settings,
    sessionWebSearch: input.sessionWebSearch,
    query: searchQuery,
    timeoutMs: gatherTimeoutMs,
  });

  if (detailed.outcome === "failed") {
    input.onStatus?.({ phase: "failed", reason: "retrieval-failed" });
  } else {
    // ok / empty 都是「检索执行完成」的终态；disabled 在 retrievalEligible 判定后不可达，
    // 万一出现也按 done(0) 收敛——时间线绝不留悬挂条目。
    input.onStatus?.({ phase: "done", documentCount: detailed.documentCount });
  }
  return detailed.append !== undefined ? { evidenceAppend: detailed.append } : {};
}
