// 扫描 agents 标准已装插件（第一期，只读）。浅扫 installedPluginsRoot() 一层子目录，逐个
// parsePluginManifest。root 不存在 → 空列表 + rootExists=false（空态文案区分「无目录」与「空目录」）。
// 读取失败一律容错跳过，不抛——共享目录由 codex/用户维护，cortex 作消费方须容忍缺失/异常项。

import { promises as fsp } from "fs";
import type { Dirent } from "fs";
import { join } from "path";
import { installedPluginsRoot } from "./locate";
import { parsePluginManifest } from "./manifest";
import type { InstalledPlugin, PluginListResult } from "../ipc/plugin-types";

export async function scanInstalledPlugins(): Promise<PluginListResult> {
  const root = installedPluginsRoot();
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { items: [], rootExists: false };
  }

  const items: InstalledPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const plugin = await parsePluginManifest(join(root, entry.name));
    if (plugin) items.push(plugin);
  }
  // 按 displayName/name 稳定排序，避免目录枚举顺序漂移导致 UI 列表抖动。
  items.sort((a, b) => {
    const an = a.manifest.displayName ?? a.manifest.name;
    const bn = b.manifest.displayName ?? b.manifest.name;
    return an.localeCompare(bn);
  });
  return { items, rootExists: true };
}
