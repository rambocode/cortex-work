import { Menu, type MenuItemConstructorOptions } from "electron";

/**
 * 安装应用主菜单。
 *
 * 修复「View 菜单出现两个 Toggle Full Screen」:此前未自定义 application menu,
 * Electron 默认菜单的 View 用 role:'viewMenu',内含 role:'togglefullscreen'(macOS
 * 快捷键 ^⌘F);而 macOS 13+ 又会自动向标准 View 菜单注入系统级「Enter Full Screen」
 * (🌐F)——两者叠加,View 里就出现两个全屏项。
 *
 * 这里改为自定义菜单:macOS 上 View 子菜单**省略** togglefullscreen,把唯一的全屏项
 * 交给系统自动注入;非 macOS 无系统注入,保留 togglefullscreen 以免丢失全屏入口。
 * 其余项沿用 Electron role(自动本地化 label + 平台正确快捷键)。
 *
 * 注意:必须在创建主窗口前调用,确保菜单在首帧前就位。
 */
export function installAppMenu(): void {
  const isMac = process.platform === "darwin";

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    { role: "toggleDevTools" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    // macOS:全屏项由系统自动注入,这里不放 togglefullscreen,否则重复;
    // 其它平台无系统注入,需自行保留全屏入口。
    ...(isMac
      ? []
      : ([{ type: "separator" }, { role: "togglefullscreen" }] as MenuItemConstructorOptions[])),
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: "appMenu" }] as MenuItemConstructorOptions[]) : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
