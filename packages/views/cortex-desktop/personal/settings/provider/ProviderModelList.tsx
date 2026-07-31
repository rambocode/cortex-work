// Provider 详情里的**只读**模型列表：可搜索，逐条展示 图片输入 / 推理 / 上下文 / 最大输出 /
// 协议 / 成本。
//
// 这个组件没有增删改任何入口，这是刻意的：旧版这里是「添加模型 / 编辑 / 删除 + 推理·视觉
// checkbox + 上下文手填」，用户填的值经 extension 覆盖了 pi 的内置模型目录，导致同一个模型的
// context 从 272K 掉到 131K、图片能力从 yes 变成 no，pi 随后把图片替换成占位文本。
// 能力是系统元数据，不是用户偏好——详见 docs/2026-07-30-pi-tui-provider-model-capabilities-research.md §1.1/§3。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { CatalogModel } from "@cortex-work/core/desktop/provider-catalog";
import { CapabilityBadges } from "./capabilityFormat";

export function ProviderModelList({ models }: { models: CatalogModel[] }) {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, query]);

  return (
    <div className="pw-prov-models">
      <div className="pw-prov-models-head">
        <span className="pw-ml-title">{t("providers.models.title", { count: models.length })}</span>
        <label className="pw-model-picker-search">
          <Icon.Search size={13} />
          <input
            className="pw-set-input"
            value={query}
            placeholder={t("providers.models.search")}
            aria-label={t("providers.models.search")}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {/* 明确告诉用户「这里为什么不能改」，否则会被当成功能缺失反复来问。 */}
      <div className="pw-set-hint">{t("providers.models.readOnly")}</div>

      {models.length === 0 ? <div className="pw-set-hint">{t("providers.models.empty")}</div> : null}
      {models.length > 0 && filtered.length === 0 ? (
        <div className="pw-set-hint">{t("providers.models.noResult")}</div>
      ) : null}

      {filtered.map((m) => (
        <div key={m.id} className="pw-ml-card is-readonly">
          <div className="pw-ml-card-main">
            <span className="pw-ml-id">{m.name}</span>
            {m.name !== m.id ? <span className="pw-ml-sub">{m.id}</span> : null}
          </div>
          <CapabilityBadges model={m} />
        </div>
      ))}
    </div>
  );
}
