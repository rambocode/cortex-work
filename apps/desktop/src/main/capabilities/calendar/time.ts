// 日历工具的时间解析与格式化（纯函数，无 electron 依赖，可单测）。
//
// 【绝不用 Date.parse 处理用户/模型给的时间字符串】
// ES 规范里 "2026-08-04T14:00" 按**本地时区**解释，而 "2026-08-04" 按 **UTC** 解释 —— 同一个
// 函数两种基准。直接丢给 Date.parse 的后果是：模型说「查 8 月 4 日的日程」，在 UTC+8 下实际
// 查的是 8 月 3 日 08:00 起的窗口，少一天多一天全看时区。这类偏移不会报错，只会让模型自信地
// 报出错误答案。所以这里手写解析，并对两种形态显式定义语义（见 parseTimeInput）。
//
// 【为什么解析必须放在 TS 侧】
// helper 那边（native/Cortex_Helper）没有 test target，Swift 逻辑无法单测。所以进程边界上只走
// epoch 毫秒，全部解析责任收在本文件，由 time.test.ts 覆盖 DST / 纯日期 / 偏移三类边界。

/** 解析结果：失败时给可读原因，直接作为工具的 isError 文本回给模型。 */
export type ParseResult = { ok: true; ms: number } | { ok: false; reason: string };

/** 查询窗口上限。EventKit 的 predicateForEvents 对超长窗口会静默返回空，366 天顺带避开。 */
export const MAX_WINDOW_DAYS = 366;
/** 省略 end 时的默认查询跨度。 */
export const DEFAULT_WINDOW_DAYS = 7;
/** 创建日程省略 end 时的默认时长。 */
export const DEFAULT_EVENT_MINUTES = 60;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * 日期/时间各分量的取值域校验。
 *
 * 必须显式做，不能指望 Date 构造函数：new Date(2026, 12, 4) 会**静默滚到 2027 年 1 月**，
 * new Date(2026, 1, 31) 会滚到 3 月 —— 都不抛错、不产生 NaN。模型偶尔会给出 "2026-13-04"
 * 这类月份，滚过去之后查到的是一整年之后的日程，而它会照常汇报给用户。
 */
function partsInRange(y: number, mo: number, d: number, hh = 0, mm = 0, ss = 0): boolean {
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  if (hh > 23 || mm > 59 || ss > 59) return false;
  // 日期真实存在性（2 月 30 日、4 月 31 日）：构造后回读，滚月即判非法。
  const probe = new Date(y, mo - 1, d);
  return probe.getMonth() === mo - 1 && probe.getDate() === d;
}

/** 把 "+08:00" / "+0800" / "Z" 转成相对 UTC 的分钟偏移。 */
function offsetMinutes(raw: string): number {
  if (raw === "Z") return 0;
  const sign = raw[0] === "-" ? -1 : 1;
  const body = raw.slice(1).replace(":", "");
  return sign * (parseInt(body.slice(0, 2), 10) * 60 + parseInt(body.slice(2, 4), 10));
}

/**
 * 解析模型给的时间字符串。三种形态的语义（这是本模块的核心契约，改动必须同步改测试）：
 *
 *   带偏移（...Z / +08:00）  → 按给定偏移，与本机时区无关
 *   无偏移的日期时间          → **本机本地时区**
 *   纯日期                    → 本机本地时区的当日边界；bound="start" 取 00:00:00.000，
 *                               bound="end" 取 23:59:59.999
 *
 * 纯日期分 start/end 两种取法是刻意的：用户说「查 8 月 4 日」时，期望是覆盖一整天，
 * 而不是一个零长度窗口。
 */
export function parseTimeInput(raw: string, bound: "start" | "end" = "start"): ParseResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "时间不能为空" };

  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    if (!partsInRange(Number(y), Number(mo), Number(d))) {
      return { ok: false, reason: `不是有效日期：${text}` };
    }
    const local =
      bound === "start"
        ? new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0)
        : new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
    return { ok: true, ms: local.getTime() };
  }

  const dt = DATE_TIME.exec(text);
  if (!dt) {
    return {
      ok: false,
      reason: `无法解析时间「${text}」。请用 2026-08-04T14:00（本机时区）、2026-08-04T14:00+08:00（指定时区）或 2026-08-04（整天）这三种写法之一。`,
    };
  }
  const [, y, mo, d, hh, mm, ss, off] = dt;
  if (!partsInRange(Number(y), Number(mo), Number(d), Number(hh), Number(mm), Number(ss ?? 0))) {
    return { ok: false, reason: `不是有效时间：${text}` };
  }
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? 0)] as const;

  if (off) {
    // 带偏移：先按 UTC 组装，再减去偏移。
    const utc = Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
    const ms = utc - offsetMinutes(off) * 60_000;
    if (Number.isNaN(ms)) return { ok: false, reason: `不是有效时间：${text}` };
    return { ok: true, ms };
  }

  // 无偏移：交给 Date 构造函数按本地时区解释。注意 DST 空洞时刻（如 America/New_York 的
  // 2026-03-08T02:30 不存在）JS 会规范化到相邻的有效时刻而不抛错 —— 这是我们要的行为，
  // 报错反而会让模型卡死在一个它无法理解的边界上。
  const local = new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], 0);
  if (Number.isNaN(local.getTime())) return { ok: false, reason: `不是有效时间：${text}` };
  return { ok: true, ms: local.getTime() };
}

/** 查询窗口校验：end 必须晚于 start，且跨度不超过上限。 */
export function validateWindow(startMs: number, endMs: number): { ok: true } | { ok: false; reason: string } {
  if (endMs <= startMs) return { ok: false, reason: "结束时间必须晚于开始时间。" };
  const days = (endMs - startMs) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) {
    return { ok: false, reason: `查询窗口不能超过 ${MAX_WINDOW_DAYS} 天（当前 ${Math.round(days)} 天）。请缩小范围后重试。` };
  }
  return { ok: true };
}

/** 本机时区标识；Intl 不可用时退回 UTC。 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * epoch 毫秒 → 带本机偏移的 ISO 串，如 2026-08-04T14:00:00+08:00。
 * 刻意不输出 UTC 的 ...Z：模型看到 Z 结尾常常直接当成本地时间念出来，用户就会收到差 8 小时的答复。
 */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const tz = off === 0 ? "Z" : `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${tz}`
  );
}

/** 解析查询窗口：start 省略即现在，end 省略即 start 起 DEFAULT_WINDOW_DAYS 天。 */
export function resolveWindow(
  start: string | undefined,
  end: string | undefined,
  now: number,
): { ok: true; startMs: number; endMs: number } | { ok: false; reason: string } {
  let startMs = now;
  if (start !== undefined) {
    const r = parseTimeInput(start, "start");
    if (!r.ok) return { ok: false, reason: `start 参数有误：${r.reason}` };
    startMs = r.ms;
  }
  let endMs = startMs + DEFAULT_WINDOW_DAYS * 86_400_000;
  if (end !== undefined) {
    const r = parseTimeInput(end, "end");
    if (!r.ok) return { ok: false, reason: `end 参数有误：${r.reason}` };
    endMs = r.ms;
  }
  const v = validateWindow(startMs, endMs);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, startMs, endMs };
}
