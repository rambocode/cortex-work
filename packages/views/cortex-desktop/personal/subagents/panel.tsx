// subagents 面板的懒加载入口（设置页另有饿加载复用入口 SubagentSettingsSection,
// 故本面板实际仍在主 chunk;保留 lazy 形状使合同统一,设置页若改懒加载即自动受益）。
import { SubagentsPanel } from "./SubagentsPanel";

export default function SubagentsPanelEntry() {
  return <SubagentsPanel />;
}
