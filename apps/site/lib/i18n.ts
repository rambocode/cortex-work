// 站点支持的语言：默认中文，路由分段 /zh /en。
export const locales = ["zh", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "zh";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

// 给定当前语言，返回切到「另一种」语言（双语场景下的语言开关目标）。
export function otherLocale(locale: Locale): Locale {
  return locale === "zh" ? "en" : "zh";
}

export const localeLabel: Record<Locale, string> = {
  zh: "中文",
  en: "EN",
};
