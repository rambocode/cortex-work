// 插件首页（三层 IA 第二层 · 插件大类）。标题 + 搜索 + 「已添加」已装插件列表 + 「管理」入口。
// 本期无市场安装，故 Featured/分类区不堆假数据：以已装插件为主，空时给引导空态。
// 数据来自 usePluginCatalog（本壳取一次共享）。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { PluginCatalog } from "./usePluginCatalog";
import { PluginRow, pluginInitial } from "./PluginRow";

export function PluginsHome({
  catalog,
  onOpenDetail,
  onManage,
}: {
  catalog: PluginCatalog;
  onOpenDetail: (id: string) => void;
  onManage: () => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog.plugins;
    return catalog.plugins.filter((p) => {
      const m = p.manifest;
      return (
        (m.displayName ?? m.name).toLowerCase().includes(q) ||
        (m.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [catalog.plugins, query]);

  return (
    <div className="pw-plg-home">
      <div className="pw-plg-home-head">
        <h2 className="pw-plg-home-title">插件</h2>
        <p className="pw-plg-home-sub">把 agents 标准插件（含技能 / MCP）接入你的对话</p>
      </div>

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

      <div className="pw-plg-home-row">
        <div className="pw-plg-home-h">已添加</div>
        <button type="button" className="pw-plg-link" onClick={onManage}>
          管理
        </button>
      </div>

      {catalog.noBridge ? (
        <div className="pw-plugins-empty" role="status">
          当前环境不支持插件扫描（仅桌面端可用）。
        </div>
      ) : catalog.state.kind === "loading" ? (
        <div className="pw-plugins-empty" role="status">
          扫描中…
        </div>
      ) : catalog.state.kind === "error" ? (
        <div className="pw-plugins-empty" role="alert">
          <div className="pw-plugins-empty-title">扫描失败</div>
          <div className="pw-plugins-empty-desc">{catalog.state.error}</div>
          <button type="button" className="pw-btn" onClick={catalog.refresh}>
            重试
          </button>
        </div>
      ) : catalog.plugins.length === 0 ? (
        <div className="pw-plugins-empty" role="status">
          <div className="pw-plugins-empty-title">还没有已装插件</div>
          <div className="pw-plugins-empty-desc">
            把 agents 标准插件装到 ~/.agents/plugins/ 后将在此出现（安装入口即将支持）。
          </div>
        </div>
      ) : (
        <>
          {/* 已添加图标网格（快速进入详情）。 */}
          <div className="pw-plg-tiles">
            {catalog.plugins.map((p) => (
              <button
                key={p.manifest.id}
                type="button"
                className={`pw-plg-tile ${p.enabled && p.trusted ? "is-on" : ""}`}
                title={p.manifest.displayName ?? p.manifest.name}
                onClick={() => onOpenDetail(p.manifest.id)}
              >
                {pluginInitial(p.manifest)}
              </button>
            ))}
          </div>

          {/* 列表（搜索结果，带启停开关 + 进详情）。 */}
          <div className="pw-plg-list">
            {filtered.map((p) => (
              <PluginRow
                key={p.manifest.id}
                plugin={p}
                onOpen={() => onOpenDetail(p.manifest.id)}
                onToggle={(on) => catalog.togglePlugin(p.manifest.id, on)}
              />
            ))}
            {filtered.length === 0 ? <div className="pw-plugins-empty" role="status">没有匹配的插件。</div> : null}
          </div>
        </>
      )}
    </div>
  );
}
