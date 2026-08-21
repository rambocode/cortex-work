// skills 面板的懒加载入口。bare:面板内不再重复渲染自己的头部行（宿主统一渲染）。
import { usePanelHost } from "../right-panel/context";
import { PromptPanel } from "./PromptPanel";

export default function SkillsPanelEntry() {
  const host = usePanelHost();
  return <PromptPanel onToast={host.toast} bare />;
}
