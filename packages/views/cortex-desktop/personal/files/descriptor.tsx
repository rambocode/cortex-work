// 文件面板的右栏注册描述。widthTier=wide:文件预览态是与产物同款的展宽面板;
// canMaximize:全部面板统一开放放大/还原（2026-08 用户反馈:头部只剩「×」找不到展开入口）。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

export const filesPanel = {
  id: "files",
  title: "文件",
  icon: Icon.Folder,
  widthTier: "wide",
  canMaximize: true,
  rail: { order: 1 },
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
