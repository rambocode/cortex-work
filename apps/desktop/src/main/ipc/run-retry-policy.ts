// 副作用感知安全重试策略(U7)。判定顺序移植自 open-design run-retry-policy 的 decideSafeRunRetry,
// 改用 cortex-local 类型(不依赖 @open-design/contracts)。核心原则:仅对「首个可见输出/工具调用
// 之前」的瞬态失败自动重试;一旦已产生用户可见文本 / 工具调用 / 被取消,绝不重试 —— 避免重复副作用
// 或覆盖已交付内容。因为重试必然发生在无可见输出时,故重试不会污染渲染端已累积的折叠状态,也无需
// 处理半截会话续接。

export type AgentFailureCategory = "rate_limit" | "upstream_unavailable" | "timeout" | "empty_output" | "unknown";

export interface AgentFailure {
  category: AgentFailureCategory;
  retryable: boolean; // 分类器给出的可重试性(保守:未识别 = false)
  hardQuota?: boolean; // rate_limit 的硬配额(余额耗尽等,不可重试)
}

export interface RunSideEffects {
  cancelRequested: boolean; // 被用户取消 / 看门狗杀(进程被信号终止)
  userVisibleOutputSeen: boolean; // 本次 attempt 已产生可见文本
  toolCallSeen: boolean; // 本次 attempt 已发生工具调用
}

// 默认最多 1 次同-run 自动重试(不含首跑)。
export const DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS = 1;

export type RetryDecision = { shouldRetry: boolean; reason: string };

// 瞬态可重试类别。timeout/empty_output 仅在「首事件前」有意义,这一点由调用方的副作用门
//(userVisibleOutputSeen / toolCallSeen)实际保证 —— 已有输出后这两类不会再走到重试分支。
function isTransientCategory(f: AgentFailure): boolean {
  switch (f.category) {
    case "rate_limit":
      return !f.hardQuota;
    case "upstream_unavailable":
    case "timeout":
    case "empty_output":
      return true;
    default:
      return false;
  }
}

// 判定是否安全重试。任一条件命中即抑制,顺序与文档(plan U7)一致。
export function decideSafeRunRetry(
  failure: AgentFailure | null,
  side: RunSideEffects,
  attemptCount: number,
  maxAttempts: number = DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS,
): RetryDecision {
  if (!failure) return { shouldRetry: false, reason: "not_failed" };
  if (side.cancelRequested) return { shouldRetry: false, reason: "cancel_requested" };
  if (failure.hardQuota) return { shouldRetry: false, reason: "hard_quota" };
  if (!isTransientCategory(failure)) return { shouldRetry: false, reason: "unsupported_category" };
  if (!failure.retryable) return { shouldRetry: false, reason: "not_retryable" };
  if (attemptCount >= maxAttempts) return { shouldRetry: false, reason: "attempt_limit_reached" };
  if (side.userVisibleOutputSeen) return { shouldRetry: false, reason: "user_visible_output_seen" };
  if (side.toolCallSeen) return { shouldRetry: false, reason: "tool_call_seen" };
  return { shouldRetry: true, reason: "transient_failure" };
}

// 把 cortex 现有失败信号(exit code / stderr 尾窗 / result.error)保守归一为失败类别。
// 首版刻意保守:只识别有把握的瞬态模式(限流 / 上游不可用 / 0 退出但无任何输出),其余一律
// category:"unknown" + retryable:false。识别不出 → 不重试,宁可漏重试也不误重试(避免重复副作用)。
// 待积累 claude/codex 真实失败样本后再放宽(见 plan Open Questions)。
export function classifyAgentFailure(input: {
  code: number | null;
  stderrTail?: string;
  resultError?: string;
  sawAnyOutput: boolean;
}): AgentFailure {
  const text = `${input.stderrTail ?? ""}\n${input.resultError ?? ""}`.toLowerCase();
  // 限流 / 过载。硬配额(余额/额度耗尽)不可重试。
  if (/rate.?limit|\b429\b|\b529\b|too many requests|overloaded/.test(text)) {
    const hardQuota = /quota|insufficient|exceeded|billing|credit/.test(text);
    return { category: "rate_limit", retryable: !hardQuota, hardQuota };
  }
  // 上游 / 网络瞬断。
  if (/network|connection|econn|etimedout|socket hang up|\b50[234]\b|upstream|fetch failed|server error/.test(text)) {
    return { category: "upstream_unavailable", retryable: true };
  }
  // 0 退出但全程无任何输出(首 token 前空完成)。
  if (input.code === 0 && !input.sawAnyOutput) {
    return { category: "empty_output", retryable: true };
  }
  return { category: "unknown", retryable: false };
}
