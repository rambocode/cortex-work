// 供应商管理弹窗（阶段③重构）。由「Pi」设置分区的按钮打开。
//
// 从「用户手填 baseUrl / 模型 / 能力 checkbox」改成「Catalog 驱动 + 认证管理」：
//   左栏  = Pi 内置目录里的 Provider，按认证状态分组（未配置 / 已登录 / 环境变量 / 系统凭据）；
//   右栏  = 认证操作 + 只读模型能力；
//   自定义 Provider 单开一个 tab（完整 Pi Provider JSON + Secret 引用）。
//
// 具体子面板见 provider/ 目录，本文件只负责外壳：tab、左栏列表、四种降级态。
// 拆分原因：单文件 ≤1200 行的硬约束，且认证 / 只读能力 / 自定义 JSON 三块职责差异很大。
//
// 四种必须有明确出口的降级态（不能白屏、不能崩）：
//   ① Catalog 加载失败（providerCatalogGet 返回 ok:false）→ 红色说明条，其余功能不可用。
//   ② 桥不支持（Web 端 / 旧壳）→ 「桌面端专属」提示。
//   ③ safeStorage 不可用 → 顶部黄色只读警告条 + 全部密钥输入禁用（绝不明文回写）。
//   ④ 旧 providerSettings 被首启清理 → 一次性告知「请重新登录」。
//
// ESC 处理:capture 阶段监听 + stopPropagation,避免连带触发设置整页的 ESC 返回。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import { ProviderDetailPanel } from "./provider/ProviderDetailPanel";
import { CustomProviderPanel } from "./provider/CustomProviderPanel";
import { providerUsable, useCustomProviders, useProviderViews, type ProviderView } from "./provider/useProviderData";

type Tab = "builtin" | "custom";

export function ProviderManagerModal({
  initialSelectedId,
  onClose,
}: {
  initialSelectedId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const { views, loading, catalogError, catalogUnsupported, snapshot } = useProviderViews();
  const { items: customItems } = useCustomProviders();
  const [tab, setTab] = useState<Tab>("builtin");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId);
  const legacyCleared = usePersonalStore((s) => s.legacyProviderSettingsCleared);
  const acknowledgeLegacy = usePersonalStore((s) => s.acknowledgeLegacyProviderNotice);

  const builtinViews = useMemo(() => views.filter((v) => !v.custom), [views]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return builtinViews;
    return builtinViews.filter((v) => v.provider.name.toLowerCase().includes(q) || v.provider.id.toLowerCase().includes(q));
  }, [builtinViews, query]);

  // 选中项跟随可见列表：初始选中或选中项被搜索过滤掉时，落到第一项。
  const selected = filtered.find((v) => v.provider.id === selectedId) ?? filtered[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (typing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const storageAvailable = snapshot.health.available;

  return (
    <div className="pw-prov-modal-mask" onClick={onClose}>
      <div
        className="pw-prov-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("providers.manage")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pw-prov-modal-head">
          <span className="pw-prov-modal-title">{t("providers.manage")}</span>
          <div className="pw-prov-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "builtin"}
              className={`pw-prov-tab ${tab === "builtin" ? "is-active" : ""}`}
              onClick={() => setTab("builtin")}
            >
              {t("providers.tabBuiltin")}
            </button>
            <button
              role="tab"
              aria-selected={tab === "custom"}
              className={`pw-prov-tab ${tab === "custom" ? "is-active" : ""}`}
              onClick={() => setTab("custom")}
            >
              {t("providers.tabCustom")}
            </button>
          </div>
          <button className="pw-prov-modal-close" aria-label={t("providers.manageClose")} onClick={onClose}>
            <Icon.X size={15} />
          </button>
        </div>

        <div className="pw-prov-modal-body">
          {/* safeStorage 不可用是全局性的：两个 tab 都受影响，故警告条放在最外层。 */}
          {!storageAvailable ? (
            <div className="pw-prov-alert is-warn" role="status">
              {t("providers.storageUnavailable", { reason: snapshot.health.reason ?? "" })}
            </div>
          ) : null}

          {/* 旧 providerSettings 被首启清理（计划 §5，不迁移）→ 一次性告知「请重新登录」。
              点「知道了」后置 noticeAcknowledged，随下一次全量保存落盘，之后不再弹。
              标记本身由主进程写入，渲染端只负责展示 + 确认（见 store 的字段注释）。 */}
          {legacyCleared && !legacyCleared.noticeAcknowledged ? (
            <div className="pw-prov-alert is-warn" role="status">
              {t("providers.legacyCleared")}
              <div className="pw-mode-block-actions">
                <button type="button" className="pw-mode-block-btn" onClick={acknowledgeLegacy}>
                  {t("providers.legacyClearedDismiss")}
                </button>
              </div>
            </div>
          ) : null}

          {catalogUnsupported ? <div className="pw-set-hint">{t("providers.catalogUnsupported")}</div> : null}
          {catalogError ? (
            <div className="pw-prov-alert is-error" role="alert">
              {t("providers.catalogUnavailable", { error: catalogError })}
            </div>
          ) : null}

          {tab === "custom" ? (
            <CustomProviderPanel items={customItems} storageAvailable={storageAvailable} />
          ) : loading ? (
            <div className="pw-set-hint">{t("providers.catalogLoading")}</div>
          ) : !catalogError && !catalogUnsupported && builtinViews.length === 0 ? (
            <div className="pw-set-hint">{t("providers.catalogEmpty")}</div>
          ) : builtinViews.length > 0 ? (
            <div className="pw-prov-split">
              <div className="pw-prov-list">
                <label className="pw-model-picker-search">
                  <Icon.Search size={13} />
                  <input
                    className="pw-set-input"
                    value={query}
                    placeholder={t("providers.search")}
                    aria-label={t("providers.search")}
                    spellCheck={false}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                {filtered.length === 0 ? <div className="pw-set-hint">{t("providers.searchNoResult")}</div> : null}
                {filtered.map((v) => (
                  <ProviderListItem
                    key={v.provider.id}
                    view={v}
                    active={v.provider.id === selected?.provider.id}
                    onClick={() => setSelectedId(v.provider.id)}
                  />
                ))}
              </div>
              {selected ? (
                <ProviderDetailPanel
                  key={selected.provider.id}
                  view={selected}
                  hiddenIds={snapshot.hiddenProviderIds}
                  storageAvailable={storageAvailable}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 左栏一行：名称 + 认证状态徽标 + 模型数。状态徽标区分五态（含「已隐藏」这一展示维度）。 */
function ProviderListItem({ view, active, onClick }: { view: ProviderView; active: boolean; onClick: () => void }) {
  const { t } = useTranslation("settings");
  const { provider, status, hidden } = view;
  const statusKey =
    status.source === "safe-storage"
      ? status.type === "oauth"
        ? "oauth"
        : "safeStorage"
      : status.source === "env"
        ? "env"
        : status.source === "ambient"
          ? "ambient"
          : "none";
  return (
    <button className={`pw-prov-item ${active ? "is-active" : ""}`} onClick={onClick}>
      <span className="pw-prov-item-name">{provider.name}</span>
      <span className="pw-prov-item-meta">
        <span className={`pw-prov-status is-${statusKey}`} data-usable={providerUsable(view) ? "1" : "0"}>
          {t(`providers.status.${statusKey}`)}
        </span>
        {hidden ? <span className="pw-prov-badge">{t("providers.badgeHidden")}</span> : null}
        <span className="pw-prov-badge">{t("providers.badgeModels", { count: provider.models.length })}</span>
      </span>
    </button>
  );
}
