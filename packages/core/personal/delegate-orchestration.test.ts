import { describe, expect, it } from "vitest";
import {
  buildAutoSubagentRole,
  buildDelegateOrchestrationGuide,
} from "./delegate-orchestration";

describe("delegate orchestration", () => {
  it("自动子 Agent 使用主会话同款底层 agent", () => {
    expect(buildAutoSubagentRole("pi")).toMatchObject({
      id: "subagent",
      label: "子 Agent",
      agent: "pi",
    });
  });

  it("约束子结果回传同一主会话后再总结输出", () => {
    const guide = buildDelegateOrchestrationGuide(
      [buildAutoSubagentRole("codex")],
      { requireDelegation: true },
    );
    expect(guide).toContain("主会话 Agent");
    expect(guide).toContain("必须先调用");
    expect(guide).toContain("作为工具结果返回给主会话");
    expect(guide).toContain("由你结合主会话上下文总结并输出最终回答");
  });
});
