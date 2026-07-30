// 插件目录共享 hook（三层 IA）。把 bridge.pluginList()（已装插件，只读扫描）与 store 的启停/信任态
// （generalSettings.plugins）合成「装饰后的插件列表」，供插件首页 / 管理页「插件」sub-tab / 详情页共用。
// 启停/信任语义见 core PluginEnableSettings：enabled 为 opt-in；trusted 默认真，仅 distrusted 记撤信。
// 注入 gate（实际生效）= enabled && trusted（与 skill-injection.resolveEnabledPluginSkillDirs 一致）。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PLUGIN_ENABLE,
  useDesktopBridge,
  usePersonalStore,
  type InstalledPlugin,
  type MarketplaceEntry,
} from "@cortex-work/core";

export type DecoratedPlugin = InstalledPlugin & { enabled: boolean; trusted: boolean };

type ListState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; items: InstalledPlugin[]; rootExists: boolean };

type MarketState =
  | { kind: "loading" }
  | { kind: "ready"; items: MarketplaceEntry[]; rootExists: boolean; error?: string };

export interface PluginCatalog {
  noBridge: boolean;
  state: ListState;
  plugins: DecoratedPlugin[]; // 装饰后的已装插件（叠加 enabled/trusted）
  market: MarketState;
  refresh: () => void;
  togglePlugin: (id: string, enabled: boolean) => void;
  setPluginTrusted: (id: string, trusted: boolean) => void;
}

export function usePluginCatalog(): PluginCatalog {
  const bridge = useDesktopBridge();
  const pluginCfg = usePersonalStore((s) => s.generalSettings.plugins) ?? DEFAULT_PLUGIN_ENABLE;
  const togglePlugin = usePersonalStore((s) => s.togglePlugin);
  const setPluginTrusted = usePersonalStore((s) => s.setPluginTrusted);

  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [market, setMarket] = useState<MarketState>({ kind: "loading" });

  const noBridge = !bridge?.pluginList;

  const refresh = useCallback(() => {
    if (!bridge?.pluginList) {
      setState({ kind: "ready", items: [], rootExists: false });
      setMarket({ kind: "ready", items: [], rootExists: false });
      return;
    }
    setState({ kind: "loading" });
    void bridge
      .pluginList()
      .then((res) => setState({ kind: "ready", items: res.items, rootExists: res.rootExists }))
      .catch((e: unknown) => setState({ kind: "error", error: e instanceof Error ? e.message : String(e) }));
    // 市场索引并行拉取，失败不阻断已装列表。
    if (bridge.marketplaceList) {
      setMarket({ kind: "loading" });
      void bridge
        .marketplaceList()
        .then((res) => setMarket({ kind: "ready", items: res.items, rootExists: res.rootExists, error: res.error }))
        .catch((e: unknown) =>
          setMarket({ kind: "ready", items: [], rootExists: false, error: e instanceof Error ? e.message : String(e) }),
        );
    } else {
      setMarket({ kind: "ready", items: [], rootExists: false });
    }
  }, [bridge]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 叠加启停/信任态：enabled = id ∈ enabled 集；trusted = id ∉ distrusted 集（默认已授信）。
  const plugins = useMemo<DecoratedPlugin[]>(() => {
    const items = state.kind === "ready" ? state.items : [];
    const enabled = new Set(pluginCfg.enabled);
    const distrusted = new Set(pluginCfg.distrusted);
    return items.map((p) => ({
      ...p,
      enabled: enabled.has(p.manifest.id),
      trusted: !distrusted.has(p.manifest.id),
    }));
  }, [state, pluginCfg]);

  return { noBridge, state, plugins, market, refresh, togglePlugin, setPluginTrusted };
}
