// 内嵌浏览器面板的右栏注册描述。宽度档由 CSS :has(.pw-browser) 的 3/7 专档负责,
// JS 侧 widthTier 取 normal（拖拽保留 488,与旧 reservedWidthForView 行为一致）。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

export const browserPanel = {
  id: "browser",
  title: "浏览器",
  icon: Icon.Globe,
  widthTier: "normal",
  canMaximize: false,
  rail: { order: 5 },
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
