// 系统日历 MCP server：让 Agent 在会话中查询日程（「我下周三下午有空吗」）、
// 并在用户确认后创建日程（「帮我把周五下午 3 点的评审记到日历」）。
//
// 原生能力经 native/Cortex_Helper 的 calendar-events / calendar-create 子命令（EventKit）。
// 那两条命令的时间进出一律 epoch 毫秒，全部解析责任在 ./time.ts（详见该文件头）。
//
// ⚠️ 【只在 pi RPC 聊天路径注入】
// create_calendar_event 必须逐次经用户确认，而真审批回路只在 pi RPC 存在（claude 走
// --dangerously-skip-permissions、codex 内置 server 被强制 approve、pi 单发路径不写审批
// extension）。所以本 server 只接 ipc/pi-session.ts 一处，刻意不进 ipc/cli.ts。
// 同 capabilities/computer-use/inject.ts 的既定判例。
//
// ⚠️ 【门控哲学：宁可不给，也不给一套必然失败的工具】
// 未授权时**整包不注入**，而不是「注入了、调用时报错引导」。后者的实测后果见
// computer-use/inject.ts:10-12：Agent 会反复重试把整轮对话烧掉，而用户只看到「日历坏了」。
// 授权引导是设置页 UI 的职责。

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle, type ToolContext } from "../mcp-host/server";
import type { McpServerConfig } from "../../ipc/types";
import { CALENDAR_READONLY_TOOLS, CALENDAR_WRITE_TOOLS } from "../../ipc/types";
import { getCalendarHelper, readCalendarAccess } from "./helper";
import {
  DEFAULT_EVENT_MINUTES,
  DEFAULT_WINDOW_DAYS,
  formatLocal,
  localTimeZone,
  parseTimeInput,
  resolveWindow,
} from "./time";

export const CALENDAR_SERVER_ID = "cortex-calendar";

const calendarHost = createMcpHost(CALENDAR_SERVER_ID);

// ── per-session 状态 ─────────────────────────────────────────────────────────
// 日历没有 cwd 之类的会话上下文，只需记「这个 session 有没有写权限」。
// 与 automation 同构的 G1 守卫：未登记的 sessionId 一个工具都拿不到。

interface SessionState {
  allowWrite: boolean;
}

const sessionStateMap = new Map<string, SessionState>();

export function registerCalendarSession(sessionId: string, state: SessionState): void {
  sessionStateMap.set(sessionId, state);
}

export function unregisterCalendarSession(sessionId: string): void {
  sessionStateMap.delete(sessionId);
}

export function hasCalendarSession(sessionId: string): boolean {
  return sessionStateMap.has(sessionId);
}

// ── 结果构造 ─────────────────────────────────────────────────────────────────

function makeErrorResult(message: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function makeSuccessResult(
  text: string,
  data?: Record<string, unknown>,
): { content: [{ type: "text"; text: string }] } {
  const fullText = data ? `${text}\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: "text", text: fullText }] };
}

// 授权码 → 面向模型的可执行文案。绝不能返回「调用失败」这类笼统信息：模型无法据此判断
// 该重试、该换参数、还是该告诉用户去授权。
function accessErrorText(code: unknown, fallback: string): string {
  switch (code) {
    case "calendar-not-authorized":
      return "日历访问未获授权。请让用户到 设置 → 快捷回复 → 权限 授予日历访问后再试。本次未读取到任何数据。";
    case "calendar-read-requires-full-access":
      return "当前只有「仅添加」日历权限，无法读取日程。请让用户到 系统设置 → 隐私与安全性 → 日历 把 Cortex 改为「完全访问」。";
    case "no-writable-calendar":
      return "找不到可写入的日历。请让用户在「日历」应用里确认存在一个可编辑的默认日历。";
    case "save-failed":
      return "系统拒绝了本次写入，日程未创建。";
    case "bad-payload":
    case "bad-args":
      return "参数不合法，日程未创建。";
    default:
      return fallback;
  }
}

const MAX_EVENTS_RETURNED = 200;

// ── 工具注册 ─────────────────────────────────────────────────────────────────

/**
 * 注册日历工具。
 *
 * G1 守卫同 automation：sessionStateMap 未登记即一个工具都不注册。
 * 写工具额外要求 state.allowWrite（只有 pi RPC 路径会传 true）。
 *
 * description 里注入**当前本机时间**：模型幻觉「今天几号」是这类工具最大的错误来源，
 * 而 mcp-host 的 makeServer 是每请求新建的，所以这里算出来的时间总是新鲜的。
 */
export function registerCalendarTools(mcp: McpServer, ctx: ToolContext): void {
  const state = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
  if (!state) return;

  const tz = localTimeZone();
  const nowNote = `当前本机时间 ${formatLocal(Date.now())}（时区 ${tz}）。`;
  const timeNote =
    "时间写法三选一：2026-08-04T14:00（按本机时区）、2026-08-04T14:00+08:00（指定时区）、" +
    "2026-08-04（整天）。不接受自然语言（如「明天下午」）与时间戳。";

  // ── list_calendar_events ───────────────────────────────────────────────────
  mcp.registerTool(
    "list_calendar_events",
    {
      description:
        "查询用户系统日历在指定时间窗内的日程（含全天事件），用于回答「我下周三有空吗」" +
        "「明天几点有会」这类问题。" +
        `省略参数即查询从现在起 ${DEFAULT_WINDOW_DAYS} 天。` +
        nowNote +
        timeNote +
        "若不确定今天是几号，先不带参数调用一次本工具，返回结果里的 now 即为准确的当前时间。",
      inputSchema: {
        start: z.string().optional().describe("起始时间；省略 = 现在"),
        end: z.string().optional().describe(`结束时间；省略 = start 起 ${DEFAULT_WINDOW_DAYS} 天`),
      },
    },
    async ({ start, end }: { start?: string; end?: string }) => {
      const helper = getCalendarHelper();
      if (!helper) return makeErrorResult("当前环境不支持系统日历（仅 macOS 可用）。");

      const now = Date.now();
      const win = resolveWindow(start, end, now);
      if (!win.ok) {
        // 解析失败时把「你给的是什么、现在几点、时区是什么」一并告诉模型，它才有条件自我纠正。
        return makeErrorResult(
          `${win.reason}\n当前本机时间：${formatLocal(now)}，时区 ${tz}。${timeNote}`,
        );
      }

      let res: Record<string, unknown>;
      try {
        res = await helper.calendarEvents(win.startMs, win.endMs);
      } catch (e) {
        return makeErrorResult(`读取日历失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.ok !== true) {
        return makeErrorResult(accessErrorText(res.error, `读取日历失败：${String(res.error ?? "未知错误")}`));
      }

      const raw = (res.events as Array<Record<string, unknown>>) ?? [];
      const events = raw.slice(0, MAX_EVENTS_RETURNED).map((e) => ({
        title: e.title,
        start: formatLocal(Number(e.startMs)),
        end: formatLocal(Number(e.endMs)),
        all_day: e.allDay === true,
        ...(e.location ? { location: e.location } : {}),
        calendar: e.calendar,
      }));

      // now / time_zone 每次回带：pi 的工具集在 open 时冻结，description 里的时间对长会话会
      // 过期，而结果里的这两个字段永远是新鲜的。
      const meta = {
        now: formatLocal(now),
        time_zone: tz,
        window_start: formatLocal(win.startMs),
        window_end: formatLocal(win.endMs),
        truncated: res.truncated === true || raw.length > MAX_EVENTS_RETURNED,
      };
      if (events.length === 0) {
        return makeSuccessResult(
          `${formatLocal(win.startMs)} 到 ${formatLocal(win.endMs)} 之间没有任何日程。`,
          { ...meta, events: [] },
        );
      }
      return makeSuccessResult(`该时间段共 ${events.length} 个日程：`, { ...meta, events });
    },
  );

  if (!state.allowWrite) return;

  // ── create_calendar_event ──────────────────────────────────────────────────
  mcp.registerTool(
    "create_calendar_event",
    {
      description:
        "在用户的系统日历中创建一个日程。" +
        nowNote +
        timeNote +
        `省略 end 即默认 ${DEFAULT_EVENT_MINUTES} 分钟。` +
        "不支持邀请参与者，也不支持重复日程 —— 需要这些时请告知用户手动在「日历」应用里操作。",
      inputSchema: {
        title: z.string().min(1).max(200).describe("日程标题"),
        start: z.string().describe("开始时间"),
        end: z.string().optional().describe(`结束时间；省略 = start 起 ${DEFAULT_EVENT_MINUTES} 分钟`),
        all_day: z.boolean().optional().describe("是否为全天事件"),
        notes: z.string().max(4000).optional().describe("备注"),
        location: z.string().max(200).optional().describe("地点"),
        calendar: z.string().optional().describe("目标日历名称；省略用系统默认日历"),
        alarm_minutes_before: z
          .number()
          .int()
          .min(0)
          .max(40320)
          .optional()
          .describe("提前多少分钟提醒"),
      },
    },
    async (args: {
      title: string;
      start: string;
      end?: string;
      all_day?: boolean;
      notes?: string;
      location?: string;
      calendar?: string;
      alarm_minutes_before?: number;
    }) => {
      const helper = getCalendarHelper();
      if (!helper) return makeErrorResult("当前环境不支持系统日历（仅 macOS 可用）。");

      const now = Date.now();
      const s = parseTimeInput(args.start, "start");
      if (!s.ok) {
        return makeErrorResult(
          `start 参数有误：${s.reason}\n当前本机时间：${formatLocal(now)}，时区 ${tz}。`,
        );
      }
      let endMs = s.ms + DEFAULT_EVENT_MINUTES * 60_000;
      if (args.end !== undefined) {
        const e = parseTimeInput(args.end, "end");
        if (!e.ok) return makeErrorResult(`end 参数有误：${e.reason}`);
        endMs = e.ms;
      }
      if (endMs <= s.ms) return makeErrorResult("结束时间必须晚于开始时间，日程未创建。");

      let res: Record<string, unknown>;
      try {
        res = await helper.calendarCreate({
          title: args.title,
          startMs: s.ms,
          endMs,
          allDay: args.all_day === true,
          ...(args.notes ? { notes: args.notes } : {}),
          ...(args.location ? { location: args.location } : {}),
          ...(args.calendar ? { calendar: args.calendar } : {}),
          ...(args.alarm_minutes_before !== undefined
            ? { alarmMinutesBefore: args.alarm_minutes_before }
            : {}),
        });
      } catch (e) {
        // 超时/进程异常是唯一「不知道到底写没写进去」的情况。必须明说，否则模型会直接重试，
        // 而重试的代价是用户日历里凭空多出两条一模一样的日程。
        return makeErrorResult(
          `创建日程时与系统日历的通信中断（${e instanceof Error ? e.message : String(e)}）。` +
            "**无法确认是否已创建**：请先用 list_calendar_events 核对当天日程，不要直接重试。",
        );
      }
      if (res.ok !== true) {
        return makeErrorResult(
          accessErrorText(res.error, `创建日程失败：${String(res.message ?? res.error ?? "未知错误")}`),
        );
      }

      return makeSuccessResult(`已创建日程「${args.title}」。`, {
        calendar: res.calendar,
        start: formatLocal(Number(res.startMs)),
        end: formatLocal(Number(res.endMs)),
        all_day: res.allDay === true,
      });
    },
  );
}

// ── host 生命周期 ─────────────────────────────────────────────────────────────

export function startCalendarHost(): Promise<McpHostHandle> {
  return calendarHost.start(registerCalendarTools);
}

export function stopCalendarHost(): void {
  calendarHost.stop();
}

export function getCalendarHostHandle(): McpHostHandle | null {
  return calendarHost.getHandle();
}

// ── 注入配置构建 ──────────────────────────────────────────────────────────────

/**
 * 构建日历 MCP server 的注入配置；四道门任一不过返回 null。
 *
 *   1. 非 macOS / helper 未注入 → null（helper 只在 darwin 的 initReply 里注入）
 *   2. 授权档 ≠ full → null
 *   3. host 未起 / 不可用 → null
 *   4. 无 sessionId → null
 *
 * 【为什么 writeOnly 也返回 null】
 * 「仅添加」权限下能写不能读。只给写工具的日历 Agent 会盲写重复日程 —— 它无从知道那个时段
 * 已经有安排了。比完全不给更糟，故一并挡掉，由设置页引导用户升级到完全访问。
 *
 * @param sessionId  pi RPC 会话 id
 * @param allowWrite 是否给 create_calendar_event（只有 pi RPC 路径传 true）
 */
export async function buildCalendarMcpServerConfig(
  sessionId: string | undefined,
  allowWrite: boolean,
): Promise<McpServerConfig | null> {
  if (!sessionId) return null;
  if (!getCalendarHelper()) return null;

  const access = await readCalendarAccess();
  if (access !== "full") return null;

  const handle = getCalendarHostHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;

  registerCalendarSession(sessionId, { allowWrite });

  return {
    id: CALENDAR_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "X-Cortex-Session": sessionId,
    },
  };
}

// 工具名清单（供一致性测试断言：必须与 core 的审批集常量逐字一致，否则审批静默失效）。
export const CALENDAR_TOOL_NAMES = {
  readonly: CALENDAR_READONLY_TOOLS,
  write: CALENDAR_WRITE_TOOLS,
} as const;
