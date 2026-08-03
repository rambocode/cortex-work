// 聚合网关向导里的「参照模型」选择器：一个内联展开的可搜索列表。
//
// 为什么不复用 ModelPicker / collectModelOptions：那两者的候选集是「认证可用 ∧ 未隐藏」的
// Provider，服务的是「我现在要用哪个模型」。这里要的是完全不同的语义——「拿哪条目录条目的
// **能力元数据**当模板」，用户完全可能没有 OpenAI 的 key 却要照抄 gpt-4o 的能力。按认证过滤
// 会让绝大多数参照对象凭空消失，所以数据源必须是**全量 Catalog**。
//
// 为什么做成内联展开而不是浮层：设置页里 popover 反复出现「超出视口被裁」的问题，行内展开
// 天然没有定位问题，也能同时看到所属那一行是哪个模型。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useProviderCatalog } from "@cortex-work/core";
import type { CatalogModel } from "@cortex-work/core/desktop/provider-catalog";
import { CapabilityBadges } from "./capabilityFormat";

/** 一条可选的参照模型：目录里的模型 + 它所属 Provider 的展示信息。 */
export interface ReferenceOption {
  providerId: string;
  providerName: string;
  modelId: string;
  model: CatalogModel;
}

/** 全量 Catalog 展平成参照候选（不按认证/隐藏过滤 —— 这里只借能力元数据，不发请求）。 */
export function useReferenceOptions(): {
  options: ReferenceOption[];
  loading: boolean;
  error: string | undefined;
  unsupported: boolean;
} {
  const { catalog, error, loading, unsupported } = useProviderCatalog();
  const options = useMemo(() => {
    const out: ReferenceOption[] = [];
    for (const p of catalog?.providers ?? []) {
      for (const m of p.models) {
        out.push({ providerId: p.id, providerName: p.name, modelId: m.id, model: m });
      }
    }
    return out;
  }, [catalog]);
  return { options, loading, error, unsupported };
}

/** 在参照候选里按「供应商名 / 模型 id / 模型名」搜索，大小写不敏感，空串放行全部。 */
export function filterReferenceOptions(options: ReferenceOption[], query: string): ReferenceOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) =>
      o.providerName.toLowerCase().includes(q) ||
      o.modelId.toLowerCase().includes(q) ||
      o.model.name.toLowerCase().includes(q),
  );
}

/**
 * 参照模型的内联选择面板。选中即回调关闭，不做多选。
 * 列表限量渲染（LIST_LIMIT）：全量 Catalog 有数百条，一次性铺开会拖慢整页，
 * 搜索是主要的收敛手段，故只提示「还有更多，继续搜索」。
 */
const LIST_LIMIT = 60;

export function GatewayReferencePicker({
  onPick,
  onCancel,
}: {
  onPick: (option: ReferenceOption) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("settings");
  const { options, loading, error, unsupported } = useReferenceOptions();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => filterReferenceOptions(options, query), [options, query]);
  const shown = filtered.slice(0, LIST_LIMIT);

  return (
    <div className="pw-gw-ref">
      <div className="pw-gw-ref-head">
        <label className="pw-model-picker-search">
          <Icon.Search size={13} />
          <input
            className="pw-set-input"
            value={query}
            placeholder={t("providers.gateway.referenceSearch")}
            aria-label={t("providers.gateway.referenceSearch")}
            spellCheck={false}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className="pw-pip-linkbtn" onClick={onCancel}>
          {t("providers.gateway.referenceCancel")}
        </button>
      </div>

      {unsupported ? <div className="pw-set-hint">{t("providers.catalogUnsupported")}</div> : null}
      {error ? (
        <div className="pw-prov-alert is-error">{t("providers.catalogUnavailable", { error })}</div>
      ) : null}
      {loading ? <div className="pw-set-hint">{t("providers.catalogLoading")}</div> : null}
      {!loading && !error && filtered.length === 0 ? (
        <div className="pw-set-hint">{t("providers.gateway.referenceNoResult")}</div>
      ) : null}

      <div className="pw-gw-ref-list" role="listbox" aria-label={t("providers.gateway.chooseReference")}>
        {shown.map((o) => (
          <button
            key={`${o.providerId}::${o.modelId}`}
            type="button"
            role="option"
            aria-selected={false}
            className="pw-model-picker-row"
            onClick={() => onPick(o)}
          >
            <span className="pw-model-picker-main">
              <span className="pw-model-picker-name">{o.model.name}</span>
              <span className="pw-model-picker-meta">
                {o.providerName} · {o.modelId}
              </span>
            </span>
            <CapabilityBadges model={o.model} compact />
          </button>
        ))}
      </div>

      {filtered.length > shown.length ? (
        <div className="pw-set-hint">
          {t("providers.gateway.referenceMore", { count: filtered.length - shown.length })}
        </div>
      ) : null}
    </div>
  );
}
