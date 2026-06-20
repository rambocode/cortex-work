// 主进程可消费的纯字符串映射 —— 零 react / react-i18next 依赖(KTD7/KTD10)。
// Electron 主进程无法用 react-i18next;托盘等原生 chrome 从这里取串。
// 警告:本文件只能 import ./locales(纯常量),不得 import ./index / ./config / 任何 react。
//
// 主进程经 electron.vite.config.ts 的 externalizeDepsPlugin({ exclude: ['@cortex-work/core'] })
// 把本模块打包进 main chunk(R-i18n-2)。

import { DEFAULT_LOCALE, type Locale } from "./locales";

// 主进程 / preload 经本入口取 Locale 类型与归一化工具,避免依赖未导出的 ./locales
// 子路径(本文件仍是纯类型/常量,零 react)。
export { DEFAULT_LOCALE, isLocale } from "./locales";
export type { Locale } from "./locales";

export interface NativeTrayStrings {
  showMainWindow: string;
  quit: string;
}

const TRAY: Record<Locale, NativeTrayStrings> = {
  "zh-Hans": { showMainWindow: "显示主窗口", quit: "退出 Cortex" },
  en: { showMainWindow: "Show Main Window", quit: "Quit Cortex" },
};

export function trayStrings(locale: Locale): NativeTrayStrings {
  return TRAY[locale] ?? TRAY[DEFAULT_LOCALE];
}

// 注入 agent 系统提示词的语言指令(U4):让 agent 用当前 UI 语言回复。纯字符串(核心/主进程通用)。
// 须覆盖 LOCALES 全集;未知 locale 回退 DEFAULT_LOCALE 文案(防止 agent 静默拿不到语言指令)。
const LANGUAGE_INSTRUCTION: Record<Locale, string> = {
  "zh-Hans": "请始终用简体中文回复。",
  en: "Always respond in English.",
};

export function languageInstruction(locale: Locale): string {
  return LANGUAGE_INSTRUCTION[locale] ?? LANGUAGE_INSTRUCTION[DEFAULT_LOCALE];
}
