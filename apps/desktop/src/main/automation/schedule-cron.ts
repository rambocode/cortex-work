// 定时规则 ↔ cron 表达式的纯函数（不依赖 electron,可单测）。
// croner 用 5 段标准 cron：分 时 日 月 周;周 0-6（0=周日,与 JS getDay() 一致,
// croner 同时接受 7=周日）。weekdays 用 1-5（周一~周五）。

import { Cron } from "croner";
import type { CronValidation, ScheduleSpec } from "../ipc/types";

export interface SpecValidation {
  ok: boolean;
  error?: string;
}

function inRange(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

// 校验 ScheduleSpec 的数值域（IPC create/update 前置校验,挡掉 "60 * * * *" 之类）。
export function validateScheduleSpec(spec: ScheduleSpec): SpecValidation {
  switch (spec.kind) {
    case "hourly":
      if (!inRange(spec.minute, 0, 59)) return { ok: false, error: "分钟需在 0-59" };
      return { ok: true };
    case "daily":
    case "weekdays":
      if (!inRange(spec.hour, 0, 23)) return { ok: false, error: "小时需在 0-23" };
      if (!inRange(spec.minute, 0, 59)) return { ok: false, error: "分钟需在 0-59" };
      return { ok: true };
    case "weekly":
      if (!inRange(spec.weekday, 0, 6)) return { ok: false, error: "星期需在 0-6（0=周日）" };
      if (!inRange(spec.hour, 0, 23)) return { ok: false, error: "小时需在 0-23" };
      if (!inRange(spec.minute, 0, 59)) return { ok: false, error: "分钟需在 0-59" };
      return { ok: true };
    case "cron": {
      const expr = (spec.expression ?? "").trim();
      if (!expr) return { ok: false, error: "cron 表达式不能为空" };
      const v = validateCron(expr);
      return v.ok ? { ok: true } : { ok: false, error: v.error };
    }
    case "once":
      // 只校验 at 为有限数;不强制 future(避免时钟漂移/编辑历史任务被拒),
      // future 约束交给 UI(ScheduleEditor 软兜)。
      if (!Number.isFinite(spec.at)) return { ok: false, error: "一次性时间无效" };
      return { ok: true };
    default:
      return { ok: false, error: "未知的定时类型" };
  }
}

// ScheduleSpec → 5 段 cron。cron kind 原样返回（已由 validateCron 把关）。
// 注意:once 无 cron 表示,由调用方(scheduleOne / computeNextRun)在调用前单独分支,
// 不应走到此函数;若走到说明调用方漏分支,显式抛错而非静默产出错误 cron。
export function scheduleToCron(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "hourly":
      return `${spec.minute} * * * *`;
    case "daily":
      return `${spec.minute} ${spec.hour} * * *`;
    case "weekdays":
      return `${spec.minute} ${spec.hour} * * 1-5`;
    case "weekly":
      return `${spec.minute} ${spec.hour} * * ${spec.weekday}`;
    case "cron":
      return spec.expression.trim();
    case "once":
      throw new Error("once 排期无 cron 表示,应由调用方单独分支处理");
  }
}

// 构造一个仅用于计算的 Cron（不带回调,不会触发）。算完即 stop 释放。
function withProbeJob<T>(pattern: string, timezone: string | undefined, fn: (job: Cron) => T): T {
  const job = new Cron(pattern, timezone ? { timezone } : {});
  try {
    return fn(job);
  } finally {
    job.stop();
  }
}

// 校验 cron 表达式合法性 + 预览下次触发（croner 对非法表达式构造时抛错）。
export function validateCron(expression: string, timezone?: string): CronValidation {
  const expr = (expression ?? "").trim();
  if (!expr) return { ok: false, error: "cron 表达式不能为空" };
  try {
    return withProbeJob(expr, timezone, (job) => {
      const next = job.nextRun();
      return { ok: true, nextRun: next ? next.getTime() : undefined };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "非法的 cron 表达式" };
  }
}

// 计算某 ScheduleSpec 在 after（缺省 now）之后的下次触发 epoch ms;非法或永不触发返回 null。
export function computeNextRun(spec: ScheduleSpec, timezone?: string, after?: Date): number | null {
  try {
    // once: 纯比较,过了触发点(at <= after/now)即永不再触发返回 null;不构造 croner。
    if (spec.kind === "once") {
      const ref = (after ?? new Date()).getTime();
      return spec.at > ref ? spec.at : null;
    }
    const pattern = scheduleToCron(spec);
    return withProbeJob(pattern, timezone, (job) => {
      const next = after ? job.nextRun(after) : job.nextRun();
      return next ? next.getTime() : null;
    });
  } catch {
    return null;
  }
}
