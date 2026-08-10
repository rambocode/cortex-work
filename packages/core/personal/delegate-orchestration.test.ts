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
    expect(guide).toContain("必须调用对应的协作者工具");
    expect(guide).toContain("作为工具结果返回给主会话");
    expect(guide).toContain("由你结合主会话上下文总结并输出最终回答");
  });

  it("普通会话按任务收益决定委派，琐碎或紧密串行任务仍可直接完成", () => {
    const guide = buildDelegateOrchestrationGuide(
      [buildAutoSubagentRole("codex")],
      { requireDelegation: false },
    );
    expect(guide).toContain("实质性任务只要受益于专项能力、独立复核或多个互不依赖的工作流");
    expect(guide).toContain("必须调用合适的协作者工具");
    expect(guide).toContain("只有琐碎工作、紧密耦合的串行步骤");
    expect(guide).toContain("才直接处理");
  });

  it("对齐 Kun：仓库或项目探索必须先交给 Repository Explorer，独立问题同批并行", () => {
    const roles = buildConfiguredSubagentRoles("pi", undefined);
    const guide = buildDelegateOrchestrationGuide(roles, { requireDelegation: false });

    expect(guide).toContain("任何仓库或项目探索都必须先调用 `explore_agent`");
    expect(guide).toContain("互不重叠的范围动态拆成多个并行 `explore_agent`");
    expect(guide).toContain("one call for API wiring, another for UI, another for tests");
    expect(guide).toContain("整项目分析要先枚举所有适用的独立证据面");
    expect(guide).toContain("拆分数量由问题范围决定，不得固定调用次数");
    expect(guide).toContain("Repository Explorer 返回后");
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

  it("自定义子代理经过持久化校验后进入对应场景，并执行只读权限与模型配置", () => {
    const settings = normalizeSubagentSettings({
      customProfiles: [
        {
          id: "custom-release-risk",
          enabled: true,
          name: "发布风险审查员",
          description: "检查上线风险",
          agent: "codex",
          model: "gpt-5.4",
          effort: "high",
          systemPrompt: "只报告可复现问题",
          toolPolicy: "readOnly",
          surfaces: ["code"],
        },
        {
          id: "general",
          enabled: true,
          name: "不能覆盖内置角色",
          toolPolicy: "inherit",
          surfaces: ["shared"],
        },
      ],
    });

    expect(settings.customProfiles).toHaveLength(1);
    expect(buildConfiguredSubagentRoles("pi", settings, "write").map((role) => role.id)).not.toContain("custom-release-risk");
    expect(buildConfiguredSubagentRoles("pi", settings, "code").find((role) => role.id === "custom-release-risk")).toMatchObject({
      label: "发布风险审查员",
      agent: "codex",
      model: "gpt-5.4",
      effort: "high",
      toolPolicy: "readOnly",
      systemPrompt: "检查上线风险\n\n只报告可复现问题",
    });
  });

  it("自动代码审查模型作为目录默认值，单角色显式覆盖仍优先", () => {
    const automatic = buildConfiguredSubagentRoles("pi", {
      automaticRoles: { codeReview: { agent: "codex", model: "gpt-5.4", effort: "high" } },
    }).find((role) => role.id === "code-reviewer");
    expect(automatic).toMatchObject({ agent: "codex", model: "gpt-5.4", effort: "high" });

    const explicit = buildConfiguredSubagentRoles("pi", {
      automaticRoles: { codeReview: { agent: "codex", model: "gpt-5.4" } },
      profiles: { "code-reviewer": { agent: "claude", model: "sonnet" } },
    }).find((role) => role.id === "code-reviewer");
    expect(explicit).toMatchObject({ agent: "claude", model: "sonnet" });
  });
});
