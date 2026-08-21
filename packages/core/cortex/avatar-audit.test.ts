// 分身审计 query options + 展示纯函数单测。
import { describe, it, expect } from "vitest";
import type { ApiClient } from "../api/client";
import type { AvatarAuditRecord } from "../api/types";
import {
  avatarAuditKeys,
  avatarAuditListOptions,
  summarizePrompt,
  summarizeUsage,
  toAuditRow,
  toAuditRows,
} from "./avatar-audit";

describe("avatarAuditKeys", () => {
  it("key 含 wsId + runtimeId（切 workspace 不串场）", () => {
    expect(avatarAuditKeys.list("ws1")).toEqual(["avatar-audit", "ws1", "list", null]);
    expect(avatarAuditKeys.list("ws1", "rt1")).toEqual(["avatar-audit", "ws1", "list", "rt1"]);
  });
});

describe("avatarAuditListOptions enabled 双闸", () => {
  it("无 apiClient → disabled", () => {
    expect(avatarAuditListOptions("ws1", null).enabled).toBe(false);
  });
  it("有 apiClient + wsId → enabled", () => {
    const api = { listAvatarAudit: async () => ({ records: [] }) } as unknown as ApiClient;
    expect(avatarAuditListOptions("ws1", api).enabled).toBe(true);
  });
  it("wsId 为空 → disabled", () => {
    const api = { listAvatarAudit: async () => ({ records: [] }) } as unknown as ApiClient;
    expect(avatarAuditListOptions("", api).enabled).toBe(false);
  });
});

describe("summarizePrompt", () => {
  it("短文本原样", () => {
    expect(summarizePrompt("你好")).toBe("你好");
  });
  it("超长截断加省略号", () => {
    expect(summarizePrompt("a".repeat(80), 10)).toBe(`${"a".repeat(10)}…`);
  });
});

describe("summarizeUsage", () => {
  it("无 token → —", () => {
    expect(summarizeUsage({ runtime_id: "r", role_label: "l", prompt: "p", task_id: "t" })).toBe("—");
  });
  it("有 token → 入/出", () => {
    expect(
      summarizeUsage({ runtime_id: "r", role_label: "l", prompt: "p", task_id: "t", input_tokens: 100, output_tokens: 42 }),
    ).toBe("入 100 · 出 42");
  });
});

function rec(over: Partial<AvatarAuditRecord> = {}): AvatarAuditRecord {
  return {
    id: "id1",
    action: "avatar.invocation.finished",
    actor_id: "caller-abcdef123",
    caller_name: "Alice",
    created_at: "2026-07-04T00:00:00Z",
    details: { runtime_id: "rt", role_label: "设计师", prompt: "帮我看下方案", task_id: "t1", outcome: "done" },
    ...over,
  };
}

describe("toAuditRow 终态标签", () => {
  it("finished + done → 已完成，用 caller_name", () => {
    const row = toAuditRow(rec());
    expect(row).toMatchObject({ callerName: "Alice", outcomeLabel: "已完成", promptSummary: "帮我看下方案" });
  });
  it("rejected → 超限拒绝", () => {
    expect(toAuditRow(rec({ action: "avatar.invocation.rejected", details: { runtime_id: "r", role_label: "l", prompt: "p", task_id: "t" } })).outcomeLabel).toBe("超限拒绝");
  });
  it("无 outcome 且非 rejected → 进行中", () => {
    expect(toAuditRow(rec({ details: { runtime_id: "r", role_label: "l", prompt: "p", task_id: "t" } })).outcomeLabel).toBe("进行中");
  });
  it("caller_name 缺失 → actor_id 前 8 位", () => {
    expect(toAuditRow(rec({ caller_name: "" })).callerName).toBe("caller-a");
  });
});

describe("toAuditRows 过滤", () => {
  it("只保留 finished / rejected，丢弃中间态 invocation", () => {
    const rows = toAuditRows([
      rec({ id: "a", action: "avatar.invocation" }),
      rec({ id: "b", action: "avatar.invocation.finished" }),
      rec({ id: "c", action: "avatar.invocation.rejected", details: { runtime_id: "r", role_label: "l", prompt: "p", task_id: "t" } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["b", "c"]);
  });
});

// 回归:details.prompt 缺失(历史 finished 行)不得崩溃,显示「—」。
describe("summarizePrompt 可空防御", () => {
  it("undefined/null/空串 → —", () => {
    expect(summarizePrompt(undefined)).toBe("—");
    expect(summarizePrompt(null)).toBe("—");
    expect(summarizePrompt("   ")).toBe("—");
  });
});
