import { describe, expect, it } from "vitest";
import type { DerivedAgentMeta, ProviderSettings, SessionMeta } from "@cortex-work/core";
import { agentDisplayAvatar, agentDisplayLabel, baseAgentOf, buildAgentSwitchPatch } from "./agentMeta";

const derived: DerivedAgentMeta[] = [
  { id: "my-codex", base: "codex", label: "My Codex" },
  { id: "bare", base: "claude" }, // 无 label
];

const providers: ProviderSettings = { providers: [], defaultProviderId: undefined, defaultModel: undefined };

function sess(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s",
    title: "t",
    agent: "claude",
    agentSessionIds: { claude: "c1", codex: "x1" },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("baseAgentOf", () => {
  it("内置→自身;派生→base;未知→claude", () => {
    expect(baseAgentOf("codex", derived)).toBe("codex");
    expect(baseAgentOf("my-codex", derived)).toBe("codex");
    expect(baseAgentOf("ghost", derived)).toBe("claude");
    expect(baseAgentOf("x", undefined)).toBe("claude");
  });
});

describe("agentDisplayLabel", () => {
  it("内置用 AGENT_LABEL", () => {
    expect(agentDisplayLabel("claude", derived)).toBe("Claude Code");
  });
  it("派生有 label 用 label,无 label 用 id", () => {
    expect(agentDisplayLabel("my-codex", derived)).toBe("My Codex");
    expect(agentDisplayLabel("bare", derived)).toBe("bare");
  });
  it("未知 id 兜底显示 id", () => {
    expect(agentDisplayLabel("ghost", derived)).toBe("ghost");
  });
});

describe("agentDisplayAvatar", () => {
  it("派生复用 base 头像", () => {
    expect(agentDisplayAvatar("my-codex", derived)).toEqual(agentDisplayAvatar("codex", derived));
  });
});

describe("buildAgentSwitchPatch（U7）", () => {
  it("切到派生:agent=base、derivedAgentId=id、model=base 默认、清 base resume 槽", () => {
    const patch = buildAgentSwitchPatch(sess(), "codex", providers, derived[0]);
    expect(patch.agent).toBe("codex");
    expect(patch.derivedAgentId).toBe("my-codex");
    expect(patch.model).toBeDefined();
    expect(patch.agentSessionIds?.codex).toBeUndefined(); // base 槽被清
    expect(patch.agentSessionIds?.claude).toBe("c1"); // 其它槽保留
  });

  it("切回内置:derivedAgentId 显式清空", () => {
    const patch = buildAgentSwitchPatch(sess({ derivedAgentId: "my-codex", agent: "codex" }), "claude", providers);
    expect(patch.agent).toBe("claude");
    expect(patch.derivedAgentId).toBeUndefined();
    expect(patch.agentSessionIds?.claude).toBeUndefined(); // 切到的 base 槽清
  });
});
