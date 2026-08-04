// 自动化 MCP 工具的定时参数解析（纯函数，不依赖 electron，可单测）。
//
// 【为什么把 ScheduleSpec 拍平成 kind + 可选字段，而不是直接给模型一个判别联合】
// 工具的 inputSchema 最终经 agents/pi-mcp-bridge.ts 原样转发给用户自配的任意 OpenAI 兼容网关
// （本产品明确支持 new-api / one-api 这类聚合网关）。判别联合会产出 anyOf + const 判别子，
// 这类 schema 在函数参数位置被拒或被静默降级是常见事故 —— 而事故表现是「模型说建好了，
// 其实工具调用压根没发出去」，极难排查。扁平化后 schema 只有基础类型，兼容性最好。
//
// 代价是「哪些字段按 kind 必填」要在这里手工校验。换来的好处是错误可以说人话
// （「每周任务需要 weekday（0=周日 .. 6=周六）」），模型能据此自我纠正。
// 数值域校验则复用 automation/schedule-cron.ts 的 validateScheduleSpec，与 IPC 路径同一个合法域。

import type { ScheduleSpec } from "../../ipc/types";
import { validateScheduleSpec } from "../../automation/schedule-cron";

export const SCHEDULE_KINDS = ["hourly", "daily", "weekdays", "weekly", "cron", "once"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export interface ScheduleInputArgs {
  schedule_kind?: string;
  minute?: number;
  hour?: number;
  weekday?: number;
  cron_expression?: string;
  at?: string;
}

export type BuildScheduleResult = { ok: true; spec: ScheduleSpec } | { ok: false; error: string };

const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// 允许的一次性时刻格式：必须带具体时刻，可带秒/毫秒/时区偏移。
// **刻意不接受纯日期**（"2026-08-05"）：ES 规范里纯日期按 UTC 解释、而带时刻的按本地时区解释，
// 同一个 Date.parse 有两种基准。一次性任务本来就必须给到分钟，直接拒掉纯日期即可绕开这个歧义，
// 顺带避免「用户说明早九点、任务在 UTC 零点触发」这类差 8 小时的事故。
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** 两位补零，用于 describeSchedule 的 HH:mm。 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 把模型给的扁平参数组装成 ScheduleSpec。
 * 失败时返回可读中文原因（直接作为 MCP 工具的 isError 文本回给模型，供其自我纠正）。
 */
export function buildScheduleSpec(args: ScheduleInputArgs): BuildScheduleResult {
  const kind = args.schedule_kind;
  if (!kind || !(SCHEDULE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `schedule_kind 必须是 ${SCHEDULE_KINDS.join(" / ")} 之一，收到：${kind ?? "(空)"}` };
  }

  let spec: ScheduleSpec;
  switch (kind as ScheduleKind) {
    case "hourly":
      if (args.minute === undefined) return { ok: false, error: "每小时任务需要 minute（0-59），表示每小时的第几分钟触发" };
      spec = { kind: "hourly", minute: args.minute };
      break;
    case "daily":
      if (args.hour === undefined || args.minute === undefined) {
        return { ok: false, error: "每天任务需要 hour（0-23）与 minute（0-59）" };
      }
      spec = { kind: "daily", hour: args.hour, minute: args.minute };
      break;
    case "weekdays":
      if (args.hour === undefined || args.minute === undefined) {
        return { ok: false, error: "工作日任务需要 hour（0-23）与 minute（0-59）" };
      }
      spec = { kind: "weekdays", hour: args.hour, minute: args.minute };
      break;
    case "weekly":
      if (args.weekday === undefined || args.hour === undefined || args.minute === undefined) {
        return { ok: false, error: "每周任务需要 weekday（0=周日 .. 6=周六）、hour（0-23）与 minute（0-59）" };
      }
      spec = { kind: "weekly", weekday: args.weekday, hour: args.hour, minute: args.minute };
      break;
    case "cron": {
      const expr = (args.cron_expression ?? "").trim();
      if (!expr) return { ok: false, error: "自定义任务需要 cron_expression（5 段：分 时 日 月 周）" };
      spec = { kind: "cron", expression: expr };
      break;
    }
    case "once": {
      const raw = (args.at ?? "").trim();
      if (!raw) {
        return { ok: false, error: "一次性任务需要 at，格式如 2026-08-05T09:00（不带时区即按本机时区解释）" };
      }
      if (!ISO_DATETIME.test(raw)) {
        return {
          ok: false,
          error: `at 需要形如 2026-08-05T09:00 的日期时间（必须含时分，可带时区偏移如 +08:00）。收到：${raw}`,
        };
      }
      const ms = Date.parse(raw.replace(" ", "T"));
      if (!Number.isFinite(ms)) return { ok: false, error: `无法解析 at：${raw}` };
      spec = { kind: "once", at: ms };
      break;
    }
  }

  // 数值域交给 IPC 路径同一个把关函数（"分钟需在 0-59" 等文案由它给出）。
  const v = validateScheduleSpec(spec);
  if (!v.ok) return { ok: false, error: v.error ?? "定时规则无效" };
  return { ok: true, spec };
}

/** ScheduleSpec → 中文描述，用于 list_automations 的可读输出。 */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "hourly":
      return `每小时第 ${spec.minute} 分`;
    case "daily":
      return `每天 ${pad2(spec.hour)}:${pad2(spec.minute)}`;
    case "weekdays":
      return `工作日 ${pad2(spec.hour)}:${pad2(spec.minute)}`;
    case "weekly":
      return `每${WEEKDAY_LABEL[spec.weekday] ?? `周${spec.weekday}`} ${pad2(spec.hour)}:${pad2(spec.minute)}`;
    case "cron":
      return `自定义 cron：${spec.expression}`;
    case "once":
      return `一次性：${new Date(spec.at).toLocaleString("zh-CN")}`;
  }
}

/** 本次 patch 是否碰了定时规则（决定 update 时要不要求 schedule_kind 必填）。 */
export function touchesSchedule(args: ScheduleInputArgs): boolean {
  return (
    args.schedule_kind !== undefined ||
    args.minute !== undefined ||
    args.hour !== undefined ||
    args.weekday !== undefined ||
    args.cron_expression !== undefined ||
    args.at !== undefined
  );
}
