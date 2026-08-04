// 日历 MCP server 单测。
// 覆盖：四道门控、G1 隔离、allowWrite 分档、授权被撤销/超时的错误文案、工具名一致性。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../ipc/types";
import { CALENDAR_READONLY_TOOLS, CALENDAR_WRITE_TOOLS } from "../../ipc/types";
import { invalidateCalendarAccessCache, setCalendarHelper, type CalendarHelper } from "./helper";
import {
  CALENDAR_SERVER_ID,
  CALENDAR_TOOL_NAMES,
  buildCalendarMcpServerConfig,
  hasCalendarSession,
  startCalendarHost,
  stopCalendarHost,
  unregisterCalendarSession,
} from "./server";

// ── 假 helper ────────────────────────────────────────────────────────────────

function makeHelper(over?: Partial<CalendarHelper> & { access?: string }): CalendarHelper {
  return {
    permissions: vi.fn(async () => ({ ok: true, calendarAccess: over?.access ?? "full" })),
    calendarEvents: vi.fn(async () => ({
      ok: true,
      access: "full",
      timeZone: "Asia/Shanghai",
      truncated: false,
      events: [],
    })),
    calendarCreate: vi.fn(async () => ({
      ok: true,
      access: "full",
      id: "evt-1",
      calendar: "个人",
      startMs: Date.now(),
      endMs: Date.now() + 3_600_000,
      allDay: false,
    })),
    ...over,
  } as CalendarHelper;
}

// ── MCP over HTTP ────────────────────────────────────────────────────────────

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});
const TOOLS_LIST_BODY = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

async function postMcp(port: number, token: string, body: string, headers?: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body,
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("data: {"));
  const str = line?.startsWith("data: ") ? line.slice(6) : (line ?? text);
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function endpoint(cfg: McpServerConfig) {
  const headers = cfg.headers as Record<string, string>;
  return { port: parseInt(cfg.url!.split(":")[2] ?? "0"), token: headers["Authorization"].replace("Bearer ", "") };
}

async function listToolNames(sessionId: string, cfg: McpServerConfig): Promise<string[]> {
  const { port, token } = endpoint(cfg);
  const sh = { "X-Cortex-Session": sessionId };
  await postMcp(port, token, INIT_BODY, sh);
  const res = await postMcp(port, token, TOOLS_LIST_BODY, sh);
  const tools = ((res?.result as Record<string, unknown>)?.tools ?? []) as Array<{ name: string }>;
  return tools.map((t) => t.name);
}

async function callTool(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  cfg: McpServerConfig,
): Promise<{ text: string; isError: boolean }> {
  const { port, token } = endpoint(cfg);
  const sh = { "X-Cortex-Session": sessionId };
  await postMcp(port, token, INIT_BODY, sh);
  const res = await postMcp(
    port,
    token,
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args } }),
    sh,
  );
  const r = res?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  return { text: r?.content?.[0]?.text ?? JSON.stringify(res), isError: r?.isError === true };
}

beforeEach(() => {
  invalidateCalendarAccessCache();
  setCalendarHelper(makeHelper());
});

afterEach(() => {
  stopCalendarHost();
  unregisterCalendarSession("s1");
  setCalendarHelper(null);
});

// ── 四道门控 ─────────────────────────────────────────────────────────────────

describe("buildCalendarMcpServerConfig — 门控", () => {
  it("helper 未注入（非 macOS / initReply 没跑）→ null", async () => {
    setCalendarHelper(null);
    await startCalendarHost();
    expect(await buildCalendarMcpServerConfig("s1", true)).toBeNull();
  });

  it("host 未起 → null", async () => {
    expect(await buildCalendarMcpServerConfig("s1", true)).toBeNull();
  });

  it("无 sessionId → null", async () => {
    await startCalendarHost();
    expect(await buildCalendarMcpServerConfig(undefined, true)).toBeNull();
  });

  it.each(["notDetermined", "denied", "restricted"])("授权档 %s → null（不给必然失败的工具）", async (access) => {
    setCalendarHelper(makeHelper({ access }));
    await startCalendarHost();
    expect(await buildCalendarMcpServerConfig("s1", true)).toBeNull();
    expect(hasCalendarSession("s1")).toBe(false);
  });

  // writeOnly 能写不能读。只给写工具的日历 Agent 会盲写重复日程 —— 比完全不给更糟。
  it("授权档 writeOnly → null（能写不能读，会盲写重复日程）", async () => {
    setCalendarHelper(makeHelper({ access: "writeOnly" }));
    await startCalendarHost();
    expect(await buildCalendarMcpServerConfig("s1", true)).toBeNull();
  });

  it("授权档 full + host 可用 → 返回 http 配置，token 不进 URL", async () => {
    await startCalendarHost();
    const cfg = (await buildCalendarMcpServerConfig("s1", true))!;
    expect(cfg.id).toBe(CALENDAR_SERVER_ID);
    const { token } = endpoint(cfg);
    expect(cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(cfg.url).not.toContain(token);
    expect((cfg.headers as Record<string, string>)["X-Cortex-Session"]).toBe("s1");
  });

  it("helper 探测抛错 → null，且不阻断（不抛出到调用方）", async () => {
    setCalendarHelper(makeHelper({ permissions: vi.fn(async () => { throw new Error("helper 挂了"); }) }));
    await startCalendarHost();
    await expect(buildCalendarMcpServerConfig("s1", true)).resolves.toBeNull();
  });
});

// ── G1 隔离 + allowWrite 分档 ────────────────────────────────────────────────

describe("工具可见性", () => {
  beforeEach(async () => {
    await startCalendarHost();
  });

  it("未登记的 sessionId → 只有 ping", async () => {
    const cfg = (await buildCalendarMcpServerConfig("s1", true))!;
    expect(await listToolNames("unknown-session", cfg)).toEqual(["ping"]);
  });

  it("allowWrite=true → 读写工具齐全", async () => {
    const cfg = (await buildCalendarMcpServerConfig("s1", true))!;
    const names = await listToolNames("s1", cfg);
    expect(names).toContain("list_calendar_events");
    expect(names).toContain("create_calendar_event");
  });

  it("allowWrite=false → 只有只读工具（无审批回路的路径不给写）", async () => {
    const cfg = (await buildCalendarMcpServerConfig("s1", false))!;
    const names = await listToolNames("s1", cfg);
    expect(names).toContain("list_calendar_events");
    expect(names).not.toContain("create_calendar_event");
  });

  it("unregister 后工具立即消失", async () => {
    const cfg = (await buildCalendarMcpServerConfig("s1", true))!;
    unregisterCalendarSession("s1");
    expect(await listToolNames("s1", cfg)).toEqual(["ping"]);
  });
});

// ── 工具行为 ─────────────────────────────────────────────────────────────────

describe("list_calendar_events", () => {
  let cfg: McpServerConfig;
  beforeEach(async () => {
    await startCalendarHost();
    cfg = (await buildCalendarMcpServerConfig("s1", true))!;
  });

  it("时间参数无法解析时，把当前时间与时区一并告知（供模型自我纠正）", async () => {
    const r = await callTool("s1", "list_calendar_events", { start: "明天下午" }, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("当前本机时间");
    expect(r.text).toMatch(/时区/);
  });

  it("结果回带 now 与 time_zone（长会话里 description 的时间会过期）", async () => {
    const r = await callTool("s1", "list_calendar_events", {}, cfg);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"now"');
    expect(r.text).toContain('"time_zone"');
  });

  it("空结果明说「没有任何日程」而非报错", async () => {
    const r = await callTool("s1", "list_calendar_events", {}, cfg);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("没有任何日程");
  });

  it("会话中途被撤销授权 → isError + 指向授权引导", async () => {
    setCalendarHelper(
      makeHelper({ calendarEvents: vi.fn(async () => ({ ok: false, error: "calendar-not-authorized" })) }),
    );
    const r = await callTool("s1", "list_calendar_events", {}, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("授权");
  });

  it("write-only 时读失败的文案指向「完全访问」而非泛化报错", async () => {
    setCalendarHelper(
      makeHelper({
        calendarEvents: vi.fn(async () => ({ ok: false, error: "calendar-read-requires-full-access" })),
      }),
    );
    const r = await callTool("s1", "list_calendar_events", {}, cfg);
    expect(r.text).toContain("完全访问");
  });
});

describe("create_calendar_event", () => {
  let cfg: McpServerConfig;
  beforeEach(async () => {
    await startCalendarHost();
    cfg = (await buildCalendarMcpServerConfig("s1", true))!;
  });

  it("省略 end 时默认一小时，参数按 epoch 毫秒下发给 helper", async () => {
    const helper = makeHelper();
    setCalendarHelper(helper);
    await callTool("s1", "create_calendar_event", { title: "评审", start: "2026-08-07T15:00" }, cfg);
    const payload = (helper.calendarCreate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.title).toBe("评审");
    expect(payload.endMs - payload.startMs).toBe(3_600_000);
    expect(payload.startMs).toBe(new Date(2026, 7, 7, 15, 0, 0, 0).getTime());
  });

  it("end 早于 start → 拒绝，且不触达 helper", async () => {
    const helper = makeHelper();
    setCalendarHelper(helper);
    const r = await callTool(
      "s1",
      "create_calendar_event",
      { title: "X", start: "2026-08-07T15:00", end: "2026-08-07T14:00" },
      cfg,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("未创建");
    expect(helper.calendarCreate).not.toHaveBeenCalled();
  });

  // 超时是唯一「不知道到底写没写进去」的情况。说成「调用失败」会让模型直接重试，
  // 代价是用户日历里凭空多出两条一样的日程。
  it("通信中断 → 明说无法确认、要求先核对不要重试", async () => {
    setCalendarHelper(
      makeHelper({ calendarCreate: vi.fn(async () => { throw new Error("命令超时(10000ms)"); }) }),
    );
    const r = await callTool("s1", "create_calendar_event", { title: "X", start: "2026-08-07T15:00" }, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("无法确认是否已创建");
    expect(r.text).toContain("不要直接重试");
    expect(r.text).toContain("list_calendar_events");
  });

  it("写入被系统拒绝 → 明说未创建（绝不返回成功）", async () => {
    setCalendarHelper(
      makeHelper({ calendarCreate: vi.fn(async () => ({ ok: false, error: "save-failed", message: "boom" })) }),
    );
    const r = await callTool("s1", "create_calendar_event", { title: "X", start: "2026-08-07T15:00" }, cfg);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("日程未创建");
  });

  it("找不到可写日历 → 给出可执行的排查方向", async () => {
    setCalendarHelper(
      makeHelper({ calendarCreate: vi.fn(async () => ({ ok: false, error: "no-writable-calendar" })) }),
    );
    const r = await callTool("s1", "create_calendar_event", { title: "X", start: "2026-08-07T15:00" }, cfg);
    expect(r.text).toContain("默认日历");
  });
});

// ── 工具名一致性 ─────────────────────────────────────────────────────────────

describe("工具名与审批集常量一致（漂移 = 审批静默失效）", () => {
  it("注册的工具名逐一等于 CALENDAR_* 常量", async () => {
    await startCalendarHost();
    const cfg = (await buildCalendarMcpServerConfig("s1", true))!;
    const registered = (await listToolNames("s1", cfg)).filter((n) => n !== "ping").sort();
    expect(registered).toEqual([...CALENDAR_READONLY_TOOLS, ...CALENDAR_WRITE_TOOLS].sort());
  });

  it("导出的清单与 ipc/types 常量同源", () => {
    expect(CALENDAR_TOOL_NAMES.readonly).toEqual(CALENDAR_READONLY_TOOLS);
    expect(CALENDAR_TOOL_NAMES.write).toEqual(CALENDAR_WRITE_TOOLS);
  });
});
