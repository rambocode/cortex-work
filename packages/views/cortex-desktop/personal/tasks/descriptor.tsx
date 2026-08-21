// Tasks 面板的右栏注册描述（id 沿用历史值 "todos",与 store rightView/请求载荷键一致）。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

export const todosPanel = {
  id: "todos",
  title: "Tasks",
  icon: Icon.Task,
  widthTier: "normal",
  canMaximize: false,
  rail: { order: 3 },
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
