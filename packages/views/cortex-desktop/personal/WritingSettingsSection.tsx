// 写作续写/改写(U3)设置分区：独立 OpenAI 兼容端点(baseUrl/apiKey/model)+ ghost text 打字续写开关。
// 数据走 usePersonalStore.writingLlmSettings（持久化分片，与 PersistedState.writingLlmSettings 镜像）。
// 未配置(baseUrl/model 任一空)时页面顶部提示「未配置」，主编辑器侧续写/改写入口据 writingLlmStatus 隐藏。

import { usePersonalStore } from "@cortex-work/core";
import { isWritingLlmConfigured } from "@cortex-work/core/desktop/types";
import { useTranslation } from "@cortex-work/core/i18n";

import { SettingCard, SwitchRow, SecretField } from "./settingsControls";

export function WritingSettingsSection() {
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.writingLlmSettings);
  const setSettings = usePersonalStore((s) => s.setWritingLlmSettings);
  const configured = isWritingLlmConfigured(settings);

  return (
    <div>
      <div className="pw-dlg-title">{t("writing.title")}</div>
      <div className="pw-dlg-desc">{t("writing.desc")}</div>

      <SettingCard title={t("writing.modelCard")}>
        {/* 配置态提示：未配置 → 续写/改写入口在编辑器侧全隐藏（此处点明原因，避免用户以为功能缺失）。 */}
        <div className="pw-srow-desc">
          {configured ? t("writing.configuredHint") : t("writing.notConfiguredHint")}
        </div>
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("writing.baseUrl")}</span>
          <input
            className="pw-set-input"
            value={settings.baseUrl}
            placeholder={t("writing.baseUrlPlaceholder")}
            spellCheck={false}
            onChange={(e) => setSettings({ baseUrl: e.target.value })}
          />
        </label>
        <SecretField
          label={t("writing.apiKey")}
          value={settings.apiKey}
          placeholder={t("writing.apiKeyPlaceholder")}
          onChange={(v) => setSettings({ apiKey: v })}
        />
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("writing.model")}</span>
          <input
            className="pw-set-input"
            value={settings.model}
            placeholder={t("writing.modelPlaceholder")}
            spellCheck={false}
            onChange={(e) => setSettings({ model: e.target.value })}
          />
        </label>
      </SettingCard>

      <SettingCard title={t("writing.completionCard")}>
        {/* ghost text 打字续写开关；Cmd-K 就地改写不受此开关影响（仅取决于是否配置）。 */}
        <SwitchRow
          label={t("writing.completionLabel")}
          desc={t("writing.completionDesc")}
          value={settings.completionEnabled}
          onChange={(v) => setSettings({ completionEnabled: v })}
        />
        {/* ⌘K 就地改写为纯说明(无开关):配置模型即可用,行为固定，此处只做能力说明。 */}
        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">{t("writing.inlineEditLabel")}</span>
            <span className="pw-srow-desc">{t("writing.inlineEditDesc")}</span>
          </div>
        </div>
      </SettingCard>
    </div>
  );
}
