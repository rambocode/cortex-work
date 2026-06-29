// Composer 底部「自定义」下拉(置于「+」之后)。把两个权限轴——「执行权限」(execPermission:
// 计划/询问后执行/自动执行)与「目录执行权限」(dirPermission:仅工作目录/所有文件/外部沙箱)——
// 收进单个齿轮按钮的上弹菜单,减少底栏占用。执行权限选「计划」(只读)时,目录执行权限整组隐藏
// (只读无目录范围语义)。两组各自独立门控:仅当外部传入对应 onChange 时才渲染该组;两组都没有则
// 整个按钮不渲染(由 ComposerShell 侧判断)。复用 pw-tb-menu 上弹菜单 + useDismissableMenu 关闭范式。

import {
  EXEC_PERMISSIONS,
  DIR_PERMISSIONS,
  DEFAULT_EXEC_PERMISSION,
  DEFAULT_DIR_PERMISSION,
  type AgentKind,
  type ExecPermission,
  type DirPermission,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDismissableMenu } from "./useDismissableMenu";

// 执行权限各档说明 tooltip。
const EXEC_HINT_KEY: Record<ExecPermission, string> = {
  plan: "composer.execPermission.planHint",
  ask: "composer.execPermission.askHint",
  auto: "composer.execPermission.autoHint",
};
// 目录执行权限各档说明 tooltip。
const DIR_HINT_KEY: Record<DirPermission, string> = {
  workspace: "composer.dirPermission.workspaceHint",
  all: "composer.dirPermission.allHint",
  sandbox: "composer.dirPermission.sandboxHint",
};
// 执行权限三档图标:计划=只读眼 / 询问=举手 / 自动=闪电。(Icon.* 同签名,用 Icon.Folder 之类作公共类型。)
const EXEC_ICON: Record<ExecPermission, typeof Icon.Folder> = {
  plan: Icon.Eye,
  ask: Icon.Hand,
  auto: Icon.Lightning,
};

export function CustomizePill({
  agent,
  execPermission,
  onChangeExecPermission,
  dirPermission,
  onChangeDirPermission,
  subagentOrchestration,
  onToggleSubagentOrchestration,
  running,
}: {
  agent: AgentKind;
  // 各组均 opt-in:提供 onChange/onToggle 才渲染对应分组。
  execPermission?: ExecPermission;
  onChangeExecPermission?: (p: ExecPermission) => void;
  dirPermission?: DirPermission;
  onChangeDirPermission?: (d: DirPermission) => void;
  // 子 agent 编排开关(布尔)。Claude/Codex 走 CLI fresh spawn;Pi 走临时 RPC fresh 会话(12790c0 起 pi 也参与)。
  subagentOrchestration?: boolean;
  onToggleSubagentOrchestration?: () => void;
  running: boolean;
}) {
  const { t } = useTranslation("chat");
  const menu = useDismissableMenu();
  const exec = execPermission ?? DEFAULT_EXEC_PERMISSION;
  const dir = dirPermission ?? DEFAULT_DIR_PERMISSION;

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
          {/* 执行权限组:三档(计划/询问后执行/自动执行)。ask 在 claude/codex 上无中途审批回路 → 降级,tooltip 标注。 */}
          {onChangeExecPermission ? (
            <>
              <div className="pw-tb-menu-group-h">{t("composer.execPermission.label")}</div>
              {EXEC_PERMISSIONS.map((p) => {
                const degraded = p === "ask" && agent !== "pi";
                const title = degraded ? t("composer.execPermission.askDegraded") : t(EXEC_HINT_KEY[p]);
                const ExecGlyph = EXEC_ICON[p];
                return (
                  <button
                    key={p}
                    className={`pw-tb-menu-item ${p === exec ? "is-on" : ""}`}
                    role="menuitemradio"
                    aria-checked={p === exec}
                    disabled={running}
                    title={title}
                    data-warn={degraded ? "1" : undefined}
                    onClick={() => onChangeExecPermission(p)}
                  >
                    <ExecGlyph size={14} />
                    <span>{t(`composer.execPermission.${p}`)}</span>
                    {p === exec ? <Icon.Check size={14} /> : null}
                  </button>
                );
              })}
            </>
          ) : null}
          {/* plan(计划/只读)时隐藏目录执行权限组与其上分隔条;两组并存才加分隔。 */}
          {onChangeExecPermission && onChangeDirPermission && exec !== "plan" ? <div className="pw-tb-menu-sep" /> : null}
          {/* 目录执行权限组:范围 3 档。sandbox 仅 codex 原生,claude/pi 降级标注。exec=plan 时整组不渲染。 */}
          {onChangeDirPermission && exec !== "plan" ? (
            <>
              <div className="pw-tb-menu-group-h">{t("composer.dirPermission.label")}</div>
              {DIR_PERMISSIONS.map((d) => {
                const degraded = d === "sandbox" && agent !== "codex";
                const title = degraded ? t("composer.dirPermission.sandboxDegraded") : t(DIR_HINT_KEY[d]);
                return (
                  <button
                    key={d}
                    className={`pw-tb-menu-item ${d === dir ? "is-on" : ""}`}
                    role="menuitemradio"
                    aria-checked={d === dir}
                    disabled={running}
                    title={title}
                    data-warn={degraded ? "1" : undefined}
                    onClick={() => onChangeDirPermission(d)}
                  >
                    <Icon.Folder size={14} />
                    <span>{t(`composer.dirPermission.${d}`)}</span>
                    {d === dir ? <Icon.Check size={14} /> : null}
                  </button>
                );
              })}
            </>
          ) : null}
          {/* 子 agent 编排组(布尔开关):开启后该会话发送走主进程三段编排
              (意图理解→子 agent 执行→整理回复),过程面板按段展示。 */}
          {onToggleSubagentOrchestration ? (
            <>
              {onChangeExecPermission || onChangeDirPermission ? <div className="pw-tb-menu-sep" /> : null}
              <div className="pw-tb-menu-group-h">{t("composer.subagentOrchestration.label")}</div>
              <button
                className={`pw-tb-menu-item ${subagentOrchestration ? "is-on" : ""}`}
                role="menuitemcheckbox"
                aria-checked={!!subagentOrchestration}
                disabled={running}
                title={t(subagentOrchestration ? "composer.subagentOrchestration.onHint" : "composer.subagentOrchestration.offHint")}
                onClick={onToggleSubagentOrchestration}
              >
                <Icon.Sparkle size={14} />
                <span>{t(subagentOrchestration ? "composer.subagentOrchestration.on" : "composer.subagentOrchestration.off")}</span>
                {subagentOrchestration ? <Icon.Check size={14} /> : null}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
