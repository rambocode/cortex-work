// 宠物状态机的宿主 + 桌面端状态转发。不渲染任何 DOM。
//
// 两件事,注意它们的启用条件不同:
// 1. **启动状态机(两端都做)**。真实的活动信号——用户打字、agent 的 thinking/tool/text
//    事件、审批挂起——只在这个窗口的渲染进程里发生。桌面端主窗口不再渲染 <Pet/> 本体
//    (挪去独立 overlay 窗口),但状态机必须留在这里,不能跟着 <Pet/> 搬走:
//    overlay 是纯镜像,让它自己跑一份时钟会与主窗口互相回滚(重构前 happy 被同步顶回来
//    就是这个毛病,见 core/pet/engine.ts 头注释)。
// 2. **转发给 overlay(仅桌面端)**。订阅 usePetStore 变化经 desktopBridge 交给主进程,
//    再广播给 pet-overlay 窗口(见 apps/desktop/src/main/ipc/pet.ts)。Web 端
//    desktopBridge 为 null,这一段整体跳过,由同窗口内嵌的 <Pet/> 直接消费 store。

import { useEffect } from "react";
import { usePetStore, usePersonalStore, useDesktopBridge, type PetStateSnapshot } from "@cortex-work/core";
import { petActivity, startPetEngine } from "@cortex-work/core/pet";
import { loadPetEnabled, loadPetKind, loadPetSize, savePetEnabled } from "./prefs";

/** 审批挂起在活动注册表里的固定 key——整个应用同一时刻只需要一个「有没有人在等你点」的位。 */
const PI_UI_AWAITING_KEY = "pi-ui";

export function PetBridge() {
  const bridge = useDesktopBridge();

  useEffect(() => {
    // 设置的唯一恢复点。overlay 里的 <Pet/> 刻意不读 localStorage——file:// 页面各自的
    // storage 不是同一份,让它自己读会在收到同步快照后又用默认值覆盖回去。
    usePetStore.setState({ kind: loadPetKind(), enabled: loadPetEnabled(), size: loadPetSize() });

    const stop = startPetEngine();

    // 「有挂起的审批」直接从 store 派生,而不是在每个入队/出队现场手工置位:
    // 弹窗的产生与清除散落在崩溃、超时、切会话、用户回答等多条路径上,手工记账必然漏。
    const syncAwaiting = (pending: number) => petActivity.setAwaiting(PI_UI_AWAITING_KEY, pending > 0);
    syncAwaiting(usePersonalStore.getState().piUiPending.length);
    const offAwaiting = usePersonalStore.subscribe((s) => syncAwaiting(s.piUiPending.length));

    return () => {
      offAwaiting();
      stop();
    };
  }, []);

  useEffect(() => {
    if (!bridge?.reportPetState) return;
    // 挂载时先发一次当前快照,再订阅后续变化——避免 pet-overlay 窗口在两者都刚起来时
    // 错过第一次同步(overlay 侧也会主动 requestPetSync 兜底,双保险)。
    const snapshot = (s: ReturnType<typeof usePetStore.getState>): PetStateSnapshot => ({
      state: s.state,
      kind: s.kind,
      enabled: s.enabled,
      size: s.size,
      // sprite 由渲染层解析后填入(见 pet/source.ts);为 null 时 overlay 按 kind 兜底
      // 用内置角色渲染,这也是首启尚未选过 petdex 宠物时的正常状态。
      sprite: s.sprite,
    });
    bridge.reportPetState(snapshot(usePetStore.getState()));
    const offEnabledChange = bridge.onPetEnabledChange?.((enabled) => {
      if (usePetStore.getState().enabled === enabled) return;
      savePetEnabled(enabled);
      usePetStore.getState().setEnabled(enabled);
    });
    const offStore = usePetStore.subscribe((s) => bridge.reportPetState?.(snapshot(s)));
    return () => {
      offEnabledChange?.();
      offStore();
    };
  }, [bridge]);

  return null;
}
