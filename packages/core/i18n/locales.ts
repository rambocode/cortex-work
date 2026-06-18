// 无框架 locale 常量层 —— 零依赖(不 import react / react-i18next / JSON)。
// 主进程(i18n/native.ts)与 react 绑定层(config.ts/index.ts)都从这里取类型,
// 保证主进程不会传递性拉入 React(KTD7/KTD10)。

export const LOCALES = ["zh-Hans", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh-Hans";
export const DEFAULT_NS = "common";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
