// 按天 token 用量的纯逻辑（不依赖 electron，便于单测；与 usage.ts 的 IPC 装配解耦）。

import type { DailyUsagePoint } from "./types";

// 单条 assistant usage 事件（usage.ts 增量解析 ~/.claude/projects/**/*.jsonl 得到）。
export interface UsageEvent {
  t: number;
  in: number;
  out: number;
  cc: number;
  cr: number;
}

// 本地零点日键，与 core/personal/timeline.ts 的 dayKey 等价（主进程不依赖 core 包，复制一份）。
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 把 usage 事件按本地零点日累加为「日 → token 总量」，仅保留近 weeks*7 天，按日升序。
// 纯函数（now 可注入）便于单测。
export function bucketEventsByDay(events: UsageEvent[], weeks: number, now: number): DailyUsagePoint[] {
  const cutoffDay = dayKey(now - (weeks * 7 - 1) * 86400000); // 含今天往前 weeks*7 天
  const byDay = new Map<string, { tokens: number; msgs: number }>();
  for (const e of events) {
    const day = dayKey(e.t);
    if (day < cutoffDay) continue;
    const cur = byDay.get(day) ?? { tokens: 0, msgs: 0 };
    cur.tokens += e.in + e.out + e.cc + e.cr;
    cur.msgs += 1;
    byDay.set(day, cur);
  }
  return [...byDay.entries()]
    .map(([day, v]) => ({ day, tokens: v.tokens, msgs: v.msgs }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
