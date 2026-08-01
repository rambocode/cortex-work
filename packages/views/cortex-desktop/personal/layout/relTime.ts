// 相对时间格式化（「刚刚 / N 分钟 / N 小时 / N 天 / N 周 / N 个月」）。
//
// 原本内联在 PersonalSidebar.tsx 里，被会话列表、闪记、任务、归档会话等六处 import。
// 抽成独立文件是因为侧栏底部的 NotificationBell 也要用它——而 PersonalSidebar 反过来
// 要 import NotificationBell，留在原处会形成循环依赖。
// PersonalSidebar 仍 re-export 本函数，故既有 import 路径全部不受影响。

export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天`;
  // 周/月粒度:超过 7 天的旧条目(归档会话等)不再笼统显示「N 天」。
  if (day < 30) return `${Math.floor(day / 7)} 周`;
  return `${Math.floor(day / 30)} 个月`;
}
