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

export function ProviderModelList({
  models,
  /**
   * 每个模型的能力来源标注（modelId → sourceRef）。只有聚合网关向导生成的自定义 Provider
   * 才有；内建 Provider 与手写 JSON 的定义传空/不传，界面上就不显示这一行。
   */
  capabilitySources,
}: {
  models: CatalogModel[];
  capabilitySources?: Record<string, string>;
}) {
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
          <CapabilitySourceNote source={capabilitySources?.[m.id]} />
        </div>
      ))}
    </div>
  );
}

/**
 * 「这套能力当初是从哪来的」的只读标注（方案 §B2/§B4）。
 *
 * 两种来源要分开说，因为可信度不同：`目录` 是从随包 pi 内置目录逐字段取的；
 * `参照 <model>` 是用户指认另一个模型后整套继承的 —— 后者是人的判断，日后回看时
 * 需要知道当初照的是谁，才能判断它还对不对。没有标注（手写 JSON / 旧定义）就不渲染，
 * 绝不编一个来源出来。
 */
function CapabilitySourceNote({ source }: { source: string | undefined }) {
  const { t } = useTranslation("settings");
  if (!source) return null;
  // 三态：目录命中 / 用户指认的参照 / 保守兜底。兜底必须单独说清楚 ——
  // 把它混进「目录」会让保守默认看起来像查到的事实，那正是能力可追溯性要防的。
  if (source === "fallback") {
    return (
      <span className="pw-ml-source is-fallback" title={t("providers.models.sourceTitle")}>
        {t("providers.models.sourceFallback")}
      </span>
    );
  }
  const reference = source.startsWith("reference:");
  const ref = reference ? source.slice("reference:".length) : source;
  return (
    <span className="pw-ml-source" title={t("providers.models.sourceTitle")}>
      {reference
        ? t("providers.models.sourceReference", { ref })
        : t("providers.models.sourceCatalog", { ref })}
    </span>
  );
}
