// 「选一个模型」的表单字段：Reply / Research / Automation / workflow AI 节点 / Computer Use
// 共用。点开即 ModelPickerDialog（同一份候选集与徽标规则）。
//
// 悬空引用阻断态（计划 §5）：当已保存的 {providerId, modelId} 在 Catalog 里查不到，
// 或它所属 Provider 未认证 / 被隐藏时，**不自动回退到任何别的模型**——静默换模型会让用户
// 以为还在用原来的配置，账单和输出却全变了。这里显示醒目的「模型未配置」并给设置入口，
// 由用户显式重选。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { ModelRef } from "@cortex-work/core/desktop/provider-catalog";
import { ModelPickerDialog } from "./ModelPickerDialog";
import { collectModelOptions, useProviderViews } from "./useProviderData";

/** 引用状态：ok（可用）/ dangling（目录里没有或不可用）/ unset（没选）。 */
export type ModelRefStatus = "ok" | "dangling" | "unset";

/** 判定一个模型引用当前是否可用。候选集口径与选择器完全一致，避免「选得到但判定为悬空」。 */
export function useModelRefStatus(value: ModelRef | undefined, requireImage?: boolean): ModelRefStatus {
  const { views, loading } = useProviderViews();
  if (!value?.providerId || !value.modelId) return "unset";
  // 目录尚未加载完时先按 ok 处理，避免闪一下红色阻断态又变回正常。
  if (loading) return "ok";
  const hit = collectModelOptions(views, requireImage).some(
    (o) => o.providerId === value.providerId && o.modelId === value.modelId,
  );
  return hit ? "ok" : "dangling";
}

export function ModelRefField({
  label,
  value,
  onChange,
  requireImage,
  hint,
}: {
  /** 由外层 SRow 提供标签时可省略，避免同一字段出现两层标签。 */
  label?: string;
  value: ModelRef | undefined;
  onChange: (ref: ModelRef) => void;
  requireImage?: boolean;
  hint?: string;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const status = useModelRefStatus(value, requireImage);
  const { views } = useProviderViews();
  const model = collectModelOptions(views, requireImage).find(
    (o) => o.providerId === value?.providerId && o.modelId === value?.modelId,
  );

  return (
    <div className="pw-set-field">
      {label ? <span className="pw-set-lbl">{label}</span> : null}
      <button
        type="button"
        className={`pw-model-ref ${status === "ok" ? "" : "is-blocked"}`}
        onClick={() => setOpen(true)}
      >
        {status === "ok" ? (
          <span className="pw-model-ref-text">
            {t("providers.picker.current", {
              provider: model?.providerName ?? value?.providerId ?? "",
              model: model?.model.name ?? value?.modelId ?? "",
            })}
          </span>
        ) : (
          <span className="pw-model-ref-text">
            <Icon.AlertCircle size={13} />
            {status === "unset" ? t("providers.picker.unset") : t("providers.picker.danglingShort")}
          </span>
        )}
        <Icon.ChevronRight size={13} />
      </button>
      {status === "dangling" ? (
        <div className="pw-prov-alert is-error">
          {t("providers.picker.dangling", { provider: value?.providerId ?? "", model: value?.modelId ?? "" })}
        </div>
      ) : null}
      {hint ? <div className="pw-set-hint">{hint}</div> : null}
      {open ? (
        <ModelPickerDialog
          value={value}
          requireImage={requireImage}
          onClose={() => setOpen(false)}
          onSelect={(ref) => {
            onChange(ref);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
