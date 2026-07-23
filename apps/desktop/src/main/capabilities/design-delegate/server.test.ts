import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlidesRole, SlidesRoleResultByRole } from "@cortex-work/core/design/slides/slides-pipeline-types";
import type { CliStreamEvent } from "../../ipc/types";
import {
  buildDesignDelegateMcpServerConfig,
  buildSlidesRoleDelegateLabel,
  buildSlidesRoleDelegatePrompt,
  killAllDesignDelegates,
  parseSlidesRoleAgentText,
  registerDesignDelegateSession,
  runSlidesRoleDelegate,
  startDesignDelegateHost,
  stopDesignDelegateHost,
  unregisterDesignDelegateSession,
  type DesignDelegateSessionState,
} from "./server";

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

const TOOLS_LIST_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});

function makeCallBody(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function roleResult(role: SlidesRole): SlidesRoleResultByRole[SlidesRole] {
  switch (role) {
    case "topic-researcher":
      return {
        facts: ["市场规模增长"],
        sources: [{ title: "Gartner", url: "https://example.com/report" }],
        claims: ["AI 采用率持续上升"],
        openQuestions: ["细分行业占比"]
      };
    case "visual-researcher":
      return {
        assetIdeas: [{ slideId: "slot-001", query: "enterprise ai dashboard", rationale: "体现管理视角" }],
        chartIdeas: [{ slideId: "slot-001", chartType: "bar", rationale: "对比增长幅度" }],
        visualRisks: []
      };
    case "narrative-reviewer":
      return {
        deckFindings: [{ code: "story-gap", message: "缺少问题到方案的过渡" }],
        slideFindings: [{ slideId: "slot-001", code: "weak-proof", message: "论据偏少" }],
        suggestedOrder: ["slot-001", "slot-002"]
      };
    case "render-reviewer":
      return {
        findings: [{ severity: "warning", slideId: "slot-001", code: "dense-text", message: "文本偏密" }]
      };
    case "notes-writer":
      return {
        slots: [{ slotId: "slot-001", markdown: "## 备注\n\n先讲行业现状，再讲解法。" }]
      };
  }
}

function roleJson(role: SlidesRole): string {
  return JSON.stringify(roleResult(role), null, 2);
}

function roleLabel(role: SlidesRole, runId: string): string {
  return buildSlidesRoleDelegateLabel(runId, role);
}

function makeSlidesState(
  sessionId: string,
  overrides: Partial<DesignDelegateSessionState> = {},
): DesignDelegateSessionState {
  const controller = new AbortController();
  return {
    sessionId,
    runId: `run-${sessionId}`,
    signal: controller.signal,
    abort: () => controller.abort(),
    pushEvent: () => {},
    bumpWatchdog: () => {},
    callCount: { n: 0 },
    runSubAgent: async () => ({ ok: true, text: "" }),
    ...overrides,
  };
}

async function postMcp(
  port: number,
  token: string,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body,
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((line) => line.startsWith("{") || line.startsWith("data: {"));
  const jsonStr = jsonLine?.startsWith("data: ") ? jsonLine.slice(6) : (jsonLine ?? text);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return text;
  }
}

function getPortAndToken(cfg: NonNullable<ReturnType<typeof buildDesignDelegateMcpServerConfig>>): {
  port: number;
  token: string;
} {
  const port = parseInt(cfg.url!.split(":")[2] ?? "0");
  const token = (cfg.headers as Record<string, string>)["Authorization"].replace("Bearer ", "");
  return { port, token };
}

afterEach(() => {
  stopDesignDelegateHost();
  killAllDesignDelegates();
  vi.restoreAllMocks();
});

describe("slides role helper", () => {
  it("构造固定 label 与 JSON-only prompt", () => {
    expect(buildSlidesRoleDelegateLabel("run-123", "render-reviewer")).toBe("slides:render-reviewer:run-123");
    const prompt = buildSlidesRoleDelegatePrompt({
      runId: "run-123",
      role: "render-reviewer",
      scope: "仅检查第 2 页图文布局",
      prompt: "找出影响导出的渲染问题"
    });
    expect(prompt).toContain("slides pipeline role: render-reviewer");
    expect(prompt).toContain("return exactly one JSON object");
    expect(prompt).toContain("never Write/Edit the deck");
    expect(prompt).toContain("仅检查第 2 页图文布局");
    expect(prompt).toContain("找出影响导出的渲染问题");
  });

  it("能从 markdown fence 提取并严格解析 role JSON；非法输出返回失败", () => {
    const ok = parseSlidesRoleAgentText(
      "notes-writer",
      `先分析\n\n\`\`\`json\n${roleJson("notes-writer")}\n\`\`\`\n`,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.result).toEqual(roleResult("notes-writer"));

    const bad = parseSlidesRoleAgentText("topic-researcher", "```json\n{\"facts\":[]}\n```");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_payload");
  });
});

describe("runSlidesRoleDelegate", () => {
  it("同一 run 总并发上限为 3", async () => {
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const pushedEvents: CliStreamEvent[] = [];
    const onRoleEvent = vi.fn();
    const roles: SlidesRole[] = [
      "topic-researcher",
      "visual-researcher",
      "narrative-reviewer",
      "render-reviewer",
      "notes-writer",
    ];
    const state = makeSlidesState("slides-concurrency", {
      runSubAgent: vi.fn(async (label) => {
        const role = label.split(":")[1] as SlidesRole;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        active -= 1;
        return { ok: true, text: roleJson(role) };
      }),
      pushEvent: (ev) => {
        pushedEvents.push(ev);
      },
      slides: {
        onRoleEvent,
        canDelegateNotesWriter: async () => true,
      },
    });

    const pending = roles.map((role) =>
      runSlidesRoleDelegate(state, {
        run_id: "run-shared",
        role,
        scope: "并发测试",
        prompt: `执行 ${role}`,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(3);

    for (let resolved = 0; resolved < roles.length; resolved += 1) {
      await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    const results = await Promise.all(pending);
    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(onRoleEvent).toHaveBeenCalledTimes(roles.length * 2);

    const started = onRoleEvent.mock.calls
      .map((call) => call[0] as { status: string; role: SlidesRole; label: string; runId: string })
      .filter((event) => event.status === "started");
    const succeeded = onRoleEvent.mock.calls
      .map((call) => call[0] as { status: string; role: SlidesRole; label: string; runId: string })
      .filter((event) => event.status === "succeeded");
    expect(started).toHaveLength(roles.length);
    expect(succeeded).toHaveLength(roles.length);
    for (const role of roles) {
      const expectedLabel = roleLabel(role, "run-shared");
      expect(started).toContainEqual(expect.objectContaining({ runId: "run-shared", role, label: expectedLabel }));
      expect(succeeded).toContainEqual(expect.objectContaining({ runId: "run-shared", role, label: expectedLabel }));
    }

    const initEvents = pushedEvents.filter((event) => event.type === "init") as Array<
      Extract<CliStreamEvent, { type: "init" }>
    >;
    const resultEvents = pushedEvents.filter((event) => event.type === "result") as Array<
      Extract<CliStreamEvent, { type: "result" }>
    >;
    expect(initEvents).toHaveLength(roles.length);
    expect(resultEvents).toHaveLength(roles.length);
    expect(initEvents.map((event) => event.roleId).sort()).toEqual(roles.map((role) => roleLabel(role, "run-shared")).sort());
    expect(resultEvents.map((event) => event.roleId).sort()).toEqual(
      roles.map((role) => roleLabel(role, "run-shared")).sort(),
    );
    expect(resultEvents.every((event) => event.ok === true)).toBe(true);
  });

  it("失败后自动 retry 一次，成功后回调 artifact/status", async () => {
    const onRoleEvent = vi.fn();
    const runSubAgent = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: "not-json" })
      .mockResolvedValueOnce({ ok: true, text: roleJson("topic-researcher") });
    const state = makeSlidesState("slides-retry", {
      runSubAgent,
      slides: {
        onRoleEvent,
      },
    });

    const result = await runSlidesRoleDelegate(state, {
      run_id: "run-retry",
      role: "topic-researcher",
      scope: "补充行业事实",
      prompt: "输出研究摘要"
    });

    expect(result.isError).not.toBe(true);
    expect(runSubAgent).toHaveBeenCalledTimes(2);
    expect(onRoleEvent).toHaveBeenCalledTimes(2);
    expect(onRoleEvent.mock.calls[1]?.[0]).toMatchObject({
      status: "succeeded",
      runId: "run-retry",
      role: "topic-researcher",
    });
  });

  it("notes-writer 需要 review gate，缺失或未完成都拒绝", async () => {
    const runSubAgent = vi.fn(async () => ({ ok: true, text: roleJson("notes-writer") }));
    const noGuardState = makeSlidesState("slides-notes-no-guard", {
      runSubAgent,
      slides: { onRoleEvent: async () => undefined },
    });
    const blockedByMissingGuard = await runSlidesRoleDelegate(noGuardState, {
      run_id: "run-notes",
      role: "notes-writer",
      scope: "写讲稿",
      prompt: "补全演讲备注"
    });
    expect(blockedByMissingGuard.isError).toBe(true);

    const falseGuardState = makeSlidesState("slides-notes-false", {
      runSubAgent,
      slides: {
        onRoleEvent: async () => undefined,
        canDelegateNotesWriter: async () => false,
      },
    });
    const blockedByReview = await runSlidesRoleDelegate(falseGuardState, {
      run_id: "run-notes",
      role: "notes-writer",
      scope: "写讲稿",
      prompt: "补全演讲备注"
    });
    expect(blockedByReview.isError).toBe(true);
    expect(runSubAgent).not.toHaveBeenCalled();
  });

  it("同一 role/run 最多两次，最终失败走 failed callback/raw summary", async () => {
    const onRoleEvent = vi.fn();
    const state = makeSlidesState("slides-fail", {
      runSubAgent: vi.fn(async () => ({ ok: true, text: "still not json" })),
      slides: { onRoleEvent },
    });

    const first = await runSlidesRoleDelegate(state, {
      run_id: "run-fail",
      role: "visual-researcher",
      scope: "输出视觉建议",
      prompt: "给出视觉研究"
    });
    expect(first.isError).toBe(true);

    const second = await runSlidesRoleDelegate(state, {
      run_id: "run-fail",
      role: "visual-researcher",
      scope: "输出视觉建议",
      prompt: "再次给出视觉研究"
    });
    expect(second.isError).toBe(true);
    expect(onRoleEvent).toHaveBeenCalledTimes(2);
    expect(onRoleEvent.mock.calls[1]?.[0]).toMatchObject({
      status: "failed",
      runId: "run-fail",
      role: "visual-researcher",
    });
  });

  it("runSubAgent 同步抛错时发 failed 生命周期并返回规范失败", async () => {
    const pushedEvents: CliStreamEvent[] = [];
    const onRoleEvent = vi.fn();
    const state = makeSlidesState("slides-sync-throw", {
      pushEvent: (ev) => {
        pushedEvents.push(ev);
      },
      runSubAgent: vi.fn(() => {
        throw new Error("sync boom");
      }),
      slides: { onRoleEvent },
    });

    const result = await runSlidesRoleDelegate(state, {
      run_id: "run-sync-throw",
      role: "render-reviewer",
      scope: "检查第 3 页密度",
      prompt: "输出渲染问题"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("sync boom");
    expect(onRoleEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        status: "started",
        role: "render-reviewer",
        label: roleLabel("render-reviewer", "run-sync-throw"),
      }),
      expect.objectContaining({
        status: "failed",
        role: "render-reviewer",
        label: roleLabel("render-reviewer", "run-sync-throw"),
        error: "sync boom",
      }),
    ]);
    expect(pushedEvents).toEqual([
      expect.objectContaining({
        type: "init",
        roleId: roleLabel("render-reviewer", "run-sync-throw"),
        stageLabel: roleLabel("render-reviewer", "run-sync-throw"),
      }),
      expect.objectContaining({
        type: "result",
        ok: false,
        error: "sync boom",
        roleId: roleLabel("render-reviewer", "run-sync-throw"),
      }),
    ]);
  });

  it("runSubAgent Promise rejection 时发 failed 生命周期并返回规范失败", async () => {
    const pushedEvents: CliStreamEvent[] = [];
    const onRoleEvent = vi.fn();
    const state = makeSlidesState("slides-reject", {
      pushEvent: (ev) => {
        pushedEvents.push(ev);
      },
      runSubAgent: vi.fn().mockRejectedValue(new Error("async boom")),
      slides: { onRoleEvent },
    });

    const result = await runSlidesRoleDelegate(state, {
      run_id: "run-async-reject",
      role: "topic-researcher",
      scope: "只查 2026 年公开市场数据",
      prompt: "给出事实和来源"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("async boom");
    expect(onRoleEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        status: "started",
        role: "topic-researcher",
        label: roleLabel("topic-researcher", "run-async-reject"),
      }),
      expect.objectContaining({
        status: "failed",
        role: "topic-researcher",
        label: roleLabel("topic-researcher", "run-async-reject"),
        error: "async boom",
      }),
    ]);
    expect(pushedEvents).toEqual([
      expect.objectContaining({
        type: "init",
        roleId: roleLabel("topic-researcher", "run-async-reject"),
      }),
      expect.objectContaining({
        type: "result",
        ok: false,
        error: "async boom",
        roleId: roleLabel("topic-researcher", "run-async-reject"),
      }),
    ]);
  });

  it("onRoleEvent Promise rejection 被收敛为规范失败，不让 MCP 调用 reject", async () => {
    const pushedEvents: CliStreamEvent[] = [];
    const state = makeSlidesState("slides-event-reject", {
      pushEvent: (event) => pushedEvents.push(event),
      runSubAgent: vi.fn(async () => ({ ok: true, text: roleJson("topic-researcher") })),
      slides: { onRoleEvent: vi.fn().mockRejectedValue(new Error("event sink down")) },
    });

    const result = await runSlidesRoleDelegate(state, {
      run_id: "run-event-reject",
      role: "topic-researcher",
      scope: "公开资料",
      prompt: "提取事实",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("event sink down");
    expect(pushedEvents).toContainEqual(expect.objectContaining({ type: "result", ok: false }));
  });

  it("超长 scope/prompt 在入口被拒绝，不触发子 agent", async () => {
    const runSubAgent = vi.fn(async () => ({ ok: true, text: roleJson("topic-researcher") }));
    const state = makeSlidesState("slides-limits", {
      runSubAgent,
      slides: { onRoleEvent: async () => undefined },
    });

    const result = await runSlidesRoleDelegate(state, {
      run_id: "run-too-large",
      role: "topic-researcher",
      scope: "S".repeat(20_000),
      prompt: "P".repeat(40_000),
    });

    expect(result.isError).toBe(true);
    expect(runSubAgent).not.toHaveBeenCalled();
  });
});

describe("design-delegate host HTTP", () => {
  it("delegate_task 兼容保留；仅 slides session 注册 delegate_slides_role", async () => {
    await startDesignDelegateHost();

    registerDesignDelegateSession(
      makeSlidesState("plain-session", {
        runSubAgent: vi.fn(async (_label, prompt) => ({ ok: true, text: `echo:${prompt}` })),
      }),
    );
    registerDesignDelegateSession(
      makeSlidesState("slides-session", {
        slides: {
          onRoleEvent: async () => undefined,
        },
      }),
    );

    const plainCfg = buildDesignDelegateMcpServerConfig("plain-session");
    const slidesCfg = buildDesignDelegateMcpServerConfig("slides-session");
    expect(plainCfg).not.toBeNull();
    expect(slidesCfg).not.toBeNull();

    const plain = getPortAndToken(plainCfg!);
    const slides = getPortAndToken(slidesCfg!);

    await postMcp(plain.port, plain.token, INIT_BODY, { "X-Cortex-Session": "plain-session" });
    const plainList = await postMcp(plain.port, plain.token, TOOLS_LIST_BODY, { "X-Cortex-Session": "plain-session" }) as Record<string, unknown>;
    const plainTools = ((plainList.result as Record<string, unknown>).tools ?? []) as Array<Record<string, string>>;
    expect(plainTools.map((tool) => tool.name)).toContain("delegate_task");
    expect(plainTools.map((tool) => tool.name)).not.toContain("delegate_slides_role");

    const plainCall = await postMcp(
      plain.port,
      plain.token,
      makeCallBody("delegate_task", { label: "page:slot-001", prompt: "生成一页" }),
      { "X-Cortex-Session": "plain-session" },
    ) as Record<string, unknown>;
    expect(JSON.stringify(plainCall)).toContain("echo:生成一页");

    await postMcp(slides.port, slides.token, INIT_BODY, { "X-Cortex-Session": "slides-session" });
    const slidesList = await postMcp(slides.port, slides.token, TOOLS_LIST_BODY, { "X-Cortex-Session": "slides-session" }) as Record<string, unknown>;
    const slidesTools = ((slidesList.result as Record<string, unknown>).tools ?? []) as Array<Record<string, string>>;
    expect(slidesTools.map((tool) => tool.name)).toContain("delegate_task");
    expect(slidesTools.map((tool) => tool.name)).toContain("delegate_slides_role");

    unregisterDesignDelegateSession("plain-session");
    unregisterDesignDelegateSession("slides-session");
  });

  it("delegate_task 成功/失败都发同 roleId 的生命周期 result", async () => {
    await startDesignDelegateHost();

    const successEvents: CliStreamEvent[] = [];
    registerDesignDelegateSession(
      makeSlidesState("plain-success", {
        pushEvent: (ev) => {
          successEvents.push(ev);
        },
        runSubAgent: vi.fn(async (_label, prompt) => ({ ok: true, text: `echo:${prompt}` })),
      }),
    );
    const successCfg = buildDesignDelegateMcpServerConfig("plain-success");
    const success = getPortAndToken(successCfg!);
    await postMcp(success.port, success.token, INIT_BODY, { "X-Cortex-Session": "plain-success" });
    const successCall = await postMcp(
      success.port,
      success.token,
      makeCallBody("delegate_task", { label: "page:slot-002", prompt: "生成第二页" }),
      { "X-Cortex-Session": "plain-success" },
    );
    expect(JSON.stringify(successCall)).toContain("echo:生成第二页");
    expect(successEvents).toEqual([
      expect.objectContaining({
        type: "init",
        roleId: "page:slot-002",
        stageLabel: "page:slot-002",
      }),
      expect.objectContaining({
        type: "result",
        ok: true,
        roleId: "page:slot-002",
      }),
    ]);

    const failureEvents: CliStreamEvent[] = [];
    registerDesignDelegateSession(
      makeSlidesState("plain-failure", {
        pushEvent: (ev) => {
          failureEvents.push(ev);
        },
        runSubAgent: vi.fn(() => {
          throw new Error("delegate boom");
        }),
      }),
    );
    const failureCfg = buildDesignDelegateMcpServerConfig("plain-failure");
    const failure = getPortAndToken(failureCfg!);
    await postMcp(failure.port, failure.token, INIT_BODY, { "X-Cortex-Session": "plain-failure" });
    const failureCall = await postMcp(
      failure.port,
      failure.token,
      makeCallBody("delegate_task", { label: "page:slot-003", prompt: "生成第三页" }),
      { "X-Cortex-Session": "plain-failure" },
    );
    expect(JSON.stringify(failureCall)).toContain("delegate boom");
    expect(JSON.stringify(failureCall)).toContain("执行失败");
    expect(failureEvents).toEqual([
      expect.objectContaining({
        type: "init",
        roleId: "page:slot-003",
        stageLabel: "page:slot-003",
      }),
      expect.objectContaining({
        type: "result",
        ok: false,
        error: "delegate boom",
        roleId: "page:slot-003",
      }),
    ]);

    unregisterDesignDelegateSession("plain-success");
    unregisterDesignDelegateSession("plain-failure");
  });

  it("delegate_task 超长 label/prompt 入口拒绝，不触发子 agent", async () => {
    await startDesignDelegateHost();

    const runSubAgent = vi.fn(async (_label, prompt) => ({ ok: true, text: `echo:${prompt}` }));
    registerDesignDelegateSession(
      makeSlidesState("plain-too-large", {
        runSubAgent,
      }),
    );
    const cfg = buildDesignDelegateMcpServerConfig("plain-too-large");
    const conn = getPortAndToken(cfg!);
    await postMcp(conn.port, conn.token, INIT_BODY, { "X-Cortex-Session": "plain-too-large" });
    const call = await postMcp(
      conn.port,
      conn.token,
      makeCallBody("delegate_task", { label: "L".repeat(300), prompt: "P".repeat(40_000) }),
      { "X-Cortex-Session": "plain-too-large" },
    );

    expect(JSON.stringify(call)).toContain("过长");
    expect(runSubAgent).not.toHaveBeenCalled();

    unregisterDesignDelegateSession("plain-too-large");
  });
});
