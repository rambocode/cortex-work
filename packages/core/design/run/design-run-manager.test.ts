import { describe, expect, it } from "vitest";
import { resolveDesignRunAgent } from "./design-run-manager";
import type { PersonalState } from "../../store/personal";

// 构造 resolveDesignRunAgent 所需的最小 personal 切片（只填被读到的字段）。
function slice(input: {
  agent?: string;
  derivedAgentId?: string;
  defaultAgent?: PersonalState["generalSettings"]["defaultAgent"];
  agentsAvailable?: PersonalState["agentsAvailable"];
  derivedAgents?: PersonalState["derivedAgents"];
}): Pick<PersonalState, "designSettings" | "generalSettings" | "agentsAvailable" | "derivedAgents"> {
  return {
    designSettings: { agent: input.agent ?? "", derivedAgentId: input.derivedAgentId ?? "" } as PersonalState["designSettings"],
    generalSettings: { defaultAgent: input.defaultAgent } as PersonalState["generalSettings"],
    agentsAvailable: input.agentsAvailable,
    derivedAgents: input.derivedAgents,
  };
}

describe("resolveDesignRunAgent", () => {
  it("显式选择优先", () => {
    expect(resolveDesignRunAgent(slice({ agent: "codex", agentsAvailable: { codex: true } }))).toEqual({
      agent: "codex",
      derivedId: undefined,
    });
  });

  it("未设置时跟随系统「新会话默认 Agent」", () => {
    expect(
      resolveDesignRunAgent(slice({ agent: "", defaultAgent: "claude", agentsAvailable: { claude: true } })),
    ).toEqual({ agent: "claude", derivedId: undefined });
  });

  it("显式选择不做可用性静默回落(探测可能误判;真不可用由 spawn 前置校验明确报错)", () => {
    // 此前 claude 探测为 false 会悄悄换 codex → UI 显示 claude 实跑 codex,静默分歧极难排查。
    expect(
      resolveDesignRunAgent(slice({ agent: "claude", agentsAvailable: { claude: false, codex: true } })).agent,
    ).toBe("claude");
  });

  it("derivedAgentId 必须仍在派生列表中才返回", () => {
    expect(
      resolveDesignRunAgent(
        slice({
          agent: "claude",
          derivedAgentId: "my-x",
          agentsAvailable: { claude: true },
          derivedAgents: [{ id: "my-x", base: "claude" }],
        }),
      ).derivedId,
    ).toBe("my-x");
    // 派生 id 已失效（不在列表）→ 不返回。
    expect(
      resolveDesignRunAgent(
        slice({ agent: "claude", derivedAgentId: "ghost", agentsAvailable: { claude: true }, derivedAgents: [] }),
      ).derivedId,
    ).toBeUndefined();
  });
});
