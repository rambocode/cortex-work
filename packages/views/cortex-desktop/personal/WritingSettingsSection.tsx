// 写作设置分区(对齐 Kun 写作设置形态,按 cortex 现有能力裁剪):
//   - 续写模型端点(baseUrl/apiKey/model):cortex 走独立 OpenAI 兼容端点直连,无 Kun 的 provider 继承概念,故保留直连字段。
//   - 写作建议:「输入停顿时显示建议」(ghost text 续写开关)+「参考其他文档」(工作区检索开关)+ ⌘K 就地改写说明。
//   - 信息图与图片生成:图片模型不在此重复配置,指向「媒体生成 → 图片生成」节(单一真源,避免第二份冲突配置)。
// 数据双分片:
//   - writingLlmSettings(usePersonalStore,与 PersistedState.writingLlmSettings 镜像)——续写端点 + 续写开关;
//   - retrievalEnabled(useWritingSpacesStore,WritingUiState 分片,跨空间共享)——检索开关的单一真源
//     (助手面板 composer 里也有同一状态的快捷开关,二者读写同一 store,无双状态漂移)。
// Kun 有而 cortex 无对应能力、故本节未做的字段(排版预设/行距、快捷指令编辑器、写作 Agent 人设、
//   补全去抖/接受分/长度调优、provider 继承)见交付说明,均因缺底层能力而不做,不造空壳。

import { usePersonalStore } from "@cortex-work/core";
import { isWritingLlmConfigured } from "@cortex-work/core/desktop/types";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useTranslation } from "@cortex-work/core/i18n";

import { SettingCard, SwitchRow, SecretField } from "./settingsControls";
import { WritingQuickActionsEditor } from "./WritingQuickActionsEditor";

export function WritingSettingsSection() {
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.writingLlmSettings);
  const setSettings = usePersonalStore((s) => s.setWritingLlmSettings);
  // 检索开关的单一真源(WritingUiState 分片,跨空间共享;助手面板同读此状态)。
  const retrievalEnabled = useWritingSpacesStore((s) => s.retrievalEnabled);
  const setRetrievalEnabled = useWritingSpacesStore((s) => s.setRetrievalEnabled);
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
        {/* 检索开关(对齐 Kun「参考其他文档」)：与助手面板 composer 里的快捷开关同一状态源。 */}
        <SwitchRow
          label={t("writing.retrievalLabel")}
          desc={t("writing.retrievalDesc")}
          value={retrievalEnabled}
          onChange={(v) => setRetrievalEnabled(v)}
        />
        {/* ⌘K 就地改写为纯说明(无开关):配置模型即可用,行为固定，此处只做能力说明。 */}
        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-lbl">{t("writing.inlineEditLabel")}</span>
            <span className="pw-srow-desc">{t("writing.inlineEditDesc")}</span>
          </div>
        </div>
      </SettingCard>

      {/* 选中工具栏 / 快捷指令(对齐 Kun):内置 + 自定义,助手空态卡与选区动作读它。 */}
      <WritingQuickActionsEditor />

      {/* 信息图/图片生成不在此重复配置,指向「媒体生成 → 图片生成」节(单一真源)。 */}
      <SettingCard title={t("writing.imageGenCard")}>
        <div className="pw-srow-desc">{t("writing.imageGenNote")}</div>
      </SettingCard>
    </div>
  );
}
