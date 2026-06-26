// Composer 上方的「运行模式」pill。从 GitBar 移出(mode 与目录授权拆成两个独立控件)。
// 4 档:plan / accept-edits / auto / full-auto(内部值;显示名走 i18n,见 KTD2)。
// auto 档:运行中若已解析出具体档,显示「Auto → 具体档」,让逐轮解析对用户可见(KTD7)。

import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type ConcretePermissionMode,
  type PermissionMode,
} from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";

// 每档 tooltip i18n key。
const HINT_KEY: Record<PermissionMode, string> = {
  plan: "composer.permissionMode.planHint",
  "accept-edits": "composer.permissionMode.acceptEditsHint",
  "full-auto": "composer.permissionMode.fullAutoHint",
  auto: "composer.permissionMode.autoHint",
};

export function ModePill({
  permissionMode,
  onChange,
  running,
  resolvedMode,
}: {
  permissionMode?: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  running: boolean;
  // auto 档运行时解析出的具体档(KTD7);提供则在 pill 上附显「→ 具体档」。
  resolvedMode?: ConcretePermissionMode;
}) {
  const { t } = useTranslation("chat");
  const mode = permissionMode ?? DEFAULT_PERMISSION_MODE;
  // auto + 已解析:label 附「→ 具体档」(KTD7 可见性)。
  const autoSuffix =
    mode === "auto" && resolvedMode ? ` → ${t(`composer.permissionMode.${resolvedMode}`)}` : "";
  return (
    <span className="pw-model-pill pw-gitbar-mode" title={t(HINT_KEY[mode])}>
      <select
        className="pw-model-select"
        value={mode}
        onChange={(e) => onChange(e.target.value as PermissionMode)}
        disabled={running}
        aria-label={t("composer.permissionMode.label")}
      >
        {PERMISSION_MODES.map((m) => (
          <option key={m} value={m}>
            {t(`composer.permissionMode.${m}`)}
            {m === mode ? autoSuffix : ""}
          </option>
        ))}
      </select>
    </span>
  );
}
