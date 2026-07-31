// 写作设置分区(对齐 Kun 写作设置形态,按 cortex 现有能力裁剪):
//   - 续写模型(providerId/modelId):阶段③收编后走统一 Model Gateway,与全局模型选择器同一份
//     Catalog 候选(认证可用 ∧ 未隐藏);写作侧不再持有 baseUrl/apiKey,明文密钥落盘点随之消失。
//   - 写作建议:「输入停顿时显示建议」(ghost text 续写开关)+「参考其他文档」(工作区检索开关)+ ⌘K 就地改写说明。
//   - 信息图与图片生成:图片模型不在此重复配置,指向「媒体生成 → 图片生成」节(单一真源,避免第二份冲突配置)。
// 数据双分片:
//   - writingLlmSettings(usePersonalStore,与 PersistedState.writingLlmSettings 镜像)——模型引用 + 续写开关
//     与写作独有的调优(debounceMs/maxTokens);「用哪个模型」归并到 Catalog,「怎么用」留在这里;
//   - retrievalEnabled(useWritingSpacesStore,WritingUiState 分片,跨空间共享)——检索开关的单一真源
//     (助手面板 composer 里也有同一状态的快捷开关,二者读写同一 store,无双状态漂移)。
// Kun 有而 cortex 无对应能力、故本节未做的字段(排版预设/行距、快捷指令编辑器、写作 Agent 人设、
//   补全去抖/接受分/长度调优、provider 继承)见交付说明,均因缺底层能力而不做,不造空壳。

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

import { SettingCard, SwitchRow, BareSelect } from "./settingsControls";
import { ModelRefField } from "./provider/ModelRefField";
import { WritingQuickActionsEditor } from "./WritingQuickActionsEditor";
import { WritingTypographySection } from "./WritingTypographySection";
import { WritingDebugLogSection } from "./WritingDebugLogSection";

// 去抖候选(对齐 Kun 的离散档位)。
const DEBOUNCE_OPTIONS = [300, 650, 1000, 1500] as const;

export function WritingSettingsSection() {
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.writingLlmSettings);
  const setSettings = usePersonalStore((s) => s.setWritingLlmSettings);
  // 检索开关的单一真源(WritingUiState 分片,跨空间共享;设置节为唯一入口)。
  const retrievalEnabled = useWritingSpacesStore((s) => s.retrievalEnabled);
  const setRetrievalEnabled = useWritingSpacesStore((s) => s.setRetrievalEnabled);
  const configured = isWritingLlmConfigured(settings);

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
        {/* 模型引用与全局模型选择器同一份候选（认证可用 ∧ 未隐藏），能力徽标只读。
            引用悬空（模型下线 / Provider 未登录）时进阻断态并要求重选，不自动回退（计划 §5）。 */}
        <ModelRefField
          label={t("writing.model")}
          value={
            settings.providerId && settings.modelId
              ? { providerId: settings.providerId, modelId: settings.modelId }
              : undefined
          }
          onChange={(ref) => setSettings({ providerId: ref.providerId, modelId: ref.modelId })}
        />

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
