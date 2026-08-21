// 团队实时层挂载组件：把 useTeamRealtime 收进独立组件，使 CortexDesktopView 能按
// 「团队 tab 且已登录」条件挂/卸（hook 不能条件调用，组件可以条件渲染）。
// 卸载即断 WS（切去个人工作区/登出时自动收敛连接）。

import { useTeamRealtime } from "@cortex-work/core";

export function TeamRealtimeMount() {
  useTeamRealtime();
  return null;
}
