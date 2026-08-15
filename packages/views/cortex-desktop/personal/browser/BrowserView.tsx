// 右栏内嵌浏览器的多标签壳:标签条 + N 个常驻 BrowserTabPane(每标签自持全部浏览状态)。
// 非活跃标签只隐藏不卸载(webview 保活,切回即恢复现场),隐藏方式见 BrowserTabPane 顶注。
// 「在浏览器打开」请求(卡片点击 / auto_open,store.browserUrlRequest)由壳统一消费,
// 路由到**当前活跃标签**加载——与单标签时代语义一致,不额外开新标签。
// 标签自身为内存态,不持久化(与右栏其它面板一致,重启回到单空标签)。

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { BrowserTabPane, hostOf, type PaneLoadRequest, type PaneMeta } from "./BrowserTabPane";

// 测试与外部引用的环境探测函数保持从 BrowserView 可导入(实现随面板主体迁至 BrowserTabPane)。
export { canUseElectronWebviewEnvironment } from "./BrowserTabPane";

export function BrowserView({ onToast }: { onToast?: (text: string) => void }) {
  const { t } = useTranslation("browser");
  // 监听「在浏览器打开」请求(卡片点击 / auto_open)。nonce 变化即路由给活跃标签。
  const browserUrlRequest = usePersonalStore((s) => s.browserUrlRequest);

  // 标签只存自增 id;标题/URL 由各 pane 上报(metaById),加载请求按 id 路由(loadById)。
  const [tabIds, setTabIds] = useState<number[]>([0]);
  const [activeId, setActiveId] = useState(0);
  const nextIdRef = useRef(1);
  const [metaById, setMetaById] = useState<Record<number, PaneMeta>>({});
  const [loadById, setLoadById] = useState<Record<number, PaneLoadRequest>>({});
  // 从 0 起(而非挂载时的 nonce):面板常是被本次请求打开的,从 0 起才会在挂载时消费
  // 当前 pending 请求(修「首次点击空白、需再点一次」,语义同单标签时代)。
  const lastRequestNonceRef = useRef(0);

  // 消费 store 请求 → 路由到当前活跃标签(pane 内部再按 nonce 去重执行)。
  useEffect(() => {
    if (!browserUrlRequest) return;
    if (browserUrlRequest.nonce === lastRequestNonceRef.current) return;
    lastRequestNonceRef.current = browserUrlRequest.nonce;
    const { nonce, url } = browserUrlRequest;
    setLoadById((prev) => ({ ...prev, [activeId]: { nonce, url } }));
  }, [browserUrlRequest, activeId]);

  // 稳定回调:pane 上报标题/URL。setState 函数式更新,不依赖外部状态。
  const handleMeta = useCallback((id: number, meta: PaneMeta) => {
    setMetaById((prev) => ({ ...prev, [id]: meta }));
  }, []);

  const addTab = (): void => {
    const id = nextIdRef.current++;
    setTabIds((prev) => [...prev, id]);
    setActiveId(id);
  };

  const closeTab = (id: number): void => {
    const idx = tabIds.indexOf(id);
    if (idx < 0) return;
    const remaining = tabIds.filter((x) => x !== id);
    if (remaining.length === 0) {
      // 关掉最后一个标签 = 重置为一个全新空标签(面板始终至少有一个标签)。
      const fresh = nextIdRef.current++;
      setTabIds([fresh]);
      setActiveId(fresh);
    } else {
      setTabIds(remaining);
      // 关的是活跃标签 → 激活原位置的后继(无后继则前一个),与主流浏览器一致。
      if (id === activeId) setActiveId(remaining[Math.min(idx, remaining.length - 1)]!);
    }
    // 清理已关标签的元信息/待加载请求,避免 Record 泄漏。
    setMetaById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLoadById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // 标签条文案:页面标题 > URL host > 「新标签页」。
  const labelOf = (id: number): string => {
    const meta = metaById[id];
    if (meta?.title) return meta.title;
    if (meta?.url) return hostOf(meta.url);
    return t("tabs.newTab");
  };

  return (
    <div className="pw-browser">
      <div className="pw-browser-tabs" role="tablist">
        {tabIds.map((id) => (
          <div
            key={id}
            className={`pw-browser-tab${id === activeId ? " is-active" : ""}`}
            role="tab"
            aria-selected={id === activeId}
            title={metaById[id]?.url ?? labelOf(id)}
            onClick={() => setActiveId(id)}
          >
            <span className="pw-browser-tab-title">{labelOf(id)}</span>
            <button
              type="button"
              className="pw-browser-tab-close"
              title={t("tabs.close")}
              aria-label={t("tabs.close")}
              onClick={(e) => {
                // 阻止冒泡:关闭不应先触发「激活该标签」。
                e.stopPropagation();
                closeTab(id);
              }}
            >
              <Icon.X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="pw-icon-btn pw-browser-tab-add"
          title={t("tabs.new")}
          aria-label={t("tabs.new")}
          onClick={addTab}
        >
          <Icon.Plus size={14} />
        </button>
      </div>
      <div className="pw-browser-panes">
        {tabIds.map((id) => (
          <BrowserTabPane
            key={id}
            id={id}
            active={id === activeId}
            onToast={onToast}
            loadRequest={loadById[id] ?? null}
            onMeta={handleMeta}
          />
        ))}
      </div>
    </div>
  );
}
