// agents 标准插件目录定位（第一期，只读）。cortex 作消费方读取与 codex 共享的磁盘标准位置
// `~/.agents/plugins/`：
//   - marketplace.json  → 市场索引（可用/已订阅插件）
//   - plugins/<id>/      → 已装插件包（含 .codex-plugin/plugin.json 或 .claude-plugin/plugin.json + skills/）
// 本期不写这些路径（不安装/不 merge）；写盘类动作是后续阶段。

import { homedir } from "os";
import { join } from "path";

// agents 共享插件根。允许 CORTEX_AGENTS_PLUGINS_ROOT 覆盖（仅供测试指向临时目录用）。
export function agentsPluginsRoot(): string {
  return process.env.CORTEX_AGENTS_PLUGINS_ROOT || join(homedir(), ".agents", "plugins");
}

// 已装插件包根：<agentsPluginsRoot>/plugins。
export function installedPluginsRoot(): string {
  return join(agentsPluginsRoot(), "plugins");
}

// 市场索引文件：<agentsPluginsRoot>/marketplace.json。
export function marketplaceIndexPath(): string {
  return join(agentsPluginsRoot(), "marketplace.json");
}
