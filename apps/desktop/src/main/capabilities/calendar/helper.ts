// 日历 helper 接线 + 授权档探测缓存。
//
// helper 实例（reply/helper-client.ts 的 CortexHelperClient）由 index.ts 在 initReply() 里注入。
// 副作用即是我们想要的门控：initReply 只在 darwin 上跑，非 mac 上 helper 恒为 null，
// buildCalendarMcpServerConfig 自然返回 null —— 不必把平台判断散落到两处。
//
// 【为什么要缓存授权档】
// helper 的 permissions 命令每次都要 spawn 一个进程（~20-40ms），而 pi:open 在用户敲下回车到
// 首字输出之间的关键路径上。15s TTL + 单飞（并发合并成一次 spawn）足够：授权状态是用户在系统
// 设置里手动改的，秒级延迟无感，而 powerMonitor.resume 与「打开权限设置」之后会主动失效。

import { normalizeCalendarAccess, type CalendarAccessState } from "../../reply/permissions";
import { createLogger } from "../../log";

const log = createLogger("calendar-capability");

/** 只依赖用得到的两个方法，便于测试注入假 helper。 */
export interface CalendarHelper {
  permissions(timeoutMs?: number): Promise<Record<string, unknown>>;
  calendarEvents(startMs: number, endMs: number, timeoutMs?: number): Promise<Record<string, unknown>>;
  calendarCreate(payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

let helper: CalendarHelper | null = null;

/** index.ts 在 initReply() 里注入（darwin-only，见文件头）。 */
export function setCalendarHelper(h: CalendarHelper | null): void {
  helper = h;
  invalidateCalendarAccessCache();
}

export function getCalendarHelper(): CalendarHelper | null {
  return helper;
}

const ACCESS_TTL_MS = 15_000;
let cached: { at: number; value: CalendarAccessState } | null = null;
let inflight: Promise<CalendarAccessState> | null = null;

/** 权限可能刚被用户改过（系统休眠恢复、刚打开过权限设置面板）时调用。 */
export function invalidateCalendarAccessCache(): void {
  cached = null;
  inflight = null;
}

/**
 * 读当前日历授权档。helper 缺失/超时/异常一律按 notDetermined 处理 ——
 * 门控侧据此不注入，不会因为一次探测失败就阻断 pi 会话启动。
 */
export async function readCalendarAccess(now = Date.now()): Promise<CalendarAccessState> {
  if (cached && now - cached.at < ACCESS_TTL_MS) return cached.value;
  if (inflight) return inflight; // 单飞：并发的 pi:open 合并成一次 spawn

  const h = helper;
  if (!h) return "notDetermined";

  inflight = h
    .permissions(3_000)
    .then((res) => normalizeCalendarAccess(res.calendarAccess))
    .catch((e) => {
      log.warn(`日历授权探测失败，本轮按未授权处理: ${String(e)}`);
      return "notDetermined" as CalendarAccessState;
    })
    .then((value) => {
      cached = { at: Date.now(), value };
      inflight = null;
      return value;
    });
  return inflight;
}
