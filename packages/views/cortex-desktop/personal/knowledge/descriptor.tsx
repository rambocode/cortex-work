// 知识库文档预览面板的右栏注册描述。无 rail 入口:点会话正文里的 kb:// 引用打开。
// widthTier=wide:文档常含宽表格,窄栏里每列会被压成一列一个字。
import type { RightPanelDescriptor } from "../right-panel/types";

export const knowledgePanel = {
  id: "knowledge",
  title: "知识库文档",
  widthTier: "wide",
  canMaximize: true,
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
