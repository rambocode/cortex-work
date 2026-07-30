// 自动化展示用纯函数：定时规则摘要、时间格式化、运行状态标签/样式、推理强度标签、耗时。
// List 与 Detail（含重做后的详情子组件）共用,避免文案漂移。
// 注：AGENT_LABEL 已在 agentMeta.ts 规范导出,详情组件直接复用那一份,不在此重复定义。

import type { AutomationRun, AutomationRunStatus, ReasoningEffort, ScheduleSpec } from "@cortex-work/core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n: number) => String(n).padStart(2, "0");

// 推理强度展示标签。原先散落在 AutomationDetail/AutomationDialog,收敛至此供详情子组件统一引用。
export const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: "低", medium: "中", high: "高" };

// 运行耗时(开始→结束)摘要。未结束(无 endedAt)返回空串;<60s 显示「Ns」,否则「Nm Ss」。
export function fmtDuration(run: AutomationRun): string {
  if (!run.endedAt) return "";
  const s = Math.round((run.endedAt - run.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

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
    case "once": {
      // once 存绝对时刻（epoch ms），与任务 timezone 无关；摘要按本地时间展示。
      const d = new Date(s.at);
      return `一次性 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
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
