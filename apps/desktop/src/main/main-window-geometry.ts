import type { BrowserWindowConstructorOptions } from "electron";

// 默认宽度继续完整容纳个人工作区三栏；最小宽度只约束用户缩放下限，
// 窄窗下由渲染层既有的响应式布局负责收缩或隐藏辅助栏。
export const MAIN_WINDOW_DEFAULT_WIDTH = 1470;
export const MAIN_WINDOW_MIN_WIDTH = 960;

export function createMainWindowOptions({
  isMacOS,
  icon,
  preload,
}: {
  isMacOS: boolean;
  icon: BrowserWindowConstructorOptions["icon"];
  preload: string;
}): BrowserWindowConstructorOptions {
  return {
    width: MAIN_WINDOW_DEFAULT_WIDTH,
    height: 820,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 13 },
    show: false,
    autoHideMenuBar: true,
    backgroundColor: isMacOS ? "#00000000" : "#cfcbc1",
    ...(isMacOS
      ? {
          vibrancy: "sidebar" as const,
          // active:窗口失焦时仍保持磨砂(默认 followWindow 会在失焦时把材质褪为灰色平面),
          // 保证左侧菜单栏在任何焦点状态下都稳定透出壁纸。
          visualEffectState: "active" as const,
        }
      : {}),
    icon,
    webPreferences: {
      preload,
      sandbox: false,
      // 开启内嵌浏览器 <webview> 能力。webview 的安全靠 installBrowserWebviewGuards()
      // 的三道闸门兜底(强制安全 prefs + 导航/新窗口闸门),见 browser/webviewGuards.ts。
      webviewTag: true,
    },
  };
}
