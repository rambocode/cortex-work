// 落地页 Hero 区的静态激励文案池（立即渲染 + 全局兜底）。
// 面向 30–50 岁、同时承受家庭与工作压力、可能焦虑的用户:温暖、笃定、给力量,
// 而非空洞口号。每天按 dayKey 确定性轮换一条（同一天稳定、跨天变化）。
// LLM 增强（useDailyEncouragement）拿到结果后会覆盖这里的静态文案,失败/web/无 agent
// 则始终回退到本池。

import { dayKey } from "@cortex-work/core";

export interface Encouragement {
  title: string;
  sub: string;
}

// 时段划分(与 hero 问候语气一致):深夜 / 清晨 / 上午 / 午间 / 下午 / 夜晚。
type Slot = "lateNight" | "earlyMorning" | "morning" | "noon" | "afternoon" | "evening";

export function slotOf(hour: number): Slot {
  if (hour < 5) return "lateNight";
  if (hour < 9) return "earlyMorning";
  if (hour < 12) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  return "evening";
}

// 每个时段一组精选文案。title 简短有力(≤16字),sub 一句话托住情绪(≤30字)。
const POOL: Record<Slot, Encouragement[]> = {
  lateNight: [
    { title: "夜深了，别太为难自己", sub: "今天已经够努力了，剩下的交给明天。" },
    { title: "再撑一会儿，也记得休息", sub: "把最要紧的一件写下来，其余的先放下。" },
    { title: "安静的时刻，最适合理清思路", sub: "不必赶，慢慢来，一步也算数。" },
  ],
  earlyMorning: [
    { title: "早安，新的一天属于你", sub: "先做一件小事，节奏就回来了。" },
    { title: "醒来就是一种胜利", sub: "今天不必完美，只要往前一点点。" },
    { title: "给自己一个温和的开始", sub: "一杯水、一口气，然后开始。" },
  ],
  morning: [
    { title: "上午是黄金时段，握住它", sub: "挑最重要的一件，专注做完。" },
    { title: "你比想象中更能扛", sub: "把大事拆小，先推动第一步。" },
    { title: "稳住节奏，别被琐事牵走", sub: "重要的事先做，杂事自会让路。" },
  ],
  noon: [
    { title: "忙到这里，先喘口气", sub: "午间充会儿电，下半天更有劲。" },
    { title: "上半天辛苦了", sub: "吃口饭、走两步，再继续也不迟。" },
    { title: "中场休息，也是在前进", sub: "照顾好自己，才走得更远。" },
  ],
  afternoon: [
    { title: "下午继续，你已经走了很远", sub: "再完成一件，就离目标更近一步。" },
    { title: "有点累是正常的，别硬扛", sub: "换个简单的任务，慢慢找回手感。" },
    { title: "把注意力收回来一点", sub: "专注二十分钟，胜过焦虑一下午。" },
  ],
  evening: [
    { title: "晚上好，今天辛苦了", sub: "工作与家庭之间，你已经做得很好。" },
    { title: "收个尾，给今天画句号", sub: "留一件小事明天做，今晚好好歇。" },
    { title: "你撑起了很多，值得被善待", sub: "此刻属于你，做点让自己松快的事。" },
  ],
};

// dayKey 字符串的稳定哈希（用于按天确定性选一条,避免引入随机源）。
function hashDay(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// 兜底（理论不会触达:所有时段池均非空,仅为满足索引类型收窄）。
const FALLBACK: Encouragement = { title: "开始今天", sub: "一步一步来,你可以的。" };

// 按当前时段 + 当天 dayKey 确定性选一条激励文案。纯函数,同一天同一时段稳定。
export function pickEncouragement(now: Date): Encouragement {
  const pool = POOL[slotOf(now.getHours())];
  const idx = hashDay(dayKey(now.getTime())) % pool.length;
  return pool[idx] ?? FALLBACK;
}
