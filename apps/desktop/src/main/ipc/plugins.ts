// 插件市场 IPC（第一期，只读）。两个 channel：
//   plugins:list     → 扫描 ~/.agents/plugins/plugins/<id>/ 已装插件（manifest 回退解析）
//   marketplace:list → 读 ~/.agents/plugins/marketplace.json 索引（坏条目容错）
// 纯只读消费，不写共享目录；main 不读 store（启停/信任态在渲染端 core store，注入接线见 U6）。
// 安装/升级/删除为后续阶段，本文件不提供（避免误触发未实现写盘路径）。

import { ipcMain } from "electron";
import { scanInstalledPlugins } from "../plugins/scan";
import { readMarketplaceIndex } from "../plugins/marketplace";
import type { MarketplaceListResult, PluginListResult } from "./plugin-types";

export function registerPluginHandlers(): void {
  ipcMain.handle("plugins:list", (): Promise<PluginListResult> => scanInstalledPlugins());
  ipcMain.handle("marketplace:list", (): Promise<MarketplaceListResult> => readMarketplaceIndex());
}
