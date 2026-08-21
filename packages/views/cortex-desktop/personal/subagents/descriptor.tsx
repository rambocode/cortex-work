// 子代理面板的右栏注册描述。自定义头（图标 + 标题 + 副标题）与 is-subagents 类名
// 是 CSS/测试契约;宽度 420 专档由 CSS :has(.pw-sa-panel) 负责。
import { Icon } from "@cortex-work/ui/icons";
import type { RightPanelDescriptor } from "../right-panel/types";

function SubagentsPanelHead() {
  return (
    <>
      <Icon.Bot size={17} />
      <span className="pw-col-head-title">子代理</span>
      <span className="pw-rp-head-subtitle">· 配置模型</span>
      <div className="spacer" />
    </>
  );
}

export const subagentsPanel = {
  id: "subagents",
  title: "子代理",
  icon: Icon.Bot,
  widthTier: "normal",
  canMaximize: false,
  rail: { order: 7 },
  renderHead: SubagentsPanelHead,
  headClassName: "is-subagents",
  load: () => import("./panel"),
} as const satisfies RightPanelDescriptor;
