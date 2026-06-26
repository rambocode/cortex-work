// Composer 底部「自定义」下拉(置于「+」之后)。把原先并排的两个 pill——「执行模式」
// (approvalPolicy:自动执行/询问后执行)与「工作区」(permissionMode:可写工作区/只读文件/
// 访问所有文件/外部沙箱)——收进单个齿轮按钮的上弹菜单,减少底栏占用。
// 两组各自独立门控:仅当外部传入对应 onChange 时才渲染该组;两组都没有则整个按钮不渲染
// (由 ComposerShell 侧判断)。复用 pw-tb-menu 上弹菜单 + useDismissableMenu 关闭范式。

import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type AgentKind,
  type ApprovalPolicy,
  type PermissionMode,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDismissableMenu } from "./useDismissableMenu";

// 访问范围各档的说明 tooltip(与原 ModePill 一致)。
const MODE_HINT_KEY: Record<PermissionMode, string> = {
  plan: "composer.permissionMode.planHint",
  "accept-edits": "composer.permissionMode.acceptEditsHint",
  "full-auto": "composer.permissionMode.fullAutoHint",
  sandbox: "composer.permissionMode.sandboxHint",
};

export function CustomizePill({
  agent,
  approvalPolicy,
  onChangeApprovalPolicy,
  permissionMode,
  onChangePermissionMode,
  running,
}: {
  agent: AgentKind;
  // 两组均 opt-in:提供 onChange 才渲染对应分组。
  approvalPolicy?: ApprovalPolicy;
  onChangeApprovalPolicy?: (p: ApprovalPolicy) => void;
  permissionMode?: PermissionMode;
  onChangePermissionMode?: (mode: PermissionMode) => void;
  running: boolean;
}) {
  const { t } = useTranslation("chat");
  const menu = useDismissableMenu();
  const approval = approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
  const mode = permissionMode ?? DEFAULT_PERMISSION_MODE;

  return (
    <div
      className="pw-tb-menu-wrap"
      ref={menu.wrapRef}
      onMouseLeave={menu.onMouseLeave}
      onMouseEnter={menu.onMouseEnter}
    >
      <button
        className="pill pw-customize-pill"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.setOpen((v) => !v)}
        title={t("composer.customize.label")}
        aria-label={t("composer.customize.label")}
      >
        <Icon.Settings size={13} />
        <span>{t("composer.customize.label")}</span>
        <Icon.Chevron size={12} />
      </button>
      {menu.open ? (
        <div className="pw-tb-menu pw-tb-menu--up pw-customize-menu" role="menu">
          {/* 执行模式组:ask 在 claude/codex 上无中途审批回路 → 降级,行尾不阻断但 tooltip 标注。 */}
          {onChangeApprovalPolicy ? (
            <>
              <div className="pw-tb-menu-group-h">{t("composer.approval.label")}</div>
              {APPROVAL_POLICIES.map((p) => {
                const degraded = p === "ask" && agent !== "pi";
                const title = degraded ? t("composer.approval.askDegraded") : t(`composer.approval.${p}Hint`);
                return (
                  <button
                    key={p}
                    className={`pw-tb-menu-item ${p === approval ? "is-on" : ""}`}
                    role="menuitemradio"
                    aria-checked={p === approval}
                    disabled={running}
                    title={title}
                    data-warn={degraded ? "1" : undefined}
                    onClick={() => onChangeApprovalPolicy(p)}
                  >
                    <Icon.Power size={14} />
                    <span>{t(`composer.approval.${p}`)}</span>
                    {p === approval ? <Icon.Check size={14} /> : null}
                  </button>
                );
              })}
            </>
          ) : null}
          {/* 两组都在时加一条分隔。 */}
          {onChangeApprovalPolicy && onChangePermissionMode ? <div className="pw-tb-menu-sep" /> : null}
          {/* 工作区组:访问范围 4 档。 */}
          {onChangePermissionMode ? (
            <>
              <div className="pw-tb-menu-group-h">{t("composer.permissionMode.label")}</div>
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m}
                  className={`pw-tb-menu-item ${m === mode ? "is-on" : ""}`}
                  role="menuitemradio"
                  aria-checked={m === mode}
                  disabled={running}
                  title={t(MODE_HINT_KEY[m])}
                  onClick={() => onChangePermissionMode(m)}
                >
                  <Icon.Folder size={14} />
                  <span>{t(`composer.permissionMode.${m}`)}</span>
                  {m === mode ? <Icon.Check size={14} /> : null}
                </button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
