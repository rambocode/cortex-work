// Composer 底部「访问范围」pill(Image #1 第二个 pill)。单选 4 档,对应 permissionMode:
//   可写工作区(accept-edits)/ 只读文件(plan)/ 访问所有文件(full-auto)/ 外部沙箱(sandbox)。
// 复用 pw-model-pill 样式,与模型/思考 pill 同处 comp-foot 行。

import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type PermissionMode } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";

const HINT_KEY: Record<PermissionMode, string> = {
  plan: "composer.permissionMode.planHint",
  "accept-edits": "composer.permissionMode.acceptEditsHint",
  "full-auto": "composer.permissionMode.fullAutoHint",
  sandbox: "composer.permissionMode.sandboxHint",
};

export function ModePill({
  permissionMode,
  onChange,
  running,
}: {
  permissionMode?: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  running: boolean;
}) {
  const { t } = useTranslation("chat");
  const mode = permissionMode ?? DEFAULT_PERMISSION_MODE;
  return (
    <span className="pill pw-model-pill" title={t(HINT_KEY[mode])}>
      <span className="lightning">
        <Icon.Folder size={11} />
      </span>
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
          </option>
        ))}
      </select>
    </span>
  );
}
