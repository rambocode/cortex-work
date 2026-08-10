// 设置页与会话右栏共享同一份配置；设置页本身的标题已经包含在 Kun 对齐的三段式编辑器中，
// 这里不再叠加 Cortex 通用分区标题，避免顶部出现一层参考界面没有的信息层级。
import { SubagentsPanel } from "../subagents/SubagentsPanel";

export function SubagentSettingsSection() {
  return <SubagentsPanel variant="settings" />;
}
