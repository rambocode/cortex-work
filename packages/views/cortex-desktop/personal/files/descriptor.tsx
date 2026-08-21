// 文件面板的右栏注册描述。widthTier=wide:文件预览态是与产物同款的展宽面板;
// canMaximize="filePreview":列表态放大没有意义,预览态才开放（数据令牌,宿主判定）。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

export const filesPanel = {
  id: "files",
  title: "文件",
  icon: Icon.Folder,
  widthTier: "wide",
  canMaximize: "filePreview",
  rail: { order: 1 },
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
