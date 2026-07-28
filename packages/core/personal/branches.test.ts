// branches.ts 纯函数单测:加载归一、tail 切分/归并、anchor 归属、刷新建组/切换的数据变换。
import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import {
  normalizeLoadedChat,
  splitAtAnchor,
  mergeTail,
  anchorForAgentMessage,
  isFirstAgentReplyOfTail,
  isLastAgentReplyOfTail,
  pagerPosition,
  upsertRegenerate,
  applySwitch,
  packChatForSave,
  sanitizeBranchGroups,
  type BranchGroup,
  type BranchVariant,
} from "./branches";

function user(uid: string, text = "问题"): Message {
  return { kind: "text", who: "me", time: "10:00", text, uid };
}
function agent(uid: string, text = "回复"): Message {
  return { kind: "text", who: "pi", time: "10:01", text, uid };
}
function variant(id: string, tail: Message[] | null = null): BranchVariant {
  return { id, createdAt: 1, tail, pointer: tail ? { piSessionFile: `/snap/${id}.jsonl` } : null };
}

describe("normalizeLoadedChat 加载归一(v1/v2 兼容)", () => {
  it("v1 裸数组 → messages + 空分支", () => {
    const msgs = [user("u1")];
    expect(normalizeLoadedChat(msgs)).toEqual({ messages: msgs, branchGroups: [] });
  });
  it("v2 对象 → 拆 messages/branchGroups", () => {
    const msgs = [user("u1")];
    const groups: BranchGroup[] = [{ anchorUid: "u1", activeId: "b2", variants: [variant("b1", []), variant("b2")] }];
    expect(normalizeLoadedChat({ version: 2, messages: msgs, branchGroups: groups })).toEqual({
      messages: msgs,
      branchGroups: groups,
    });
  });
  it("非法输入(null/对象缺字段) → 全空", () => {
    expect(normalizeLoadedChat(null)).toEqual({ messages: [], branchGroups: [] });
    expect(normalizeLoadedChat(undefined)).toEqual({ messages: [], branchGroups: [] });
    expect(normalizeLoadedChat({ version: 2 } as never)).toEqual({ messages: [], branchGroups: [] });
  });
});

describe("splitAtAnchor / mergeTail 切分与归并", () => {
  const msgs = [user("u1"), agent("a1"), user("u2"), agent("a2")];
  it("head 含 anchor 本身,tail 是其后的整段(可含后续多轮)", () => {
    const r = splitAtAnchor(msgs, "u1")!;
    expect(r.head.map((m) => m.uid)).toEqual(["u1"]);
    expect(r.tail.map((m) => m.uid)).toEqual(["a1", "u2", "a2"]);
  });
  it("切分-归并往返无损", () => {
    const r = splitAtAnchor(msgs, "u2")!;
    expect(mergeTail(r.head, r.tail)).toEqual(msgs);
  });
  it("anchor 不存在 → null", () => {
    expect(splitAtAnchor(msgs, "nope")).toBeNull();
  });
});

describe("anchorForAgentMessage / isFirstAgentReplyOfTail 归属判定", () => {
  const msgs = [user("u1"), agent("a1"), agent("a1b"), user("u2"), agent("a2")];
  it("agent 消息归属最近的前置用户消息", () => {
    expect(anchorForAgentMessage(msgs, "a1")).toBe("u1");
    expect(anchorForAgentMessage(msgs, "a1b")).toBe("u1");
    expect(anchorForAgentMessage(msgs, "a2")).toBe("u2");
  });
  it("只有 anchor 后第一条 agent 文本回复算 first(分页器只挂一处)", () => {
    expect(isFirstAgentReplyOfTail(msgs, "a1")).toBe(true);
    expect(isFirstAgentReplyOfTail(msgs, "a1b")).toBe(false);
    expect(isFirstAgentReplyOfTail(msgs, "a2")).toBe(true);
  });
  it("非文本消息(day 等)不阻断向前扫描", () => {
    const withDay: Message[] = [user("u1"), { kind: "day", label: "今天" } as Message, agent("a1")];
    expect(anchorForAgentMessage(withDay, "a1")).toBe("u1");
    expect(isFirstAgentReplyOfTail(withDay, "a1")).toBe(true);
  });
});

describe("isLastAgentReplyOfTail 轮末条判定(操作条挂点)", () => {
  it("一轮多段输出:只有末段算 last,中间段不算", () => {
    const msgs = [user("u1"), agent("a1"), agent("a1b"), agent("a1c")];
    expect(isLastAgentReplyOfTail(msgs, "a1")).toBe(false);
    expect(isLastAgentReplyOfTail(msgs, "a1b")).toBe(false);
    expect(isLastAgentReplyOfTail(msgs, "a1c")).toBe(true);
  });
  it("文本段之间夹 agentLog/todoList 等非 text 消息不影响判定", () => {
    const msgs: Message[] = [
      user("u1"),
      agent("a1"),
      { kind: "agentLog", who: "pi", time: "10:01", title: "执行", items: [] },
      { kind: "todoList", who: "pi", time: "10:01", runId: "r1", todos: [] },
      agent("a1b"),
      { kind: "typing", who: "pi" } as Message,
    ];
    expect(isLastAgentReplyOfTail(msgs, "a1")).toBe(false);
    // 末段之后只剩非 text 消息(工具日志 / typing)→ 仍是本轮末条。
    expect(isLastAgentReplyOfTail(msgs, "a1b")).toBe(true);
  });
  it("消息在列表末尾 → last", () => {
    const msgs = [user("u1"), agent("a1")];
    expect(isLastAgentReplyOfTail(msgs, "a1")).toBe(true);
  });
  it("后面跟着下一轮用户消息 → 仍是本轮末条(历史轮保留操作条)", () => {
    const msgs = [user("u1"), agent("a1"), agent("a1b"), user("u2"), agent("a2")];
    expect(isLastAgentReplyOfTail(msgs, "a1")).toBe(false);
    expect(isLastAgentReplyOfTail(msgs, "a1b")).toBe(true);
    expect(isLastAgentReplyOfTail(msgs, "a2")).toBe(true);
  });
  it("uid 不存在 / uid 指向用户消息 → false", () => {
    const msgs = [user("u1"), agent("a1")];
    expect(isLastAgentReplyOfTail(msgs, "nope")).toBe(false);
    expect(isLastAgentReplyOfTail(msgs, "u1")).toBe(false);
  });
});

describe("upsertRegenerate 刷新建组/扩组", () => {
  it("首刷:建组,归档旧 live + 新 live 变体,active 指向新", () => {
    const archived = variant("b1", [agent("a1")]);
    const fresh = variant("b2");
    const groups = upsertRegenerate([], "u1", archived, fresh);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.activeId).toBe("b2");
    expect(groups[0]!.variants.map((v) => v.id)).toEqual(["b1", "b2"]);
    expect(pagerPosition(groups[0]!)).toEqual({ index: 2, total: 2 });
  });
  it("再刷:物化当前 active,追加新 live", () => {
    const g0 = upsertRegenerate([], "u1", variant("b1", [agent("a1")]), variant("b2"));
    // 第二次刷新:b2 物化(填 tail),b3 成为新 live。
    const groups = upsertRegenerate(g0, "u1", variant("b2", [agent("a2")]), variant("b3"));
    const g = groups[0]!;
    expect(g.activeId).toBe("b3");
    expect(g.variants.map((v) => v.id)).toEqual(["b1", "b2", "b3"]);
    expect(g.variants.find((v) => v.id === "b2")!.tail).toEqual([agent("a2")]);
    expect(g.variants.find((v) => v.id === "b3")!.tail).toBeNull();
  });
  it("不同 anchor 的组互不影响(嵌套/多点刷新)", () => {
    const g0 = upsertRegenerate([], "u1", variant("b1", []), variant("b2"));
    const groups = upsertRegenerate(g0, "u2", variant("c1", []), variant("c2"));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.anchorUid).toBe("u1");
    expect(groups[1]!.anchorUid).toBe("u2");
  });
});

describe("applySwitch 切换分支", () => {
  const base = upsertRegenerate([], "u1", variant("b1", [agent("a1", "旧回复")]), variant("b2"));
  it("active 物化写回,target 转 live(tail/pointer 清空),返回物化前的 target", () => {
    const materialized = variant("b2", [agent("a2", "新回复")]);
    const r = applySwitch(base, "u1", materialized, "b1")!;
    expect(r.target.tail).toEqual([agent("a1", "旧回复")]);
    expect(r.target.pointer?.piSessionFile).toBe("/snap/b1.jsonl");
    const g = r.groups[0]!;
    expect(g.activeId).toBe("b1");
    expect(g.variants.find((v) => v.id === "b1")!.tail).toBeNull();
    expect(g.variants.find((v) => v.id === "b2")!.tail).toEqual([agent("a2", "新回复")]);
  });
  it("target 不存在 / 已是 active / 物化 id 不符 → null", () => {
    expect(applySwitch(base, "u1", variant("b2", []), "nope")).toBeNull();
    expect(applySwitch(base, "u1", variant("b2", []), "b2")).toBeNull();
    expect(applySwitch(base, "u1", variant("bX", []), "b1")).toBeNull();
  });
});

describe("packChatForSave / sanitizeBranchGroups 落盘打包", () => {
  it("无分支写 v1 裸数组,有分支写 v2 对象", () => {
    const msgs = [user("u1")];
    expect(packChatForSave(msgs, [])).toBe(msgs);
    const groups = upsertRegenerate([], "u1", variant("b1", []), variant("b2"));
    expect(packChatForSave(msgs, groups)).toEqual({ version: 2, messages: msgs, branchGroups: groups });
  });
  it("归档 tail 过 sanitize(剥瞬态),active(tail=null)原样", () => {
    const groups = upsertRegenerate([], "u1", variant("b1", [agent("a1"), { kind: "typing", who: "pi" } as Message]), variant("b2"));
    const cleaned = sanitizeBranchGroups(groups, (ms) => ms.filter((m) => m.kind === "text"));
    expect(cleaned[0]!.variants.find((v) => v.id === "b1")!.tail).toEqual([agent("a1")]);
    expect(cleaned[0]!.variants.find((v) => v.id === "b2")!.tail).toBeNull();
  });
});
