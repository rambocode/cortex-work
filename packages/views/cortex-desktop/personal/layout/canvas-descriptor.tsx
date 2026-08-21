// 会话白板（画板）面板的右栏注册描述。headMode="none":画布自带工具栏,整行头部不渲染。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

export const canvasPanel = {
  id: "canvas",
  title: "画板",
  icon: Icon.Palette,
  widthTier: "wide",
  canMaximize: true,
  headMode: "none",
  rail: { order: 6 },
  load: () => import("./canvas-panel"),
} as const satisfies RightPanelDescriptor;
