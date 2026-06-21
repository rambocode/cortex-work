// run-retry-policy 单测:decideSafeRunRetry 全部判定分支 + classifyAgentFailure 保守归类。

import { describe, expect, it } from "vitest";
import {
  classifyAgentFailure,
  decideSafeRunRetry,
  type AgentFailure,
  type RunSideEffects,
} from "./run-retry-policy";

const noSide: RunSideEffects = { cancelRequested: false, userVisibleOutputSeen: false, toolCallSeen: false };
const transient: AgentFailure = { category: "upstream_unavailable", retryable: true };

describe("decideSafeRunRetry", () => {
  it("首事件前的瞬态失败(upstream_unavailable)→ 重试", () => {
    expect(decideSafeRunRetry(transient, noSide, 0)).toEqual({ shouldRetry: true, reason: "transient_failure" });
  });

  it("rate_limit 非硬配额 → 重试;硬配额 → 不重试", () => {
    expect(decideSafeRunRetry({ category: "rate_limit", retryable: true }, noSide, 0).shouldRetry).toBe(true);
    expect(decideSafeRunRetry({ category: "rate_limit", retryable: false, hardQuota: true }, noSide, 0)).toEqual({
      shouldRetry: false,
      reason: "hard_quota",
    });
  });

  it("无失败 → not_failed", () => {
    expect(decideSafeRunRetry(null, noSide, 0)).toEqual({ shouldRetry: false, reason: "not_failed" });
  });

  it("被取消 → cancel_requested(优先于一切失败分类)", () => {
    expect(decideSafeRunRetry(transient, { ...noSide, cancelRequested: true }, 0)).toEqual({
      shouldRetry: false,
      reason: "cancel_requested",
    });
  });

  it("非瞬态类别(unknown)→ unsupported_category", () => {
    expect(decideSafeRunRetry({ category: "unknown", retryable: false }, noSide, 0)).toEqual({
      shouldRetry: false,
      reason: "unsupported_category",
    });
  });

  it("瞬态但 retryable=false → not_retryable", () => {
    expect(decideSafeRunRetry({ category: "timeout", retryable: false }, noSide, 0)).toEqual({
      shouldRetry: false,
      reason: "not_retryable",
    });
  });

  it("已达重试上限 → attempt_limit_reached", () => {
    expect(decideSafeRunRetry(transient, noSide, 1)).toEqual({ shouldRetry: false, reason: "attempt_limit_reached" });
  });

  it("已产生可见输出 → user_visible_output_seen", () => {
    expect(decideSafeRunRetry(transient, { ...noSide, userVisibleOutputSeen: true }, 0)).toEqual({
      shouldRetry: false,
      reason: "user_visible_output_seen",
    });
  });

  it("已有工具调用 → tool_call_seen", () => {
    expect(decideSafeRunRetry(transient, { ...noSide, toolCallSeen: true }, 0)).toEqual({
      shouldRetry: false,
      reason: "tool_call_seen",
    });
  });

  it("自定义上限可放宽(maxAttempts=2 时第 1 次仍可重试)", () => {
    expect(decideSafeRunRetry(transient, noSide, 1, 2).shouldRetry).toBe(true);
  });
});

describe("classifyAgentFailure", () => {
  it("限流文本 → rate_limit 可重试", () => {
    expect(classifyAgentFailure({ code: 1, stderrTail: "Error: 429 Too Many Requests", sawAnyOutput: false })).toEqual({
      category: "rate_limit",
      retryable: true,
      hardQuota: false,
    });
  });

  it("配额耗尽 → rate_limit 硬配额不可重试", () => {
    expect(
      classifyAgentFailure({ code: 1, resultError: "rate limit: insufficient quota / billing", sawAnyOutput: false }),
    ).toMatchObject({ category: "rate_limit", retryable: false, hardQuota: true });
  });

  it("网络/上游错误 → upstream_unavailable 可重试", () => {
    expect(classifyAgentFailure({ code: 1, stderrTail: "fetch failed: ECONNRESET", sawAnyOutput: false })).toEqual({
      category: "upstream_unavailable",
      retryable: true,
    });
    expect(classifyAgentFailure({ code: 1, resultError: "503 server error", sawAnyOutput: false }).category).toBe(
      "upstream_unavailable",
    );
  });

  it("0 退出但无任何输出 → empty_output 可重试", () => {
    expect(classifyAgentFailure({ code: 0, sawAnyOutput: false })).toEqual({ category: "empty_output", retryable: true });
  });

  it("0 退出但有输出 → unknown 不可重试(非空完成不是失败类别)", () => {
    expect(classifyAgentFailure({ code: 0, sawAnyOutput: true })).toEqual({ category: "unknown", retryable: false });
  });

  it("无法识别的错误 → unknown 不可重试(保守)", () => {
    expect(classifyAgentFailure({ code: 1, stderrTail: "weird unexpected failure", sawAnyOutput: false })).toEqual({
      category: "unknown",
      retryable: false,
    });
  });
});
