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

import { useMemo } from "react";
import { usePersonalStore } from "@cortex-work/core";
import {
  isWritingLlmConfigured,
  clampWritingDebounceMs,
  clampWritingMaxTokens,
  WRITING_LLM_MAX_TOKENS_MAX,
  WRITING_LLM_MAX_TOKENS_MIN,
} from "@cortex-work/core/desktop/types";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useTranslation } from "@cortex-work/core/i18n";

import { SettingCard, SwitchRow, SecretField, BareSelect } from "./settingsControls";
import { WritingQuickActionsEditor } from "./WritingQuickActionsEditor";
import { WritingTypographySection } from "./WritingTypographySection";
import { WritingDebugLogSection } from "./WritingDebugLogSection";

// 去抖候选(对齐 Kun 的离散档位)。
const DEBOUNCE_OPTIONS = [300, 650, 1000, 1500] as const;

export function WritingSettingsSection() {
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.writingLlmSettings);
  const setSettings = usePersonalStore((s) => s.setWritingLlmSettings);
  // 已配置且启用的供应商(provider 注册表):用于「从已配置供应商填充」端点候选。
  // 注意:selector 直选原始数组(稳定引用),过滤放 useMemo,否则每渲染新数组会触发无限更新。
  const allProviders = usePersonalStore((s) => s.providerSettings.providers);
  const providers = useMemo(
    () => allProviders.filter((p) => p.enabled && p.baseUrl.trim()),
    [allProviders],
  );
  // 检索开关的单一真源(WritingUiState 分片,跨空间共享;设置节为唯一入口)。
  const retrievalEnabled = useWritingSpacesStore((s) => s.retrievalEnabled);
  const setRetrievalEnabled = useWritingSpacesStore((s) => s.setRetrievalEnabled);
  const configured = isWritingLlmConfigured(settings);

  // 「从已配置供应商填充」:选中某供应商 → 把其 baseUrl/apiKey/首个模型填进续写端点(快照式,
  // cortex 续写为独立端点、无 Kun 的 live 继承,故做成快速填充候选;端点仍以下方输入为真源)。
  const fillFromProvider = (id: string): void => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    setSettings({
      baseUrl: p.baseUrl ?? "",
      apiKey: p.apiKey ?? "",
      model: p.models?.[0]?.id ?? settings.model,
    });
  };

  return (
    <div>
      <div className="pw-dlg-title">{t("writing.title")}</div>
      <div className="pw-dlg-desc">{t("writing.desc")}</div>

      {/* 排版与字体(对齐 Kun,置于写作建议前)。 */}
      <WritingTypographySection />

      <SettingCard title={t("writing.modelCard")}>
        {/* 配置态提示：未配置 → 续写/改写入口在编辑器侧全隐藏（此处点明原因，避免用户以为功能缺失）。 */}
        <div className="pw-srow-desc">
          {configured ? t("writing.configuredHint") : t("writing.notConfiguredHint")}
        </div>
        {/* 从已配置供应商快速填充端点(候选);选后仍以下方输入为真源。无供应商则不显。 */}
        {providers.length > 0 ? (
          <div className="pw-srow">
            <div className="pw-srow-l">
              <span className="pw-srow-lbl">{t("writing.providerFillLabel")}</span>
            </div>
            <BareSelect
              value=""
              onChange={(v) => v && fillFromProvider(v)}
              options={[
                { label: t("writing.providerFillCustom"), value: "" },
                ...providers.map((p) => ({ label: p.name || p.id, value: p.id })),
              ]}
            />
          </div>
        ) : null}
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

        {/* 高级调优(可折叠,对齐 Kun):去抖(真接进 ghost-text)+ 短建议最大长度(传主进程 max_tokens)。 */}
        <details className="pw-wty-advanced">
          <summary>{t("writing.advancedTitle")}</summary>
          <div className="pw-srow-desc">{t("writing.advancedDesc")}</div>
          <div className="pw-srow">
            <div className="pw-srow-l">
              <span className="pw-srow-lbl">{t("writing.debounceLabel")}</span>
              <span className="pw-srow-desc">{t("writing.debounceDesc")}</span>
            </div>
            <BareSelect
              value={String(clampWritingDebounceMs(settings.debounceMs))}
              onChange={(v) => setSettings({ debounceMs: clampWritingDebounceMs(Number(v)) })}
              options={DEBOUNCE_OPTIONS.map((ms) => ({
                label: t(
                  ms === 300
                    ? "writing.debounceFast"
                    : ms === 650
                      ? "writing.debounceBalanced"
                      : ms === 1000
                        ? "writing.debounceRelaxed"
                        : "writing.debounceQuiet",
                ),
                value: String(ms),
              }))}
            />
          </div>
          <div className="pw-srow">
            <div className="pw-srow-l">
              <span className="pw-srow-lbl">{t("writing.maxTokensLabel")}</span>
              <span className="pw-srow-desc">{t("writing.maxTokensDesc")}</span>
            </div>
            <input
              type="number"
              className="pw-set-input pw-wty-num"
              min={WRITING_LLM_MAX_TOKENS_MIN}
              max={WRITING_LLM_MAX_TOKENS_MAX}
              step={8}
              value={clampWritingMaxTokens(settings.maxTokens)}
              aria-label={t("writing.maxTokensLabel")}
              onChange={(e) => setSettings({ maxTokens: clampWritingMaxTokens(Number(e.target.value)) })}
            />
          </div>
        </details>
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

      {/* 写作日志(对齐 Kun):最近续写/改写调用记录,排障用。无桌面能力时不渲染。 */}
      <WritingDebugLogSection />
    </div>
  );
}
