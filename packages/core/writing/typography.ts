// 写作排版(字体/字号/行距)数据模型(移植自 Kun app-settings-write 的 typography 段)。
// 存储在 WritingUiState(spaces store,跨空间共享);字号 fontSizePx 与中栏工具栏步进共用同一状态源。
// 字体预设 → 具体 CSS font-family 栈(每条以通用族收尾并串接中文回退,主字缺失也能渲染合理中文字体)。
import type { WritingFontPreset } from "../desktop/writing-types";
// 便于 views 经本子路径直接取用类型(core 主入口未导出 writing-types)。
export type { WritingFontPreset } from "../desktop/writing-types";

export const WRITING_FONT_PRESETS: readonly WritingFontPreset[] = [
  "system",
  "sourceHanSans",
  "yahei",
  "pingfang",
  "simhei",
  "simsun",
  "kaiti",
  "custom",
] as const;

export const DEFAULT_WRITING_FONT_PRESET: WritingFontPreset = "system";

// 行距(无单位)范围与默认(照 Kun WRITE_EDITOR_LINE_HEIGHT_*)。
export const WRITING_LINE_HEIGHT_MIN = 1.4;
export const WRITING_LINE_HEIGHT_MAX = 2.2;
export const WRITING_LINE_HEIGHT_DEFAULT = 1.75;

// 预设 → CSS font-family 栈(逐字移植 Kun WRITE_FONT_STACKS)。
const WRITING_FONT_STACKS: Record<Exclude<WritingFontPreset, "custom">, string> = {
  system:
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', sans-serif",
  sourceHanSans: "'Source Han Sans SC', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  yahei: "'Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Noto Sans SC', sans-serif",
  pingfang: "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', sans-serif",
  simhei: "'SimHei', '黑体', 'PingFang SC', 'Noto Sans SC', sans-serif",
  simsun: "'SimSun', '宋体', 'Songti SC', serif",
  kaiti: "'KaiTi', '楷体', 'STKaiti', 'Songti SC', serif",
};

// 把预设解析成可直接用的 CSS font-family;custom 用用户填的 customFontFamily(空则回落 system)。
export function writingFontStackFor(preset: WritingFontPreset, customFontFamily: string): string {
  if (preset === "custom") {
    const trimmed = customFontFamily.trim();
    return trimmed || WRITING_FONT_STACKS.system;
  }
  return WRITING_FONT_STACKS[preset] ?? WRITING_FONT_STACKS.system;
}

// 行距夹取到 [MIN, MAX] 并 snap 到 1 位小数(滑杆产生干净值);非数值回落默认。
export function clampWritingLineHeight(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WRITING_LINE_HEIGHT_DEFAULT;
  const clamped = Math.max(WRITING_LINE_HEIGHT_MIN, Math.min(WRITING_LINE_HEIGHT_MAX, value));
  return Math.round(clamped * 10) / 10;
}

// 预设合法性回落(旧档脏值 → system)。
export function normalizeWritingFontPreset(value: unknown): WritingFontPreset {
  return typeof value === "string" && (WRITING_FONT_PRESETS as readonly string[]).includes(value)
    ? (value as WritingFontPreset)
    : DEFAULT_WRITING_FONT_PRESET;
}
