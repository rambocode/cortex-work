import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliStreamEvent } from "../../ipc/types";
import {
  buildDesignDelegateMcpServerConfig,
  killAllDesignDelegates,
  registerDesignDelegateSession,
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

function makeState(
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

describe("design-delegate host HTTP", () => {
  it("仅注册 session 拿到 delegate_task;无任何 slides 角色工具", async () => {
    await startDesignDelegateHost();

    registerDesignDelegateSession(
      makeState("plain-session", {
        runSubAgent: vi.fn(async (_label, prompt) => ({ ok: true, text: `echo:${prompt}` })),
      }),
    );

    const plainCfg = buildDesignDelegateMcpServerConfig("plain-session");
    expect(plainCfg).not.toBeNull();
    const plain = getPortAndToken(plainCfg!);

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

    unregisterDesignDelegateSession("plain-session");
  });

  it("delegate_task 成功/失败都发同 roleId 的生命周期 result", async () => {
    await startDesignDelegateHost();

    const successEvents: CliStreamEvent[] = [];
    registerDesignDelegateSession(
      makeState("plain-success", {
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
      makeState("plain-failure", {
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
      makeState("plain-too-large", {
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
