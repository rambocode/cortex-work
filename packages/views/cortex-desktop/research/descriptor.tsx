// 深度研究面板的右栏注册描述。无 rail 入口:由会话 /skill:research 派发与研究卡片打开。
// usePresence:会话解除全部研究绑定后自动收起——从 store 派生(activeResearchSessionId ??
// refs 末位),不依赖面板 wrapper 内「回看另一条研究」的本地选择态。
import { usePersonalStore } from "@cortex-work/core";
import type { RightPanelDescriptor } from "../personal/right-panel/types";

export const researchPanel = {
  id: "research",
  title: "深度研究",
  widthTier: "wide",
  canMaximize: false,
  usePresence: () =>
    usePersonalStore((s) => {
      const session = s.sessions.find((item) => item.id === s.activeSessionId);
      const refs = session?.researchSessions;
      return !!(session?.activeResearchSessionId ?? refs?.[refs.length - 1]?.sessionId);
    }),
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
