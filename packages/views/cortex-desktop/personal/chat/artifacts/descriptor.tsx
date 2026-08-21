// pi 会话产物面板（artifacts 工具,内存态;与落盘型 "artifact" 是两个概念）的右栏注册描述。
// 无 rail 入口:点产物卡片/步骤 pill 才打开。usePresence:当前会话一个产物都没有(或全被删)
// 时自动收起。
import { usePersonalStore } from "@cortex-work/core";
import { usePiArtifactsStore } from "@cortex-work/core/store/piArtifacts";
import type { RightPanelDescriptor } from "../../right-panel/types";

export const piArtifactsPanel = {
  id: "piArtifacts",
  title: "会话产物",
  widthTier: "wide",
  canMaximize: true,
  usePresence: () => {
    const activeSessionId = usePersonalStore((s) => s.activeSessionId);
    return usePiArtifactsStore(
      (s) => !!activeSessionId && (s.sessions[activeSessionId]?.order.length ?? 0) > 0,
    );
  },
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
