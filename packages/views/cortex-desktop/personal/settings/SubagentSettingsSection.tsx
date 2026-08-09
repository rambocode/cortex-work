// 设置页与会话右栏复用同一个子代理编辑器，确保运行上限、角色启用状态和模型覆盖不会
// 因两个入口各自维护表单而漂移。此壳只负责设置页的信息层级与本地化标题。

import { useTranslation } from "@cortex-work/core/i18n";
import { SubagentsPanel } from "../subagents/SubagentsPanel";

export function SubagentSettingsSection() {
  const { t } = useTranslation("settings");
  return (
    <>
      <div className="pw-dlg-title">{t("subagents.title")}</div>
      <div className="pw-dlg-desc">{t("subagents.desc")}</div>
      <SubagentsPanel variant="settings" />
    </>
  );
}
