// Composer 底部权限选择 pill(置于「+」之后)。pill 直接显示当前执行权限档位(如「完全访问」
// 橙色警示态),点开下弹菜单:标题问句 +「标题 + 副标题说明 + 选中勾」两行式档位项(参照
// ChatGPT/Codex 审批选择器)。仅当外部传入 onChangeExecPermission 时渲染(由 ComposerShell 侧判断)。
// (子 agent 编排开关已升为全局设置,见 设置 → Agent。)复用 pw-tb-menu 菜单 + useDismissableMenu 关闭范式。

import {
  EXEC_PERMISSIONS,
  DEFAULT_EXEC_PERMISSION,
  type AgentKind,
  type ExecPermission,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDismissableMenu } from "./useDismissableMenu";

// 各档副标题说明(菜单两行式的第二行)。
const EXEC_DESC_KEY: Record<ExecPermission, string> = {
  plan: "composer.execPermission.planDesc",
  ask: "composer.execPermission.askDesc",
  auto: "composer.execPermission.autoDesc",
};
// 执行权限三档图标:计划=只读眼 / 询问=举手 / 完全访问=圆圈感叹号(警示)。
const EXEC_ICON: Record<ExecPermission, typeof Icon.Folder> = {
  plan: Icon.Eye,
  ask: Icon.Hand,
  auto: Icon.AlertCircle,
};
// 菜单标题问句里的 agent 展示名(与 ModeBlockBanner 同款本地映射)。
const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

export function CustomizePill({
  agent,
  execPermission,
  onChangeExecPermission,
  running,
}: {
  agent: AgentKind;
  // opt-in:提供 onChange 才渲染档位组。
  execPermission?: ExecPermission;
  onChangeExecPermission?: (p: ExecPermission) => void;
  running: boolean;
}) {
  const { t } = useTranslation("chat");
  const menu = useDismissableMenu();
  const exec = execPermission ?? DEFAULT_EXEC_PERMISSION;
  const PillGlyph = EXEC_ICON[exec];
  const name = AGENT_LABEL[agent] ?? agent;

  return (
    <div
      className="pw-tb-menu-wrap"
      ref={menu.wrapRef}
      onMouseLeave={menu.onMouseLeave}
      onMouseEnter={menu.onMouseEnter}
    >
      {/* pill 展示当前档位;「完全访问」(auto)用橙色警示态,一眼可见全盘权限已放开。 */}
      <button
        className={`pill pw-customize-pill ${exec === "auto" ? "is-warn" : ""}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.setOpen((v) => !v)}
        title={t(EXEC_DESC_KEY[exec])}
        aria-label={t("composer.execPermission.label")}
      >
        <PillGlyph size={13} />
        <span>{t(`composer.execPermission.${exec}`)}</span>
        <Icon.Chevron size={12} />
      </button>
      {menu.open ? (
        <div className="pw-tb-menu pw-tb-menu--left pw-perm-menu" role="menu">
          {/* 执行权限组:标题问句 + 两行式三档。ask 在 claude/codex 上无中途审批回路 → 降级,tooltip 标注。 */}
          {onChangeExecPermission ? (
            <>
              <div className="pw-perm-menu-title">{t("composer.execPermission.menuTitle", { name })}</div>
              {EXEC_PERMISSIONS.map((p) => {
                const degraded = p === "ask" && agent !== "pi";
                const ExecGlyph = EXEC_ICON[p];
                return (
                  <button
                    key={p}
                    className={`pw-tb-menu-item pw-perm-item ${p === exec ? "is-on" : ""} ${p === "auto" ? "is-warn" : ""}`}
                    role="menuitemradio"
                    aria-checked={p === exec}
                    disabled={running}
                    title={degraded ? t("composer.execPermission.askDegraded") : undefined}
                    data-warn={degraded ? "1" : undefined}
                    onClick={() => onChangeExecPermission(p)}
                  >
                    <ExecGlyph size={16} />
                    <span className="pw-perm-item-text">
                      <span className="pw-perm-item-title">{t(`composer.execPermission.${p}`)}</span>
                      <span className="pw-perm-item-desc">{t(EXEC_DESC_KEY[p])}</span>
                    </span>
                    {p === exec ? <Icon.Check size={15} /> : null}
                  </button>
                );
              })}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
