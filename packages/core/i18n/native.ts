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
