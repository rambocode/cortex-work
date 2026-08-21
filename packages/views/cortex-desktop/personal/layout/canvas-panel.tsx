// canvas 面板的懒加载入口:画板与当前会话关联,无会话渲染空态引导（原 PersonalRightPanel
// 内联分支原样迁入）;会话态从 PanelHost 取 sessionId/workspaceRoot/收起回调。
import { Icon } from "@cortex-work/ui/icons";
import { usePanelHost } from "../right-panel/context";
import { PersonalWhiteboardPanel } from "./PersonalWhiteboardPanel";

export default function CanvasPanelEntry() {
  const host = usePanelHost();
  if (!host.activeSessionId) {
    return (
      <div className="pw-canvas-empty" role="status">
        <Icon.Palette size={30} />
        <strong>请先选择会话</strong>
        <span>画板与当前会话关联，选择或新建会话后即可使用。</span>
      </div>
    );
  }
  return (
    <PersonalWhiteboardPanel
      sessionId={host.activeSessionId}
      workspaceRoot={host.projectPath}
      onCollapse={host.close}
    />
  );
}
