// 分身会话（owner 视角）query options + 展示纯函数单测。
import { describe, it, expect } from "vitest";
import type { ApiClient } from "../api/client";
import type { ApiAvatar, AvatarSessionSummary } from "../api/types";
import {
  avatarSessionKeys,
  ownedAvatarsOptions,
  avatarOwnerSessionsOptions,
  taskMessagesOptions,
  filterOwnedAvatars,
  sessionOutcomeLabel,
  sessionCallerName,
  sessionRowLabel,
  toOwnerSessionRows,
} from "./avatar-sessions";

const fakeApi = {
  listAvatars: async () => ({ avatars: [] }),
  listAvatarSessions: async () => ({ sessions: [] }),
  listTaskMessages: async () => ({ messages: [] }),
} as unknown as ApiClient;

describe("avatarSessionKeys", () => {
  it("key 均含 wsId（切 workspace 不串场）", () => {
    expect(avatarSessionKeys.avatars("ws1")).toEqual(["avatar-sessions", "ws1", "avatars"]);
    expect(avatarSessionKeys.ownerList("ws1", "rt1")).toEqual(["avatar-sessions", "ws1", "owner", "rt1"]);
    expect(avatarSessionKeys.messages("ws1", "t1")).toEqual(["avatar-sessions", "ws1", "messages", "t1"]);
  });
});

describe("query options enabled 闸门", () => {
  it("ownedAvatarsOptions：无 api → disabled；有 api+wsId → enabled", () => {
    expect(ownedAvatarsOptions("ws1", null).enabled).toBe(false);
    expect(ownedAvatarsOptions("", fakeApi).enabled).toBe(false);
    expect(ownedAvatarsOptions("ws1", fakeApi).enabled).toBe(true);
  });
  it("avatarOwnerSessionsOptions：runtimeId 为空 → disabled", () => {
    expect(avatarOwnerSessionsOptions("ws1", fakeApi, "").enabled).toBe(false);
    expect(avatarOwnerSessionsOptions("ws1", null, "rt1").enabled).toBe(false);
    expect(avatarOwnerSessionsOptions("ws1", fakeApi, "rt1").enabled).toBe(true);
  });
  it("avatarOwnerSessionsOptions：owner 视角会话挂载即刷新，空列表也轮询发现新调用", () => {
    const opts = avatarOwnerSessionsOptions("ws1", fakeApi, "rt1");
    expect(opts.staleTime).toBe(0);
    expect(typeof opts.refetchInterval).toBe("function");
    if (typeof opts.refetchInterval === "function") {
      expect(opts.refetchInterval({ state: { data: [] } } as never)).toBe(3000);
    }
  });
  it("taskMessagesOptions：taskId 为空 → disabled", () => {
    expect(taskMessagesOptions("ws1", fakeApi, "").enabled).toBe(false);
    expect(taskMessagesOptions("ws1", fakeApi, "t1").enabled).toBe(true);
  });
});

function avatar(over: Partial<ApiAvatar> = {}): ApiAvatar {
  return {
    runtime_id: "rt1",
    owner: { id: "u1", name: "Me", email: "me@x.com" },
    role_id: "role1",
    role_label: "设计师",
    agent: "claude",
    approval_policy: "auto",
    daily_limit: 20,
    caller_daily_limit: 5,
    daily_used: 0,
    status: "online",
    ...over,
  };
}

describe("filterOwnedAvatars", () => {
  it("仅保留 owner.id 匹配当前用户的分身", () => {
    const list = [
      avatar({ runtime_id: "a", owner: { id: "u1", name: "Me", email: "m" } }),
      avatar({ runtime_id: "b", owner: { id: "u2", name: "Other", email: "o" } }),
    ];
    expect(filterOwnedAvatars(list, "u1").map((a) => a.runtime_id)).toEqual(["a"]);
  });
  it("空 ownerId → 空数组（不误发他人分身请求）", () => {
    expect(filterOwnedAvatars([avatar()], "")).toEqual([]);
  });
});

describe("sessionOutcomeLabel", () => {
  it("终态 → 中文标签", () => {
    expect(sessionOutcomeLabel("done")).toBe("已完成");
    expect(sessionOutcomeLabel("failed")).toBe("执行失败");
  });
  it("null/undefined → 进行中", () => {
    expect(sessionOutcomeLabel(null)).toBe("进行中");
    expect(sessionOutcomeLabel(undefined)).toBe("进行中");
  });
});

function session(over: Partial<AvatarSessionSummary> = {}): AvatarSessionSummary {
  return {
    conversation_id: "conv-1",
    task_id: "t1",
    prompt: "帮我看下方案",
    phase: "accepted",
    outcome: "done",
    turn_count: 1,
    created_at: "2026-07-04T00:00:00Z",
    updated_at: "2026-07-04T00:00:00Z",
    caller_id: "caller-abcdef123",
    caller_name: "Alice",
    ...over,
  };
}

describe("sessionCallerName", () => {
  it("优先 caller_name", () => {
    expect(sessionCallerName(session())).toBe("Alice");
  });
  it("caller_name 缺失 → caller_id 前 8 位", () => {
    expect(sessionCallerName(session({ caller_name: "" }))).toBe("caller-a");
  });
  it("均缺失 → 未知调用者", () => {
    expect(sessionCallerName(session({ caller_name: undefined, caller_id: undefined }))).toBe("未知调用者");
  });
});

describe("sessionRowLabel", () => {
  it("组装会话/调用者/时间/问题摘要/终态标签/轮数", () => {
    expect(sessionRowLabel(session({ turn_count: 3 }))).toEqual({
      conversationId: "conv-1",
      taskId: "t1",
      callerName: "Alice",
      createdAt: "2026-07-04T00:00:00Z",
      updatedAt: "2026-07-04T00:00:00Z",
      promptSummary: "帮我看下方案",
      outcomeLabel: "已完成",
      turnCount: 3,
    });
  });
  it("非终态 outcome=null → 进行中", () => {
    expect(sessionRowLabel(session({ outcome: null })).outcomeLabel).toBe("进行中");
  });
});

describe("toOwnerSessionRows", () => {
  it("按 updated_at 降序（最近活跃在前）", () => {
    const rows = toOwnerSessionRows([
      session({ conversation_id: "old", updated_at: "2026-07-01T00:00:00Z" }),
      session({ conversation_id: "new", updated_at: "2026-07-04T00:00:00Z" }),
    ]);
    expect(rows.map((r) => r.conversationId)).toEqual(["new", "old"]);
  });
});
