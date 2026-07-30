// Provider Catalog IPC 域（阶段①）：把构建期生成的只读 Catalog 交给 renderer。
// ⚠️ 骨架占位：实现由 `../providers/catalog.ts` 提供（见实现计划阶段 ①·2.1）。

import { ipcMain } from "electron";

import { getProviderCatalogResult } from "../providers/catalog";
import { PROVIDER_IPC } from "../providers/contract";

/** 注册 Catalog 只读通道。Catalog 不含任何秘密，可直接交给 renderer。 */
export function registerProviderCatalogHandlers(): void {
  ipcMain.handle(PROVIDER_IPC.catalogGet, () => getProviderCatalogResult());
}
