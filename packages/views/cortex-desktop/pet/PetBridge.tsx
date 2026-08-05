// 桌面宠物脱离主窗体后,主窗口不再渲染 <Pet/> 本体(挪去独立 pet-overlay 窗口),但真实的
// PetState 触发信号(用户打字/agent thinking·working·replying 等)仍然只在主窗口的渲染进程里
// 发生(见 ComposerShell/ChatArea 的 onChange、core/personal/messages.ts 的 agent 事件路由)。
// PetBridge 不渲染任何 DOM,只订阅 usePetStore 的变化并经 desktopBridge 转发给主进程,
// 再由主进程广播给 pet-overlay 窗口镜像(见 apps/desktop/src/main/ipc/pet.ts)。
// Web 端 desktopBridge 为 null,订阅是 no-op(CortexDesktopView 在 Web 上仍渲染真正的 <Pet/>)。

import { useEffect } from "react";
import { usePetStore, useDesktopBridge } from "@cortex-work/core";
import { loadPetKind, loadPetSize } from "./designs";
import { loadPetEnabled, savePetEnabled } from "./behavior";

export function PetBridge() {
  const bridge = useDesktopBridge();

  useEffect(() => {
    if (!bridge?.reportPetState) return;
    // 桌面端不再在主窗口挂载 <Pet/>，因此必须由主窗口里的 bridge 恢复设置；随后
    // overlay 只消费这份快照。恢复发生在首次 report 之前，避免先广播 store 默认值。
    usePetStore.setState({
      kind: loadPetKind(),
      enabled: loadPetEnabled(),
      size: loadPetSize(),
    });
    // 挂载时先发一次当前快照,再订阅后续变化——避免 pet-overlay 窗口在两者都刚起来时
    // 错过第一次同步(overlay 侧也会主动 requestPetSync 兜底,双保险)。
    const snapshot = (s: ReturnType<typeof usePetStore.getState>) => ({
      state: s.state,
      kind: s.kind,
      enabled: s.enabled,
      size: s.size,
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
