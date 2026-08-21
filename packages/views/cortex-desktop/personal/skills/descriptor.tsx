// Skills 面板（Prompt 库）的右栏注册描述。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

export const skillsPanel = {
  id: "skills",
  title: "Skills",
  icon: Icon.Sparkle,
  widthTier: "normal",
  canMaximize: true,
  rail: { order: 2 },
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
