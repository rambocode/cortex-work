// 管理页（三层 IA 第二层 · 管理）。四 sub-tab：插件 / MCP / 技能 / 市场。
//   - 插件：已装插件标准列表 + 启停 + 进详情。
//   - MCP：MCP 工具（McpCard）+ pi 原生扩展（ExtensionPanel）两个并列区（pi 扩展并入 MCP 同级，KTD6）。
//   - 技能：SkillPanel（沿用）。
//   - 市场：MarketplaceList（只读 + 错误卡；安装/升级占位禁用）。
// 无「应用」sub-tab（本期不做，R16）。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { McpServerConfig, McpSettings } from "@cortex-work/core";
import { McpCard } from "./McpSection";
import { McpServerForm } from "./McpServerForm";
import { ExtensionPanel } from "./ExtensionPanel";
import { SkillPanel } from "./SkillPanel";
import { MarketplaceList } from "./MarketplaceList";
import { PluginRow } from "./PluginRow";
import type { PluginCatalog } from "./usePluginCatalog";

type ManageTab = "plugins" | "mcp" | "skills" | "market";
const EMPTY_MCP: McpSettings = { enabled: false, servers: [] };

export function PluginManagePage({
  catalog,
  bridge,
  tab,
  onTab,
  onOpenDetail,
}: {
  catalog: PluginCatalog;
  bridge: ReturnType<typeof useDesktopBridge>;
  tab: ManageTab;
  onTab: (t: ManageTab) => void;
  onOpenDetail: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  // MCP 新增/编辑表单作为独立页（顶部返回,隐藏 sub-tabs,不与列表混在一起）。{index:null}=新增。
  const [mcpEditing, setMcpEditing] = useState<{ index: number | null } | null>(null);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const mcp: McpSettings = usePersonalStore((s) => s.generalSettings.mcp) ?? EMPTY_MCP;
  const mcpCount = mcp.servers.length;

  // 所有 hooks 须在任何条件 return 之前调用（react-hooks/rules-of-hooks）。
  const filteredPlugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog.plugins;
    return catalog.plugins.filter((p) =>
      ((p.manifest.displayName ?? p.manifest.name) + (p.manifest.description ?? "")).toLowerCase().includes(q),
    );
  }, [catalog.plugins, query]);

  const saveMcpServer = (cfg: McpServerConfig) => {
    const servers =
      mcpEditing?.index == null
        ? [...mcp.servers, cfg]
        : mcp.servers.map((s, i) => (i === mcpEditing.index ? cfg : s));
    setGeneral({ mcp: { ...mcp, servers } });
    setMcpEditing(null);
  };

  // MCP 表单独立页:整页只显示「返回 + 表单」,隐藏 sub-tabs 与其它功能。
  if (mcpEditing) {
    const initial = mcpEditing.index != null ? mcp.servers[mcpEditing.index] : undefined;
    return (
      <div className="pw-plg-manage">
        <button type="button" className="pw-plg-backbar" onClick={() => setMcpEditing(null)}>
          <Icon.Back size={15} /> 返回
        </button>
        <McpServerForm
          initial={initial}
          existingIds={mcp.servers.map((s) => s.id)}
          onSave={saveMcpServer}
          onCancel={() => setMcpEditing(null)}
        />
      </div>
    );
  }

  const tabs: { key: ManageTab; label: string; count?: number }[] = [
    { key: "plugins", label: "插件", count: catalog.plugins.length },
    { key: "mcp", label: "MCP", count: mcpCount },
    { key: "skills", label: "技能" },
    { key: "market", label: "市场", count: catalog.market.kind === "ready" ? catalog.market.items.length : undefined },
  ];

  return (
    <div className="pw-plg-manage">
      <div className="pw-plg-subtabs" role="tablist" aria-label="管理分类">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`pw-plg-subtab ${tab === t.key ? "is-on" : ""}`}
            onClick={() => onTab(t.key)}
          >
            {t.label}
            {t.count !== undefined ? <span className="pw-plg-subtab-count">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "plugins" ? (
        <div className="pw-plg-manage-plugins">
          <div className="pw-search pw-plg-home-search">
            <Icon.Search size={16} />
            <input
              className="pw-input pw-search-input"
              placeholder="搜索插件"
              aria-label="搜索插件"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>
          {catalog.plugins.length === 0 ? (
            <div className="pw-plugins-empty" role="status">
              <div className="pw-plugins-empty-title">还没有已装插件</div>
              <div className="pw-plugins-empty-desc">把 agents 标准插件装到 ~/.agents/plugins/ 后将在此出现。</div>
            </div>
          ) : (
            <div className="pw-plg-list">
              {filteredPlugins.map((p) => (
                <PluginRow
                  key={p.manifest.id}
                  plugin={p}
                  onOpen={() => onOpenDetail(p.manifest.id)}
                  onToggle={(on) => catalog.togglePlugin(p.manifest.id, on)}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === "mcp" ? (
        <div className="pw-plg-manage-mcp">
          <McpCard onEdit={(index) => setMcpEditing({ index })} />
          <div className="pw-plugins-hint pw-plugins-scope-note" role="note">
            <b>pi 原生扩展</b> 仅在 pi 会话中加载，对 <b>claude</b> / <b>codex</b> 无效。
          </div>
          <ExtensionPanel bridge={bridge} />
        </div>
      ) : null}

      {tab === "skills" ? <SkillPanel bridge={bridge} /> : null}

      {tab === "market" ? <MarketplaceList catalog={catalog} /> : null}
    </div>
  );
}
