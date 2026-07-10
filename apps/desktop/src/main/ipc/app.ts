// 应用级 locale 扇出:渲染端(主窗口 i18next 为权威源)切语言时下发主进程,
// 主进程做最终一致镜像 —— 广播给所有窗口(次级窗口据此同步)+ 重建托盘菜单。
// 原生 chrome(托盘等)无法用 react-i18next,只能从这里取归一化语言。

import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@cortex-work/core/i18n/native";
import { rebuildTrayMenu } from "../automation/tray";

// 主进程侧当前语言(最终一致镜像;主窗口 i18next 为权威源)。新建的次级窗口
// 用 getCurrentLocale() 初始化,避免冷启动语言不一致。
let currentLocale: Locale = DEFAULT_LOCALE;

export function getCurrentLocale(): Locale {
  return currentLocale;
}

// 广播到所有存活窗口(仿 automation/events.ts;窗口已关返回 [] 时静默丢弃)。
function broadcastLocale(locale: Locale): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("app:locale", locale);
  }
}

export function registerAppHandlers(): void {
  // 渲染端切语言 → 记录 + 广播 + 重建托盘菜单。非法值忽略(回退原语言)。
  ipcMain.handle("app:setLocale", (_e, locale: Locale): void => {
    if (!isLocale(locale) || locale === currentLocale) return;
    currentLocale = locale;
    broadcastLocale(locale);
    rebuildTrayMenu(locale);
  });

  // 渲染端切主题 → 同步 nativeTheme.themeSource。窗口外观(macOS 侧栏 vibrancy 材质、
  // 次级窗口的 prefers-color-scheme)跟随的是 nativeTheme 而非渲染端 data-theme,
  // 不同步时「应用暗、系统亮」会出现侧栏材质发白、深色文字不可读。非法值忽略。
  ipcMain.handle("app:setTheme", (_e, mode: "system" | "light" | "dark"): void => {
    if (mode !== "system" && mode !== "light" && mode !== "dark") return;
    nativeTheme.themeSource = mode;
  });
}
