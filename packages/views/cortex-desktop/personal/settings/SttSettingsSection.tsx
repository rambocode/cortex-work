// 语音转文字（STT/ASR）设置分区。
// 结构：总开关 → 供应商选择 → 本地 Whisper 面板（含下载源+模型卡片）
//       / 已配置供应商提示 / 自定义 API 表单 → 识别语言 → 高级（timeoutMs）。
//
// 供应商选择映射：
//   protocol='local-whisper'  → 选项值 '__local__'（内部占位）
//   providerId='custom'       → 选项值 'custom'
//   其余 providerId           → 已配置供应商 id
//
// 本地 Whisper 面板（下载源/模型/进度）拆至 SttLocalWhisperPanel.tsx，
// 防止本文件超过 1200 行（KTD5 约束）。

import { useMemo } from "react";
import { usePersonalStore, type ProviderProfile } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type { AsrProtocol, LocalWhisperDownloadSource } from "@cortex-work/core/desktop/media-gen-types";
import type { LocalWhisperModelId } from "@cortex-work/core/whisper/models";

import { BareSelect, SecretField, SettingCard, SRow, SwitchRow } from "./settingsControls";
import { SttLocalWhisperPanel } from "./SttLocalWhisperPanel";

// ── 常量 ──────────────────────────────────────────────────────────────────────

// 本地 Whisper 的虚拟供应商选项值（不是真实 providerId，只在 UI 内部用）
const LOCAL_WHISPER_OPTION = "__local__";
const CUSTOM_OPTION = "custom";

// 自定义协议选项（不含 local-whisper，后者由 LOCAL_WHISPER_OPTION 单独走）
const CUSTOM_ASR_PROTOCOLS: AsrProtocol[] = ["openai-transcriptions", "mimo-asr"];

// 语言选项：auto = 自动检测（默认）
const LANGUAGE_OPTIONS = ["auto", "zh", "en", "ja", "ko"] as const;

// ── 辅助 ──────────────────────────────────────────────────────────────────────

function asrProtocolLabel(t: (k: string) => string, protocol: AsrProtocol): string {
  if (protocol === "mimo-asr") return t("stt.protocolMimoAsr");
  return t("stt.protocolOpenAi");
}

function languageLabel(t: (k: string) => string, lang: string): string {
  switch (lang) {
    case "auto": return t("stt.langAuto");
    case "zh":   return t("stt.langZh");
    case "en":   return t("stt.langEn");
    case "ja":   return t("stt.langJa");
    case "ko":   return t("stt.langKo");
    default:     return lang;
  }
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export function SttSettingsSection() {
  const { t } = useTranslation("settings");

  const asr = usePersonalStore((s) => s.asrSettings);
  const setAsrSettings = usePersonalStore((s) => s.setAsrSettings);
  // 取全部 providers（不在 selector 内 filter，避免每次返回新数组导致 Zustand 无限循环）
  const allProviders = usePersonalStore((s) => s.providerSettings?.providers);
  const providers: ProviderProfile[] = useMemo(
    () => allProviders?.filter((p) => p.enabled) ?? [],
    [allProviders],
  );

  // ── 当前供应商模式推断 ────────────────────────────────────────────────────

  // 本地 Whisper：protocol 为 local-whisper
  const usingLocalWhisper = asr.protocol === "local-whisper";

  // 自定义：providerId 为空字符串或 'custom'，且不是本地 Whisper
  const usingCustom =
    !usingLocalWhisper && (!asr.providerId || asr.providerId === CUSTOM_OPTION);

  // 已配置供应商
  const selectedProvider =
    !usingLocalWhisper && !usingCustom
      ? providers.find((p) => p.id === asr.providerId)
      : undefined;

  // 供应商下拉当前值
  const providerSelectValue = usingLocalWhisper
    ? LOCAL_WHISPER_OPTION
    : usingCustom
      ? CUSTOM_OPTION
      : asr.providerId;

  // ── 供应商下拉选项 ────────────────────────────────────────────────────────
  // 始终有本地 Whisper + 自定义；已配置 providers 在中间（无则隐藏该分组）
  const providerOptions = [
    { label: t("stt.providerLocalWhisper"), value: LOCAL_WHISPER_OPTION },
    ...providers.map((p) => ({ label: p.name, value: p.id })),
    { label: t("stt.providerCustom"), value: CUSTOM_OPTION },
  ];

  // ── 事件处理 ──────────────────────────────────────────────────────────────

  const handleProviderChange = (value: string): void => {
    if (value === LOCAL_WHISPER_OPTION) {
      // 切本地 Whisper：协议固定为 local-whisper，清空 baseUrl/apiKey
      setAsrSettings({
        protocol: "local-whisper",
        providerId: "",
        baseUrl: "",
        apiKey: "",
        model: asr.model || "whisper-small-q5_1",
      });
    } else if (value === CUSTOM_OPTION) {
      // 切自定义：保留已填的 baseUrl/apiKey/model，协议回落为 openai-transcriptions
      setAsrSettings({
        protocol: asr.protocol === "local-whisper" ? "openai-transcriptions" : asr.protocol,
        providerId: CUSTOM_OPTION,
      });
    } else {
      // 切已配置供应商：清空 baseUrl/apiKey，协议 = openai-transcriptions（云端供应商默认）
      setAsrSettings({
        providerId: value,
        protocol: "openai-transcriptions",
        baseUrl: "",
        apiKey: "",
      });
    }
  };

  return (
    <>
      {/* 总开关 */}
      <SettingCard title={t("stt.title")}>
        <SwitchRow
          label={t("stt.enableLabel")}
          desc={t("stt.enableDesc")}
          value={asr.enabled}
          onChange={(v) => setAsrSettings({ enabled: v })}
        />
      </SettingCard>

      {/* 关闭时隐藏所有详细配置 */}
      {asr.enabled ? (
        <>
          {/* 供应商选择 */}
          <SettingCard title={t("stt.providerCard")}>
            <SRow label={t("stt.providerLabel")} desc={t("stt.providerDesc")} end>
              <BareSelect
                value={providerSelectValue}
                options={providerOptions}
                onChange={handleProviderChange}
              />
            </SRow>

            {/* 已配置供应商：显示「使用 X 密钥」提示，不回填、不泄露 */}
            {selectedProvider ? (
              <div className="pw-srow-desc">
                {t("stt.providerKeyHint", { name: selectedProvider.name })}
              </div>
            ) : null}

            {/* 自定义 API 表单 */}
            {usingCustom ? (
              <>
                <SRow label={t("stt.protocolLabel")} end>
                  <BareSelect
                    value={asr.protocol === "local-whisper" ? "openai-transcriptions" : asr.protocol}
                    options={CUSTOM_ASR_PROTOCOLS.map((p) => ({
                      label: asrProtocolLabel(t, p),
                      value: p,
                    }))}
                    onChange={(v) => setAsrSettings({ protocol: v as AsrProtocol })}
                  />
                </SRow>
                <div className="pw-sblock">
                  <SRow label={t("stt.baseUrlLabel")} end>
                    <input
                      className="pw-set-input"
                      type="url"
                      value={asr.baseUrl}
                      placeholder={t("stt.baseUrlPlaceholder")}
                      onChange={(e) => setAsrSettings({ baseUrl: e.target.value })}
                    />
                  </SRow>
                  <SecretField
                    label={t("stt.apiKeyLabel")}
                    value={asr.apiKey}
                    onChange={(v) => setAsrSettings({ apiKey: v })}
                    placeholder={t("stt.apiKeyPlaceholder")}
                  />
                  <SRow label={t("stt.modelLabel")} end>
                    <input
                      className="pw-set-input"
                      type="text"
                      value={asr.model}
                      placeholder={t("stt.modelPlaceholder")}
                      onChange={(e) => setAsrSettings({ model: e.target.value })}
                    />
                  </SRow>
                </div>
              </>
            ) : null}

            {/* 已配置供应商：展示可选的模型字段（供应商自带 key） */}
            {selectedProvider ? (
              <SRow label={t("stt.modelLabel")} end>
                <input
                  className="pw-set-input"
                  type="text"
                  value={asr.model}
                  placeholder={t("stt.modelPlaceholder")}
                  onChange={(e) => setAsrSettings({ model: e.target.value })}
                />
              </SRow>
            ) : null}
          </SettingCard>

          {/* 本地 Whisper 面板（拆到子组件，防止本文件超行） */}
          {usingLocalWhisper ? (
            <SttLocalWhisperPanel
              selectedModelId={asr.model || "whisper-small-q5_1"}
              sourceId={(asr.localWhisperDownloadSource as LocalWhisperDownloadSource | undefined) ?? "huggingface"}
              onSourceChange={(src) => setAsrSettings({ localWhisperDownloadSource: src })}
              onModelSelect={(modelId: LocalWhisperModelId) => setAsrSettings({ model: modelId })}
            />
          ) : null}

          {/* 识别语言（所有模式共用） */}
          <SettingCard title={t("stt.languageCard")}>
            <SRow label={t("stt.languageLabel")} desc={t("stt.languageDesc")} end>
              <BareSelect
                value={asr.language || "auto"}
                options={LANGUAGE_OPTIONS.map((lang) => ({
                  label: languageLabel(t, lang),
                  value: lang,
                }))}
                onChange={(v) => setAsrSettings({ language: v })}
              />
            </SRow>
          </SettingCard>

          {/* 高级：超时设置 */}
          <SettingCard title={t("stt.advancedCard")}>
            <SRow label={t("stt.timeoutLabel")} desc={t("stt.timeoutDesc")} end>
              <input
                className="pw-set-input pw-set-input-short"
                type="number"
                min={5000}
                max={600_000}
                step={5000}
                value={asr.timeoutMs}
                onChange={(e) => setAsrSettings({ timeoutMs: Number(e.target.value) })}
              />
            </SRow>
          </SettingCard>
        </>
      ) : null}
    </>
  );
}
