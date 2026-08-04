// 自动化 MCP server 单测。
// 覆盖：注入 gate、G1 隔离守卫（定时任务路径拿不到工具）、会话继承不可被参数覆盖、
//       confirm_name 护栏、运行历史截断、工具名 ↔ 审批集常量一致性。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationMeta, AutomationRun, McpServerConfig } from "../../ipc/types";

const h = vi.hoisted(() => ({
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  setAutomationEnabled: vi.fn(),
  deleteAutomation: vi.fn(),
  runAutomationNow: vi.fn(),
  loadAutomations: vi.fn(),
  getAutomation: vi.fn(),
  loadRuns: vi.fn(),
  getPersistedState: vi.fn(),
}));

vi.mock("../../automation/service", () => ({
  createAutomation: h.createAutomation,
  updateAutomation: h.updateAutomation,
  setAutomationEnabled: h.setAutomationEnabled,
  deleteAutomation: h.deleteAutomation,
  runAutomationNow: h.runAutomationNow,
}));
vi.mock("../../automation/store", () => ({
  loadAutomations: h.loadAutomations,
  getAutomation: h.getAutomation,
  loadRuns: h.loadRuns,
}));
vi.mock("../../ipc/store", () => ({ getPersistedState: h.getPersistedState }));

import {
  AUTOMATION_SERVER_ID,
  AUTOMATION_TOOL_NAMES,
  buildAutomationMcpServerConfig,
  hasAutomationSession,
  startAutomationHost,
  stopAutomationHost,
  unregisterAutomationSession,
} from "./server";
import { AUTOMATION_READONLY_TOOLS, AUTOMATION_WRITE_TOOLS } from "../../ipc/types";

// ── 会话上下文（模型不可覆盖，全部从这里继承）────────────────────────────────
const SESSION = {
  cwd: "/ws-session",
  agent: "pi" as const,
  model: "gpt-5",
  effort: "medium" as const,
  providerId: "prov-a",
};

const META: AutomationMeta = {
  id: "auto-1",
  name: "每日 AI 新闻",
  enabled: true,
  agent: "pi",
  prompt: "总结今天的 AI 新闻",
  schedule: { kind: "daily", hour: 9, minute: 0 },
  timezone: "Asia/Shanghai",
  createdAt: 0,
  updatedAt: 0,
  nextRunAt: 1_800_000_000_000,
};

// ── MCP over HTTP 辅助（同 loop-workflows/server.test.ts 的骨架）─────────────

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});
const TOOLS_LIST_BODY = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

function makeCallBody(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
}

async function postMcp(
  port: number,
  token: string,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
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
  const line = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("data: {"));
  const str = line?.startsWith("data: ") ? line.slice(6) : (line ?? text);
  try {
    return { status: res.status, json: JSON.parse(str) as Record<string, unknown> };
  } catch {
    return { status: res.status, json: null };
  }
}

function endpoint(cfg: McpServerConfig): { port: number; token: string; headers: Record<string, string> } {
  const port = parseInt(cfg.url!.split(":")[2] ?? "0");
  const headers = cfg.headers as Record<string, string>;
  return { port, token: headers["Authorization"].replace("Bearer ", ""), headers };
}

/** 起 host、注册会话、跑一次 tools/call，返回工具文本结果。 */
async function callTool(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  cfg: McpServerConfig,
): Promise<{ text: string; isError: boolean }> {
  const { port, token } = endpoint(cfg);
  const sh = { "X-Cortex-Session": sessionId };
  await postMcp(port, token, INIT_BODY, sh);
  const res = await postMcp(port, token, makeCallBody(tool, args), sh);
  const result = res.json?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  return { text: result?.content?.[0]?.text ?? JSON.stringify(res.json), isError: result?.isError === true };
}

async function listToolNames(sessionId: string, cfg: McpServerConfig): Promise<string[]> {
  const { port, token } = endpoint(cfg);
  const sh = { "X-Cortex-Session": sessionId };
  await postMcp(port, token, INIT_BODY, sh);
  const res = await postMcp(port, token, TOOLS_LIST_BODY, sh);
  const tools = ((res.json?.result as Record<string, unknown>)?.tools ?? []) as Array<{ name: string }>;
  return tools.map((t) => t.name);
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.getPersistedState.mockResolvedValue({ generalSettings: {} });
  h.loadAutomations.mockResolvedValue([META]);
  h.getAutomation.mockResolvedValue(META);
  h.loadRuns.mockResolvedValue([]);
  h.createAutomation.mockImplementation(async () => META);
  h.updateAutomation.mockResolvedValue(META);
  h.setAutomationEnabled.mockResolvedValue({ ...META, enabled: false });
  h.deleteAutomation.mockResolvedValue(undefined);
});

afterEach(() => {
  stopAutomationHost();
  unregisterAutomationSession("s1");
});

// ── 注入 gate ────────────────────────────────────────────────────────────────

describe("buildAutomationMcpServerConfig — 注入 gate", () => {
  it("host 未起 → null", () => {
    expect(buildAutomationMcpServerConfig("s1", SESSION, undefined)).toBeNull();
  });

  it("全局开关显式关闭 → null（且不登记 session）", async () => {
    await startAutomationHost();
    expect(buildAutomationMcpServerConfig("s1", SESSION, { enabled: false })).toBeNull();
    expect(hasAutomationSession("s1")).toBe(false);
  });

  it("开关缺省视为开启（默认开箱即用）", async () => {
    await startAutomationHost();
    expect(buildAutomationMcpServerConfig("s1", SESSION, undefined)).not.toBeNull();
    expect(buildAutomationMcpServerConfig("s1", SESSION, {})).not.toBeNull();
  });

  it("无 sessionId → null（没有会话就没有可继承的执行上下文）", async () => {
    await startAutomationHost();
    expect(buildAutomationMcpServerConfig(undefined, SESSION, undefined)).toBeNull();
  });

  it("零任务时仍注入 —— create_automation 恰恰在这时最需要", async () => {
    await startAutomationHost();
    h.loadAutomations.mockResolvedValue([]);
    expect(buildAutomationMcpServerConfig("s1", SESSION, undefined)).not.toBeNull();
  });

  it("token 只走 Authorization 头，不进 URL", async () => {
    await startAutomationHost();
    const cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
    expect(cfg.id).toBe(AUTOMATION_SERVER_ID);
    expect(cfg.transport).toBe("http");
    expect(cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const { token, headers } = endpoint(cfg);
    expect(cfg.url).not.toContain(token);
    expect(headers["Authorization"]).toMatch(/^Bearer [a-f0-9]{64}$/);
    expect(headers["X-Cortex-Session"]).toBe("s1");
  });

  it("错误 token → 401", async () => {
    await startAutomationHost();
    const cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
    const { port } = endpoint(cfg);
    const res = await postMcp(port, "deadbeef", INIT_BODY);
    expect(res.status).toBe(401);
  });
});

// ── G1 隔离守卫：这是本 capability 最重要的一组用例 ──────────────────────────

describe("G1 守卫 — 未登记的会话拿不到任何工具", () => {
  beforeEach(async () => {
    await startAutomationHost();
  });

  it("定时任务的 run.id（未经 buildConfig 登记）→ tools/list 只有 ping", async () => {
    const cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
    // 模拟 automation/runner.ts 的 sessionId（run-xxx），它永远不会被登记。
    const names = await listToolNames("run-abc123", cfg);
    expect(names).toEqual(["ping"]);
  });

  it("未登记会话调写工具 → 报错且不触达 service", async () => {
    const cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
    const r = await callTool("run-abc123", "create_automation", { name: "x", prompt: "y" }, cfg);
    expect(r.text).toMatch(/create_automation/i); // JSON-RPC「工具不存在」错误
    expect(h.createAutomation).not.toHaveBeenCalled();
  });

  it("unregister 之后工具立即消失（会话关闭不留权限尾巴）", async () => {
    const cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
    expect(await listToolNames("s1", cfg)).toContain("list_automations");
    unregisterAutomationSession("s1");
    expect(await listToolNames("s1", cfg)).toEqual(["ping"]);
  });

  it("已登记会话 → 7 个工具齐全", async () => {
    const cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
    const names = await listToolNames("s1", cfg);
    for (const t of [...AUTOMATION_READONLY_TOOLS, ...AUTOMATION_WRITE_TOOLS]) {
      expect(names).toContain(t);
    }
  });
});

// ── 会话继承 ─────────────────────────────────────────────────────────────────

describe("执行上下文从会话继承，模型无法覆盖", () => {
  let cfg: McpServerConfig;
  beforeEach(async () => {
    await startAutomationHost();
    cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
  });

  it("create 用会话的 agent/model/effort/cwd/providerId", async () => {
    await callTool("s1", "create_automation", { name: "N", prompt: "P", schedule_kind: "daily", hour: 9, minute: 0 }, cfg);
    expect(h.createAutomation).toHaveBeenCalledTimes(1);
    const [input, createdBy] = h.createAutomation.mock.calls[0];
    expect(input).toMatchObject({ agent: "pi", model: "gpt-5", effort: "medium", cwd: "/ws-session", providerId: "prov-a" });
    expect(createdBy).toBe("agent");
  });

  it("模型硬塞 cwd / agent / model 也不生效（任意路径注入的防线）", async () => {
    await callTool(
      "s1",
      "create_automation",
      { name: "N", prompt: "P", schedule_kind: "hourly", minute: 0, cwd: "/etc", agent: "claude", model: "evil", providerId: "hijack" },
      cfg,
    );
    const [input] = h.createAutomation.mock.calls[0];
    expect(input.cwd).toBe("/ws-session");
    expect(input.agent).toBe("pi");
    expect(input.model).toBe("gpt-5");
    expect(input.providerId).toBe("prov-a");
  });

  it("两个会话各持独立上下文，互不覆盖", async () => {
    const cfg2 = buildAutomationMcpServerConfig("s2", { ...SESSION, cwd: "/ws-B", providerId: "prov-b" }, undefined)!;
    await callTool("s1", "create_automation", { name: "A", prompt: "P", schedule_kind: "hourly", minute: 0 }, cfg);
    await callTool("s2", "create_automation", { name: "B", prompt: "P", schedule_kind: "hourly", minute: 0 }, cfg2);
    expect(h.createAutomation.mock.calls[0][0].cwd).toBe("/ws-session");
    expect(h.createAutomation.mock.calls[1][0].cwd).toBe("/ws-B");
    unregisterAutomationSession("s2");
  });
});

// ── 工具行为 ─────────────────────────────────────────────────────────────────

describe("工具行为", () => {
  let cfg: McpServerConfig;
  beforeEach(async () => {
    await startAutomationHost();
    cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
  });

  it("list_automations 空列表明说「没有」并提示可新建", async () => {
    h.loadAutomations.mockResolvedValue([]);
    const r = await callTool("s1", "list_automations", {}, cfg);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("没有任何定时任务");
    expect(r.text).toContain("create_automation");
  });

  it("list_automations 不泄漏 cwd / providerId", async () => {
    const r = await callTool("s1", "list_automations", {}, cfg);
    expect(r.text).not.toContain("/ws-session");
    expect(r.text).not.toContain("prov-a");
  });

  it("create 的 schedule 参数有误时报中文原因，且不触达 service", async () => {
    const r = await callTool("s1", "create_automation", { name: "N", prompt: "P", schedule_kind: "weekly", hour: 9, minute: 0 }, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/weekday/);
    expect(h.createAutomation).not.toHaveBeenCalled();
  });

  it("update 碰了半套定时字段 → 要求给全，不猜", async () => {
    const r = await callTool("s1", "update_automation", { automation_id: "auto-1", hour: 8 }, cfg);
    expect(r.isError).toBe(true);
    expect(h.updateAutomation).not.toHaveBeenCalled();
  });

  it("update 不传任何字段 → 明确报错", async () => {
    const r = await callTool("s1", "update_automation", { automation_id: "auto-1" }, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("没有收到任何要修改的字段");
  });

  it("delete 的 confirm_name 不符 → 拒绝，且不触达 service", async () => {
    const r = await callTool("s1", "delete_automation", { automation_id: "auto-1", confirm_name: "别的任务" }, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("每日 AI 新闻");
    expect(h.deleteAutomation).not.toHaveBeenCalled();
  });

  it("delete 的 confirm_name 相符 → 执行", async () => {
    const r = await callTool("s1", "delete_automation", { automation_id: "auto-1", confirm_name: "每日 AI 新闻" }, cfg);
    expect(r.isError).toBe(false);
    expect(h.deleteAutomation).toHaveBeenCalledWith("auto-1");
  });

  it("run_now 明说「不等待完成」，避免模型把 running 当最终结果汇报", async () => {
    h.runAutomationNow.mockResolvedValue({ id: "run-1", status: "running" } as AutomationRun);
    const r = await callTool("s1", "run_automation_now", { automation_id: "auto-1" }, cfg);
    expect(r.text).toContain("不等待完成");
    expect(r.text).toContain("get_automation_runs");
  });

  it("run_now 拿到 skipped 时翻译成人话（并发去重不是失败）", async () => {
    h.runAutomationNow.mockResolvedValue({ id: "run-1", status: "skipped" } as AutomationRun);
    const r = await callTool("s1", "run_automation_now", { automation_id: "auto-1" }, cfg);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("已跳过");
  });

  it("get_automation_runs 对超长输出封顶（200 条 × 200KB 会灌爆上下文）", async () => {
    const long = "x".repeat(50_000);
    h.loadRuns.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({
        id: `run-${i}`,
        automationId: "auto-1",
        startedAt: 1,
        endedAt: 2,
        status: "ok",
        trigger: "schedule",
        agent: "pi",
        prompt: "p",
        output: long,
      })) as AutomationRun[],
    );
    const r = await callTool("s1", "get_automation_runs", { automation_id: "auto-1", limit: 20 }, cfg);
    expect(r.text.length).toBeLessThan(20_000);
  });

  it("会话中途关掉开关 → 写工具给可读错误而非静默成功", async () => {
    h.getPersistedState.mockResolvedValue({ generalSettings: { automationTools: { enabled: false } } });
    const r = await callTool("s1", "create_automation", { name: "N", prompt: "P", schedule_kind: "hourly", minute: 0 }, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("已被用户关闭");
    expect(h.createAutomation).not.toHaveBeenCalled();
  });

  it("中途关开关不影响只读工具（查询无副作用）", async () => {
    h.getPersistedState.mockResolvedValue({ generalSettings: { automationTools: { enabled: false } } });
    const r = await callTool("s1", "list_automations", {}, cfg);
    expect(r.isError).toBe(false);
  });
});

// ── 工具名 ↔ 审批集常量一致性 ────────────────────────────────────────────────

describe("工具名与审批集常量一致（漂移 = 审批静默失效）", () => {
  it("注册的工具名逐一等于 AUTOMATION_* 常量", async () => {
    await startAutomationHost();
    const cfg = buildAutomationMcpServerConfig("s1", SESSION, undefined)!;
    const names = await listToolNames("s1", cfg);
    const registered = names.filter((n) => n !== "ping").sort();
    expect(registered).toEqual([...AUTOMATION_READONLY_TOOLS, ...AUTOMATION_WRITE_TOOLS].sort());
  });

  it("导出的清单与 ipc/types 常量同源", () => {
    expect(AUTOMATION_TOOL_NAMES.readonly).toEqual(AUTOMATION_READONLY_TOOLS);
    expect(AUTOMATION_TOOL_NAMES.write).toEqual(AUTOMATION_WRITE_TOOLS);
  });
});
