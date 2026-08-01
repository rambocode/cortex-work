// 默认模型的「供应商 → 模型」级联下拉（对齐高保真原型）：只列「认证可用 ∧ 未隐藏 ∧
// 有模型」的供应商；切供应商时落到该供应商第一个模型（这是用户的显式操作，不属于
// 「静默换模型」）。
//
// 悬空引用阻断红线（计划 §5，与 ModelRefField 同口径）：已保存的 {providerId, modelId}
// 在候选里查不到时，下拉里插入一个 disabled 的原始值选项 + 红色阻断提示，**不自动回退
// 到任何别的模型**——静默换模型会让用户以为还在用原配置，账单和输出却全变了。

import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import { providerUsable, useProviderViews } from "./useProviderData";

export function DefaultModelSelects() {
  const { t } = useTranslation("settings");
  const { views, loading } = useProviderViews();
  const defaultRef = usePersonalStore((s) => s.defaultModelRef);
  const setDefaultModelRef = usePersonalStore((s) => s.setDefaultModelRef);

  const usable = views.filter((v) => !v.hidden && providerUsable(v) && v.provider.models.length > 0);
  const currentView = usable.find((v) => v.provider.id === defaultRef?.providerId);
  // 目录尚未加载完时不判悬空，避免闪一下红色阻断态又变回正常（与 useModelRefStatus 同规则）。
  const providerDangling = !!defaultRef && !loading && !currentView;
  const modelDangling =
    !!defaultRef && !loading && !!currentView && !currentView.provider.models.some((m) => m.id === defaultRef.modelId);

  return (
    <div className="pw-pip-defmodel">
      <div className="pw-pip-defmodel-row">
        <select
          className="pw-set-input pw-pip-defsel"
          aria-label={t("pi.defaultProvider")}
          value={defaultRef?.providerId ?? ""}
          onChange={(e) => {
            const v = usable.find((x) => x.provider.id === e.target.value);
            const first = v?.provider.models[0];
            if (v && first) setDefaultModelRef({ providerId: v.provider.id, modelId: first.id });
          }}
        >
          {!defaultRef ? (
            <option value="" disabled>
              {t("providers.inline.unset")}
            </option>
          ) : null}
          {providerDangling ? (
            <option value={defaultRef.providerId} disabled>
              {defaultRef.providerId}
            </option>
          ) : null}
          {usable.map((v) => (
            <option key={v.provider.id} value={v.provider.id}>
              {v.provider.name}
            </option>
          ))}
        </select>
        <select
          className="pw-set-input pw-pip-defsel is-model"
          aria-label={t("pi.defaultModel")}
          value={defaultRef?.modelId ?? ""}
          disabled={!currentView}
          onChange={(e) => {
            if (currentView) setDefaultModelRef({ providerId: currentView.provider.id, modelId: e.target.value });
          }}
        >
          {!currentView || modelDangling ? (
            <option value={defaultRef?.modelId ?? ""} disabled>
              {modelDangling ? defaultRef?.modelId : t("providers.inline.unset")}
            </option>
          ) : null}
          {(currentView?.provider.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {providerDangling || modelDangling ? (
        <div className="pw-prov-alert is-error">
          {t("providers.picker.dangling", {
            provider: defaultRef?.providerId ?? "",
            model: defaultRef?.modelId ?? "",
          })}
        </div>
      ) : null}
      <div className="pw-set-hint">{t("providers.inline.defaultModelHint", { count: usable.length })}</div>
    </div>
  );
}
