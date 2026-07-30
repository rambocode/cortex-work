// 写作「排版与字体」设置卡(对齐 Kun typography):字体预设下拉(含 custom)+ 字号滑杆 + 行距滑杆 + 重置。
// 真正生效:字号/字体/行距经 spaces store → WritingWorkspace 的中栏 CSS 变量(--pw-writing-font-*)作用于四档。
// 字号与顶栏步进共用同一状态源(fontSizePx),此处滑杆只是另一入口,不造第二份状态。
import { useTranslation } from "@cortex-work/core/i18n";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import {
  WRITING_FONT_PRESETS,
  WRITING_LINE_HEIGHT_MAX,
  WRITING_LINE_HEIGHT_MIN,
} from "@cortex-work/core/writing/typography";
import {
  WRITING_FONT_SIZE_MAX,
  WRITING_FONT_SIZE_MIN,
} from "@cortex-work/core/writing/spaces";
import type { WritingFontPreset } from "@cortex-work/core/writing/typography";

import { SettingCard } from "./settingsControls";

// 预设 → i18n label key。
const PRESET_LABEL_KEY: Record<WritingFontPreset, string> = {
  system: "writing.fontSystem",
  sourceHanSans: "writing.fontSourceHanSans",
  yahei: "writing.fontYahei",
  pingfang: "writing.fontPingfang",
  simhei: "writing.fontSimhei",
  simsun: "writing.fontSimsun",
  kaiti: "writing.fontKaiti",
  custom: "writing.fontCustom",
} as const;

export function WritingTypographySection() {
  const { t } = useTranslation("settings");
  const fontPreset = useWritingSpacesStore((s) => s.fontPreset);
  const customFontFamily = useWritingSpacesStore((s) => s.customFontFamily);
  const fontSizePx = useWritingSpacesStore((s) => s.fontSizePx);
  const lineHeight = useWritingSpacesStore((s) => s.lineHeight);
  const setFontPreset = useWritingSpacesStore((s) => s.setFontPreset);
  const setCustomFontFamily = useWritingSpacesStore((s) => s.setCustomFontFamily);
  const setFontSizePx = useWritingSpacesStore((s) => s.setFontSizePx);
  const setLineHeight = useWritingSpacesStore((s) => s.setLineHeight);
  const resetTypography = useWritingSpacesStore((s) => s.resetTypography);

  return (
    <SettingCard title={t("writing.typographyCard")}>
      {/* 编辑器字体 */}
      <div className="pw-srow">
        <div className="pw-srow-l">
          <span className="pw-srow-lbl">{t("writing.fontPresetLabel")}</span>
          <span className="pw-srow-desc">{t("writing.fontPresetDesc")}</span>
        </div>
        <select
          className="pw-set-input pw-wty-select"
          aria-label={t("writing.fontPresetLabel")}
          value={fontPreset}
          onChange={(e) => setFontPreset(e.target.value as WritingFontPreset)}
        >
          {WRITING_FONT_PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(PRESET_LABEL_KEY[p])}
            </option>
          ))}
        </select>
      </div>
      {fontPreset === "custom" ? (
        <input
          className="pw-set-input"
          value={customFontFamily}
          placeholder={t("writing.fontCustomPlaceholder")}
          spellCheck={false}
          aria-label={t("writing.fontCustom")}
          onChange={(e) => setCustomFontFamily(e.target.value)}
        />
      ) : null}

      {/* 字号(滑杆,与顶栏步进同源) */}
      <div className="pw-srow">
        <div className="pw-srow-l">
          <span className="pw-srow-lbl">{t("writing.fontSizeLabel")}</span>
          <span className="pw-srow-desc">{t("writing.fontSizeDesc")}</span>
        </div>
        <div className="pw-wty-slider">
          <input
            type="range"
            aria-label={t("writing.fontSizeLabel")}
            min={WRITING_FONT_SIZE_MIN}
            max={WRITING_FONT_SIZE_MAX}
            step={1}
            value={fontSizePx}
            onChange={(e) => setFontSizePx(Number(e.target.value))}
          />
          <span className="pw-wty-val">{fontSizePx}px</span>
        </div>
      </div>

      {/* 行距(滑杆) */}
      <div className="pw-srow">
        <div className="pw-srow-l">
          <span className="pw-srow-lbl">{t("writing.lineHeightLabel")}</span>
          <span className="pw-srow-desc">{t("writing.lineHeightDesc")}</span>
        </div>
        <div className="pw-wty-slider">
          <input
            type="range"
            aria-label={t("writing.lineHeightLabel")}
            min={WRITING_LINE_HEIGHT_MIN}
            max={WRITING_LINE_HEIGHT_MAX}
            step={0.05}
            value={lineHeight}
            onChange={(e) => setLineHeight(Number(e.target.value))}
          />
          <span className="pw-wty-val">{lineHeight.toFixed(2)}</span>
        </div>
      </div>

      {/* 重置排版 */}
      <div className="pw-srow">
        <div className="pw-srow-l">
          <span className="pw-srow-lbl">{t("writing.typographyReset")}</span>
          <span className="pw-srow-desc">{t("writing.typographyResetDesc")}</span>
        </div>
        <button type="button" className="pw-ftb-btn" onClick={resetTypography}>
          {t("writing.typographyReset")}
        </button>
      </div>
    </SettingCard>
  );
}
