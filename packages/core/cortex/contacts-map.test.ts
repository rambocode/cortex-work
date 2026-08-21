import { describe, expect, it } from "vitest";
import { mapAvatarsToContacts, type AvatarContactMember } from "./contacts-map";
import type { ApiAvatar, ApiAvatarStatus } from "../api/types";

// 构造 ApiAvatar 夹具：仅覆盖映射关心的字段，其余给合法默认值。
function makeAvatar(over: Partial<ApiAvatar> & { runtime_id: string; owner: ApiAvatar["owner"] }): ApiAvatar {
  return {
    role_id: "role-1",
    role_label: "codex",
    agent: "codex",
    approval_policy: "auto",
    daily_limit: 20,
    caller_daily_limit: 5,
    daily_used: 0,
    status: "online",
    ...over,
  };
}

const alice: ApiAvatar["owner"] = { id: "u-alice", name: "Alice", email: "alice@x.io" };
const bob: ApiAvatar["owner"] = { id: "u-bob", name: "Bob", email: "bob@x.io" };

describe("mapAvatarsToContacts — 层级展开", () => {
  it("0 分身且无 members → 空数组（零成员空态由消费端处理）", () => {
    expect(mapAvatarsToContacts([])).toEqual([]);
  });

  it("1 分身 → 1 human + 1 avatar，顺序为 [human, avatar]", () => {
    const out = mapAvatarsToContacts([makeAvatar({ runtime_id: "rt-1", owner: alice })]);
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe("human");
    expect(out[0]!.id).toBe("u-alice");
    expect(out[1]!.kind).toBe("avatar");
    // 分身 Contact.id 必须等于 runtime_id（契约硬约定）。
    expect(out[1]!.id).toBe("rt-1");
    expect(out[1]!.runtimeId).toBe("rt-1");
    // 分身挂靠到拥有者。
    expect(out[1]!.ownerId).toBe("u-alice");
    expect(out[1]!.ownerName).toBe("Alice");
  });

  it("多分身同一 owner → 1 human 后跟其全部 avatar，按入参顺序", () => {
    const out = mapAvatarsToContacts([
      makeAvatar({ runtime_id: "rt-1", owner: alice, role_label: "codex" }),
      makeAvatar({ runtime_id: "rt-2", owner: alice, role_label: "claude" }),
    ]);
    expect(out.map((c) => c.id)).toEqual(["u-alice", "rt-1", "rt-2"]);
    expect(out.filter((c) => c.kind === "human")).toHaveLength(1);
  });

  it("多 owner → 按首现顺序分段，每段 human 领头", () => {
    const out = mapAvatarsToContacts([
      makeAvatar({ runtime_id: "rt-a", owner: alice }),
      makeAvatar({ runtime_id: "rt-b", owner: bob }),
    ]);
    expect(out.map((c) => `${c.kind}:${c.id}`)).toEqual([
      "human:u-alice",
      "avatar:rt-a",
      "human:u-bob",
      "avatar:rt-b",
    ]);
  });

  it("members 传入 → 零分身成员也展开为 human（无 avatar 子项），且以 members 顺序为准", () => {
    const members: AvatarContactMember[] = [
      { id: "u-bob", name: "Bob" },
      { id: "u-alice", name: "Alice" },
    ];
    const out = mapAvatarsToContacts([makeAvatar({ runtime_id: "rt-a", owner: alice })], members);
    // Bob 无分身但在列（空态由视图呈现）；顺序跟随 members。
    expect(out.map((c) => `${c.kind}:${c.id}`)).toEqual(["human:u-bob", "human:u-alice", "avatar:rt-a"]);
  });
});

describe("mapAvatarsToContacts — 三态在线映射", () => {
  const cases: Array<[ApiAvatarStatus, string]> = [
    ["online", "online"],
    ["online_unavailable", "unavailable"],
    ["offline", "offline"],
  ];
  it.each(cases)("status=%s → agentStatus=%s", (status, expected) => {
    const out = mapAvatarsToContacts([makeAvatar({ runtime_id: "rt-1", owner: alice, status })]);
    expect(out[1]!.agentStatus).toBe(expected);
  });

  it("AE11：unavailable 与 offline 是不同枚举，可区分呈现", () => {
    const out = mapAvatarsToContacts([
      makeAvatar({ runtime_id: "rt-un", owner: alice, status: "online_unavailable" }),
      makeAvatar({ runtime_id: "rt-off", owner: alice, status: "offline" }),
    ]);
    const un = out.find((c) => c.id === "rt-un")!;
    const off = out.find((c) => c.id === "rt-off")!;
    expect(un.agentStatus).toBe("unavailable");
    expect(off.agentStatus).toBe("offline");
    expect(un.agentStatus).not.toBe(off.agentStatus);
  });
});

describe("mapAvatarsToContacts — 可聊/不可聊语义", () => {
  it("AE4：human 条目 kind=human（视图据此禁聊 + 降级提示）", () => {
    const out = mapAvatarsToContacts([makeAvatar({ runtime_id: "rt-1", owner: alice })]);
    const human = out.find((c) => c.kind === "human")!;
    expect(human.kind).toBe("human");
    // human 不携带 runtimeId（无可发起的分身运行时）。
    expect(human.runtimeId).toBeUndefined();
  });

  it("AE1：离线分身仍产出 avatar 条目，但 agentStatus=offline 供视图禁止发起", () => {
    const out = mapAvatarsToContacts([makeAvatar({ runtime_id: "rt-1", owner: alice, status: "offline" })]);
    const avatar = out.find((c) => c.kind === "avatar")!;
    expect(avatar.kind).toBe("avatar");
    expect(avatar.agentStatus).toBe("offline");
  });
});
