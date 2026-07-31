// ModelPicker 的弹窗外壳。给「点一下才需要选模型」的场景用（聊天里的图片阻断提示条、
// 各设置页的模型字段），避免每处自己写一遍遮罩 + ESC + 焦点管理。
//
// ESC 处理与 ProviderManagerModal 同款：capture 阶段监听 + stopPropagation，
// 否则会连带触发设置整页的「ESC 返回」。

import { useEffect } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import type { ModelRef } from "@cortex-work/core/desktop/provider-catalog";
import { ModelPicker } from "./ModelPicker";

export function ModelPickerDialog({
  value,
  onSelect,
  onClose,
  requireImage,
}: {
  value?: ModelRef;
  onSelect: (ref: ModelRef) => void;
  onClose: () => void;
  requireImage?: boolean;
}) {
  const { t } = useTranslation("settings");
  const openSettings = usePersonalStore((s) => s.openSettings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="pw-prov-modal-mask" onClick={onClose}>
      <div
        className="pw-prov-modal is-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t("providers.picker.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pw-prov-modal-head">
          <span className="pw-prov-modal-title">{t("providers.picker.title")}</span>
          <button className="pw-prov-modal-close" aria-label={t("providers.manageClose")} onClick={onClose}>
            <Icon.X size={15} />
          </button>
        </div>
        <div className="pw-prov-modal-body">
          <ModelPicker
            value={value}
            requireImage={requireImage}
            onSelect={onSelect}
            onOpenManager={() => {
              onClose();
              openSettings("providers");
            }}
          />
        </div>
      </div>
    </div>
  );
}
