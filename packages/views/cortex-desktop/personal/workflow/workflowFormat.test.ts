// 工作流格式化纯函数单测。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatNodeCount,
  formatWorkflowStatus,
  formatRelativeTime,
  formatRunResultSummary,
} from "./workflowFormat";

// ── formatNodeCount ──────────────────────────────────────────────────────────

describe("formatNodeCount", () => {
  it("0 个节点", () => {
    expect(formatNodeCount(0)).toBe("0 个节点");
  });

  it("1 个节点", () => {
    expect(formatNodeCount(1)).toBe("1 个节点");
  });

  it("10 个节点", () => {
    expect(formatNodeCount(10)).toBe("10 个节点");
  });

  it("负数视作 0", () => {
    expect(formatNodeCount(-5)).toBe("0 个节点");
  });
});

// ── formatWorkflowStatus ─────────────────────────────────────────────────────

describe("formatWorkflowStatus", () => {
  it("idle → 空闲/default", () => {
    const r = formatWorkflowStatus("idle");
    expect(r.label).toBe("空闲");
    expect(r.variant).toBe("default");
  });

  it("running → 运行中/pending", () => {
    const r = formatWorkflowStatus("running");
    expect(r.label).toBe("运行中");
    expect(r.variant).toBe("pending");
  });

  it("success → 成功/success", () => {
    const r = formatWorkflowStatus("success");
    expect(r.label).toBe("成功");
    expect(r.variant).toBe("success");
  });

  it("error → 失败/error", () => {
    const r = formatWorkflowStatus("error");
    expect(r.label).toBe("失败");
    expect(r.variant).toBe("error");
  });
});

// ── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-06-25T10:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("null → —", () => {
    expect(formatRelativeTime(null)).toBe("—");
  });

  it("undefined → —", () => {
    expect(formatRelativeTime(undefined)).toBe("—");
  });

  it("空字符串 → —", () => {
    expect(formatRelativeTime("")).toBe("—");
  });

  it("无效 ISO 字符串 → 返回原文", () => {
    expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
  });

  it("30 秒前 → 刚刚", () => {
    const d = new Date(NOW - 30_000).toISOString();
    expect(formatRelativeTime(d)).toBe("刚刚");
  });

  it("5 分钟前", () => {
    const d = new Date(NOW - 5 * 60_000).toISOString();
    expect(formatRelativeTime(d)).toBe("5 分钟前");
  });

  it("3 小时前", () => {
    const d = new Date(NOW - 3 * 3_600_000).toISOString();
    expect(formatRelativeTime(d)).toBe("3 小时前");
  });

  it("2 天前", () => {
    const d = new Date(NOW - 2 * 86_400_000).toISOString();
    expect(formatRelativeTime(d)).toBe("2 天前");
  });

  it("接受 Date 对象", () => {
    const d = new Date(NOW - 61_000);
    expect(formatRelativeTime(d)).toBe("1 分钟前");
  });
});

// ── formatRunResultSummary ───────────────────────────────────────────────────

describe("formatRunResultSummary", () => {
  it("null → 空串", () => {
    expect(formatRunResultSummary(null)).toBe("");
  });

  it("undefined → 空串", () => {
    expect(formatRunResultSummary(undefined)).toBe("");
  });

  it("空白字符串 → 空串", () => {
    expect(formatRunResultSummary("   ")).toBe("");
  });

  it("短文本原样返回", () => {
    expect(formatRunResultSummary("OK")).toBe("OK");
  });

  it("超过 240 字符时截断并加省略号", () => {
    const long = "a".repeat(300);
    const result = formatRunResultSummary(long);
    expect(result).toBe("a".repeat(240) + "…");
  });

  it("自定义 maxLen", () => {
    const result = formatRunResultSummary("hello world", 5);
    expect(result).toBe("hello…");
  });

  it("正好等于 maxLen 不截断", () => {
    const str = "a".repeat(10);
    expect(formatRunResultSummary(str, 10)).toBe(str);
  });
});
