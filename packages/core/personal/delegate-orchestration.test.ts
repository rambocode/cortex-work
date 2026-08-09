import { describe, expect, it } from "vitest";
import {
  buildAutoSubagentRole,
  buildConfiguredSubagentRoles,
  buildDelegateOrchestrationGuide,
} from "./delegate-orchestration";
import { normalizeSubagentSettings } from "./subagents";

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
    expect(guide).toContain("用户已显式点名协作者");
    expect(guide).toContain("必须调用对应的 ask_ 工具");
    expect(guide).toContain("作为工具结果返回给主会话");
    expect(guide).toContain("由你结合主会话上下文总结并输出最终回答");
  });

  it("普通会话由主模型自行决定是否调用、调用角色和数量", () => {
    const guide = buildDelegateOrchestrationGuide(
      [buildAutoSubagentRole("codex")],
      { requireDelegation: false },
    );
    expect(guide).toContain("你自行判断本轮是否需要协作、调用哪些协作者以及调用多少次");
    expect(guide).toContain("不需要时直接完成任务");
    expect(guide).not.toContain("必须调用");
  });

  it("归一化 Kun 运行上限，旧存档补默认值且非法输入被钳制", () => {
    expect(normalizeSubagentSettings(undefined)).toMatchObject({ maxParallel: 256, maxChildRuns: 25 });
    expect(normalizeSubagentSettings({ maxParallel: 0, maxChildRuns: 20_000 })).toMatchObject({
      maxParallel: 1,
      maxChildRuns: 10_000,
    });
  });

  it("使用现有代理时注入 Kun 的 8 个基础角色并应用运行覆盖", () => {
    const roles = buildConfiguredSubagentRoles("pi", {
      useExistingAgents: true,
      extensionAgentsEnabled: false,
      profiles: {
        "code-reviewer": { agent: "codex", model: "gpt-5.4", effort: "high", systemPrompt: "优先找阻断项" },
      },
    });
    expect(roles).toHaveLength(8);
    expect(roles.map((role) => role.id)).toContain("explore");
    expect(roles.find((role) => role.id === "code-reviewer")).toMatchObject({
      agent: "codex",
      model: "gpt-5.4",
      effort: "high",
      color: "#2563eb",
      toolPolicy: "readOnly",
    });
    expect(roles.find((role) => role.id === "code-reviewer")?.systemPrompt).toContain("优先找阻断项");
  });

  it("关闭使用现有代理时退回单个匿名角色；扩展开关开启后只加入逐项启用角色", () => {
    expect(buildConfiguredSubagentRoles("claude", {
      useExistingAgents: false,
      extensionAgentsEnabled: true,
      profiles: {},
    })).toEqual([buildAutoSubagentRole("claude")]);

    const roles = buildConfiguredSubagentRoles("pi", {
      useExistingAgents: true,
      extensionAgentsEnabled: true,
      profiles: { "frontend-ui-engineering": { enabled: true } },
    });
    expect(roles).toHaveLength(9);
    expect(roles.map((role) => role.id)).toContain("frontend-ui-engineering");
  });
});
