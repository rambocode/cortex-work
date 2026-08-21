// 闪记面板的右栏注册描述。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

export const notesPanel = {
  id: "notes",
  title: "闪记",
  icon: Icon.Pin,
  widthTier: "normal",
  canMaximize: true,
  rail: { order: 4 },
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
