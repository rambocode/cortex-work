// 插件市场（第一期，只读）类型。agents 标准插件（~/.agents/plugins/）的归一形态：
// 已装插件（manifest 回退解析）+ marketplace.json 索引条目。与
// apps/desktop/src/main/ipc/plugin-types.ts 逐字镜像（core 不能依赖 app 包，两侧各持一份）。
//
// 本期纯只读消费：不写共享目录、不 git 安装；启停/信任态在 core store（见 personal.ts）。
// 安装/升级/删除是后续阶段（见 docs/plans/2026-06-22-001-feat-unified-plugin-marketplace-plan.md）。

// manifest 来源：回退链解析后标注命中哪一档（供 UI / 调试区分第一方兼容 vs 标准插件）。
export type PluginManifestKind = "codex" | "claude" | "skill-fallback";

// 插件 manifest 归一字段（`.codex-plugin/plugin.json` 字段最全，其余档回退为子集）。
export interface PluginManifest {
  id: string; // 插件目录名 / manifest id（启停集的稳定键）
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  category?: string;
  capabilities?: string[]; // 能力元数据（本期仅读取保留，供后续「应用」面按能力过滤）
  defaultPrompt?: string; // 详情页「在对话中试用」预填
}

// 已装插件：扫描 ~/.agents/plugins/plugins/<id>/ 解析得到。
export interface InstalledPlugin {
  manifest: PluginManifest;
  installPath: string; // 插件包目录绝对路径（详情页「本地路径」）
  skillsDir?: string; // <installPath>/skills（存在且 isInside 校验通过才置；启用后并入注入扫描根）
  manifestKind: PluginManifestKind;
}

// plugins:list 返回。rootExists 区分「无 ~/.agents/plugins 目录」与「目录在但空」空态文案。
export interface PluginListResult {
  items: InstalledPlugin[];
  rootExists: boolean;
}

// marketplace.json 条目来源类型（异构 schema 归一）。
export type MarketplaceSourceKind = "local" | "git" | "unknown";

// marketplace.json 单条目归一。坏条目 ok=false + error（对齐设计稿「部分插件市场无法加载」错误卡）。
export interface MarketplaceEntry {
  id?: string;
  name: string;
  description?: string;
  category?: string;
  version?: string;
  sourceKind: MarketplaceSourceKind;
  sourcePath?: string; // source.path（local）
  gitUrl?: string; // gitUrl（git）
  ok: boolean; // 解析完整性：缺关键字段（如 source）→ false
  error?: string; // 坏条目原因
}

// marketplace:list 返回。error = 整文件读/解析失败（JSON 非法等）；rootExists = marketplace.json 是否存在。
export interface MarketplaceListResult {
  items: MarketplaceEntry[];
  rootExists: boolean;
  error?: string;
}
