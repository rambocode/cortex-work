// 市场 sub-tab（只读，第一期）。读 ~/.agents/plugins/marketplace.json 列条目；坏条目错误卡。
// 安装/升级/删除入口本期占位禁用（标注「即将支持」），从 UI 层守住「本期不写盘」边界（KTD7）。

import { Icon } from "@cortex-work/ui/icons";
import type { MarketplaceEntry } from "@cortex-work/core";
import type { PluginCatalog } from "./usePluginCatalog";

const SOURCE_LABEL: Record<MarketplaceEntry["sourceKind"], string> = {
  local: "本地",
  git: "Git",
  unknown: "未知",
};

export function MarketplaceList({ catalog }: { catalog: PluginCatalog }) {
  const market = catalog.market;

  if (catalog.noBridge) {
    return <div className="pw-plugins-empty" role="status">当前环境不支持市场（仅桌面端可用）。</div>;
  }
  if (market.kind === "loading") {
    return <div className="pw-plugins-empty" role="status">加载市场索引…</div>;
  }

  const bad = market.items.filter((e) => !e.ok);
  const good = market.items.filter((e) => e.ok);

  return (
    <div className="pw-plg-market">
      <div className="pw-plugins-hint" role="note">
        市场为只读浏览；从市场安装 / 升级 / 删除即将支持。
      </div>

      {/* 整文件读取/解析错误（JSON 非法等）。 */}
      {market.error ? (
        <div className="pw-plg-market-err" role="alert">
          <div className="pw-plg-market-err-title">市场索引加载异常</div>
          <div className="pw-plg-market-err-body">{market.error}</div>
        </div>
      ) : null}

      {/* 坏条目错误卡（缺 source 等，对齐设计稿「部分插件市场无法加载」）。 */}
      {bad.length > 0 ? (
        <div className="pw-plg-market-err" role="alert">
          <div className="pw-plg-market-err-title">部分插件市场条目无法加载（{bad.length}）</div>
          {bad.map((e, i) => (
            <div key={`${e.id ?? e.name}-${i}`} className="pw-plg-market-err-body">
              {e.name}：{e.error}
            </div>
          ))}
        </div>
      ) : null}

      {!market.rootExists ? (
        <div className="pw-plugins-empty" role="status">
          <div className="pw-plugins-empty-title">未发现市场索引</div>
          <div className="pw-plugins-empty-desc">~/.agents/plugins/marketplace.json 不存在。</div>
        </div>
      ) : good.length === 0 && bad.length === 0 ? (
        <div className="pw-plugins-empty" role="status">市场索引为空。</div>
      ) : (
        <div className="pw-plg-list">
          {good.map((e, i) => (
            <div key={`${e.id ?? e.name}-${i}`} className="pw-plg-row pw-plg-row-static">
              <span className="pw-plg-ico">{(e.name.charAt(0) || "?").toUpperCase()}</span>
              <div className="pw-plg-row-main">
                <div className="pw-plg-row-title">
                  <span className="pw-plg-row-name">{e.name}</span>
                  <span className="pw-tag">{SOURCE_LABEL[e.sourceKind]}</span>
                  {e.version ? <span className="pw-tag">v{e.version}</span> : null}
                </div>
                {e.description ? <div className="pw-plg-row-desc">{e.description}</div> : null}
                {e.gitUrl ? <div className="pw-plg-row-path">{e.gitUrl}</div> : null}
                {e.sourcePath ? <div className="pw-plg-row-path">{e.sourcePath}</div> : null}
              </div>
              <button type="button" className="pw-btn" disabled title="即将支持">
                <Icon.Plus size={14} /> 安装
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
