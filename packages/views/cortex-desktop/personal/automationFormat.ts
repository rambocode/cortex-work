// 自动化展示用纯函数：定时规则摘要、时间格式化、运行状态标签/样式。
// List 与 Detail 共用,避免文案漂移。

import type { AutomationRunStatus, ScheduleSpec } from "@cortex-work/core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n: number) => String(n).padStart(2, "0");

export function scheduleSummary(s: ScheduleSpec): string {
  switch (s.kind) {
    case "hourly":
      return `每小时（第 ${s.minute} 分）`;
    case "daily":
      return `每天 ${pad(s.hour)}:${pad(s.minute)}`;
    case "weekdays":
      return `工作日 ${pad(s.hour)}:${pad(s.minute)}`;
    case "weekly":
      return `每${WEEKDAYS[s.weekday] ?? "周"} ${pad(s.hour)}:${pad(s.minute)}`;
    case "cron":
      return `cron：${s.expression}`;
  }
}

export function fmtDateTime(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATUS_LABEL: Record<AutomationRunStatus, string> = {
  running: "运行中",
  ok: "成功",
  error: "失败",
  timeout: "超时",
  killed: "已中断",
  skipped: "已跳过",
};

export const STATUS_CLASS: Record<AutomationRunStatus, string> = {
  running: "is-running",
  ok: "is-ok",
  error: "is-err",
  timeout: "is-err",
  killed: "is-warn",
  skipped: "is-warn",
};
