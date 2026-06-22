// 读取 agents 标准市场索引 marketplace.json（第一期，只读）。本机真实样本 schema 异构：
//   - { name, source:{source:"local",path}, policy, category }     → 本地源
//   - { id, name, description, version, gitUrl, revision }          → git 源
//   - { id, name, gitUrl }                                          → git 源（精简）
//   - 缺 source/gitUrl 的坏条目                                      → ok=false + error（错误卡）
// 纯只读：绝不写回（R4）。文件缺失 / JSON 非法 → 空列表 + 顶层 error（不抛）。

import { promises as fsp } from "fs";
import { marketplaceIndexPath } from "./locate";
import type { MarketplaceEntry, MarketplaceListResult, MarketplaceSourceKind } from "../ipc/plugin-types";

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

// 把单条原始 plugins[] 条目归一为 MarketplaceEntry。识别 local / git 源；坏条目标 ok=false。
function mapEntry(raw: unknown): MarketplaceEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { name: "（无效条目）", sourceKind: "unknown", ok: false, error: "条目不是对象" };
  }
  const o = raw as Record<string, unknown>;
  const id = asString(o.id);
  const name = asString(o.name) ?? id ?? "（未命名）";
  const description = asString(o.description);
  const category = asString(o.category);
  const version = asString(o.version);

  let sourceKind: MarketplaceSourceKind = "unknown";
  let sourcePath: string | undefined;
  let gitUrl: string | undefined;
  let ok = true;
  let error: string | undefined;

  const source = o.source && typeof o.source === "object" ? (o.source as Record<string, unknown>) : undefined;
  if (source && asString(source.source) === "local") {
    sourceKind = "local";
    sourcePath = asString(source.path);
    if (!sourcePath) {
      ok = false;
      error = "本地源缺少 path 字段";
    }
  } else if (asString(o.gitUrl)) {
    sourceKind = "git";
    gitUrl = asString(o.gitUrl);
  } else {
    // 对齐设计稿错误卡文案：缺 source。
    ok = false;
    error = "缺少 source 字段";
  }

  if (!asString(o.name) && !id) {
    ok = false;
    error = error ?? "条目缺少 name / id";
  }

  return { id, name, description, category, version, sourceKind, sourcePath, gitUrl, ok, error };
}

export async function readMarketplaceIndex(): Promise<MarketplaceListResult> {
  const path = marketplaceIndexPath();
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf8");
  } catch {
    return { items: [], rootExists: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { items: [], rootExists: true, error: "marketplace.json 解析失败（JSON 非法）" };
  }

  const pluginsRaw =
    parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).plugins)
      ? ((parsed as Record<string, unknown>).plugins as unknown[])
      : null;
  if (!pluginsRaw) {
    return { items: [], rootExists: true, error: "marketplace.json 缺少 plugins 数组" };
  }

  return { items: pluginsRaw.map(mapEntry), rootExists: true };
}
