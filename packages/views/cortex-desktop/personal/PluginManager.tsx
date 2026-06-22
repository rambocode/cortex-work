// 扩展入口三层 IA（Codex 风格，取代旧「技能/插件」两 tab）：
//   第一层 顶栏两大类首页：插件 / 技能
//   第二层 管理页四 sub-tab：插件 / MCP / 技能 / 市场（pi 原生扩展并入 MCP 同级；市场只读）
//   第三层 插件详情页：富元数据 + 捆绑 skills + 启停 + 在对话中试用
// 插件 = agents 标准捆绑包（~/.agents/plugins/，只读消费）；技能 = 第一方/工作区 SKILL.md。
// 「应用」本期不做。插件目录数据经 usePluginCatalog 在本壳取一次、下传子页共享。

import { useCallback, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import { SkillPanel } from "./SkillPanel";
import { PluginsHome } from "./PluginsHome";
import { PluginManagePage } from "./PluginManagePage";
import { PluginDetail } from "./PluginDetail";
import { usePluginCatalog } from "./usePluginCatalog";

type ManageTab = "plugins" | "mcp" | "skills" | "market";
// 返回快照：详情/管理页面包屑据此回跳来源。
type Ret = { view: "home" | "manage"; homeTab: "plugins" | "skills"; manageTab: ManageTab };

export function PluginManager() {
  const bridge = useDesktopBridge();
  const catalog = usePluginCatalog();

  const [view, setView] = useState<"home" | "manage" | "detail">("home");
  const [homeTab, setHomeTab] = useState<"plugins" | "skills">("plugins");
  const [manageTab, setManageTab] = useState<ManageTab>("plugins");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ret, setRet] = useState<Ret>({ view: "home", homeTab: "plugins", manageTab: "plugins" });

  const snap = useCallback(
    (): Ret => ({ view: view === "detail" ? ret.view : (view as "home" | "manage"), homeTab, manageTab }),
    [view, ret.view, homeTab, manageTab],
  );

  const openDetail = useCallback(
    (id: string) => {
      setRet(snap());
      setSelectedId(id);
      setView("detail");
    },
    [snap],
  );

  const goManage = useCallback((tab: ManageTab = "plugins") => {
    setManageTab(tab);
    setView("manage");
  }, []);

  const back = useCallback(() => {
    setView(ret.view);
    setHomeTab(ret.homeTab);
    setManageTab(ret.manageTab);
  }, [ret]);

  const selected = catalog.plugins.find((p) => p.manifest.id === selectedId) ?? null;

  return (
    <div className="pw-plg">
      {/* 顶栏（仅首页）：插件 / 技能 两大类 */}
      {view === "home" ? (
        <div className="pw-plg-nav" role="tablist" aria-label="扩展类型">
          <button
            type="button"
            role="tab"
            aria-selected={homeTab === "plugins"}
            className={`pw-seg ${homeTab === "plugins" ? "is-on" : ""}`}
            onClick={() => setHomeTab("plugins")}
          >
            插件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={homeTab === "skills"}
            className={`pw-seg ${homeTab === "skills" ? "is-on" : ""}`}
            onClick={() => setHomeTab("skills")}
          >
            技能
          </button>
        </div>
      ) : (
        // 面包屑（管理 / 详情）：回跳来源页。
        <div className="pw-plg-crumb">
          <button type="button" className="pw-plg-crumb-link" onClick={back}>
            插件
          </button>
          <span className="pw-plg-crumb-sep">›</span>
          <span className="pw-plg-crumb-cur">
            {view === "manage" ? "管理" : (selected?.manifest.displayName ?? selected?.manifest.name ?? "详情")}
          </span>
        </div>
      )}

      {view === "home" && homeTab === "plugins" ? (
        <PluginsHome catalog={catalog} onOpenDetail={openDetail} onManage={() => goManage("plugins")} />
      ) : null}
      {view === "home" && homeTab === "skills" ? <SkillPanel bridge={bridge} /> : null}
      {view === "manage" ? (
        <PluginManagePage
          catalog={catalog}
          bridge={bridge}
          tab={manageTab}
          onTab={setManageTab}
          onOpenDetail={openDetail}
        />
      ) : null}
      {view === "detail" ? (
        <PluginDetail plugin={selected} catalog={catalog} onTryInChat={undefined} />
      ) : null}
    </div>
  );
}
