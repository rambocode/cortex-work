// 落地页「用量日历」token 模式数据层：按天 token 用量 hook + token 定档/周列纯函数。
// 与活动模式（personal/home.ts 的 useAllProjectsTimeline + buildHeatmapWeeks + homeHeatLevel）
// 并列；token 数据经 DesktopBridge.dailyUsage 从主进程按天聚合的 Claude Code 本地日志获取。

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DailyUsage, DailyUsagePoint } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { buildHeatmapWeeks, type HeatWeek } from "./home";

// token 热力档位（0..4）。token 量级远大于活动计数，阈值据真实日志量级取整，可后续微调。
export function tokenHeatLevel(tokens: number): number {
  if (tokens <= 0) return 0;
  if (tokens <= 50_000) return 1;
  if (tokens <= 200_000) return 2;
  if (tokens <= 1_000_000) return 3;
  return 4;
}

// 近 N 周的周列方格：复用活动热力图的日期骨架（周一起始、今天所在周为末列），
// 把每日 token 总量覆盖进各格的 cell.tokens；缺失天为 0（占位）。
export function buildTokenWeeks(weeks: number, points: DailyUsagePoint[], today: number = Date.now()): HeatWeek[] {
  const tokensByDay = new Map(points.map((p) => [p.day, p.tokens]));
  return buildHeatmapWeeks(weeks, [], today).map((w) => ({
    ...w,
    cells: w.cells.map((c) => ({ ...c, tokens: tokensByDay.get(c.day) ?? 0 })),
  }));
}

// 按天 token 用量 hook。机器级数据（不带 wsId，与 usage/agent-projects 一致）；
// bridge 不支持（web / 旧壳）时不请求、返回空。refresh 触发重新拉取（卡片刷新按钮用）。
export function useDailyUsage(weeks = 26): {
  days: DailyUsagePoint[];
  loading: boolean;
  refresh: () => void;
} {
  const bridge = useDesktopBridge();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<DailyUsage>({
    queryKey: ["personal", "daily-usage", weeks],
    enabled: !!bridge?.dailyUsage,
    staleTime: 60_000,
    queryFn: () => (bridge?.dailyUsage ? bridge.dailyUsage(weeks) : Promise.resolve({ at: 0, days: [] })),
  });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["personal", "daily-usage", weeks] });
  }, [queryClient, weeks]);
  return { days: data?.days ?? [], loading: isLoading, refresh };
}
