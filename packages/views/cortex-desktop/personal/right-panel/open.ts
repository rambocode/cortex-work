// 右栏面板的类型化打开/消费入口。core 的 requestPanel/consumePanelRequest 是 unknown 面
// 的无知通道,类型安全在这一层由 PanelPayloadMap + KnownPanelId 泛型约束兜住——
// 这里是全仓鼓励的唯一调用面（消灭「setRightView + setRightOpen」双调用样板）。

import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { resolvePanel, type KnownPanelId } from "./registry";
import type { PanelPayloadMap } from "./types";

/** 有载荷面板允许省略 payload（纯切视图）;无载荷面板不接受第二参。 */
type OpenPanelArgs<K extends KnownPanelId> = K extends keyof PanelPayloadMap
  ? [payload?: PanelPayloadMap[K]]
  : [];

/**
 * 打开右栏某面板并连带展开右栏。无 payload 走 setRightView(不留 stale 请求),
 * 有 payload 走统一请求槽。顺带同步预取该面板 chunk,缩短懒加载首开的 Suspense 空窗
 * （空窗期面板根类名不存在,:has 宽度档会短暂回落默认 320px）。
 */
export function openPanel<K extends KnownPanelId>(id: K, ...args: OpenPanelArgs<K>): void {
  const [payload] = args as [unknown?];
  const personal = usePersonalStore.getState();
  if (payload === undefined) personal.setRightView(id);
  else personal.requestPanel(id, payload);
  useCortexUIStore.getState().setRightOpen(true);
  void resolvePanel(id).load();
}

/** 类型化消费:仅当当前请求属于该面板时返回载荷并清槽（core 层保证不匹配不清槽）。 */
export function consumePanelRequest<K extends KnownPanelId & keyof PanelPayloadMap>(
  id: K,
): PanelPayloadMap[K] | undefined {
  return usePersonalStore.getState().consumePanelRequest(id) as PanelPayloadMap[K] | undefined;
}
