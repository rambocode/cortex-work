// 侧栏底部用户行：左侧「头像 + 昵称」点开功能菜单，右侧消息铃铛。
//
// 取代原先平铺的四按钮快捷入口（闪记 / 自动化 / Loop / 设置）——那一排把侧栏底部占满，
// 且随功能增加只会越挤。收进头像菜单后底部空出的位置给了消息铃铛。
//
// 菜单项的可用性沿用原快捷入口的降级规则：onOpenFlashNote / bridge.automationList /
// bridge.workflowList 缺失（web 端或旧壳）时对应项直接不渲染，而不是渲染一个点了没反应的项。

import {
  profileInitial,
  resolveAvatar,
  useDesktopBridge,
  usePersonalProfile,
  usePersonalStore,
  usePetStore,
} from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";
import { savePetEnabled } from "../../pet/prefs";
import { useDismissableMenu } from "../shared/useDismissableMenu";
import { NotificationBell } from "./NotificationBell";

export function SidebarUserBar({
  onOpenFlashNote,
}: {
  // 闪记浮层入口（壳注入；web/旧壳缺省 → 该菜单项隐藏）。
  onOpenFlashNote?: () => void;
}) {
  const { t } = useTranslation();
  const bridge = useDesktopBridge();
  const menu = useDismissableMenu();
  const profile = usePersonalProfile();
  const avatar = resolveAvatar(profile);
  const nickname = profile.nickname?.trim() || "我";

  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const openAutomation = usePersonalStore((s) => s.openAutomation);
  const workflowOpen = usePersonalStore((s) => s.workflowOpen);
  const openWorkflow = usePersonalStore((s) => s.openWorkflow);
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  const openSettings = usePersonalStore((s) => s.openSettings);
  // 宠物开关直接读写 petStore（与设置里的「显示宠物」同一份状态，两处联动）。
  const petEnabled = usePetStore((s) => s.enabled);
  const setPetEnabled = usePetStore((s) => s.setEnabled);
  // petStore 在 core 层，按包边界不能碰 localStorage —— 持久化由 views 的每个写入点负责。
  // 漏掉 savePetEnabled 就会「切了生效、重启回滚」（启动时 PetBridge/Pet 用 loadPetEnabled 覆盖回旧值）。
  const togglePet = () => {
    const next = !petEnabled;
    setPetEnabled(next);
    savePetEnabled(next);
  };

  // 菜单项点完即收，避免用户还要再点一次外部才关。
  const run = (fn: () => void) => () => {
    fn();
    menu.setOpen(false);
  };

  return (
    <div className="pw-sb-userbar">
      <div className="pw-tb-menu-wrap pw-sb-user-wrap" ref={menu.wrapRef}>
        <button
          type="button"
          className={`pw-sb-user ${menu.open ? "is-open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={() => menu.setOpen((v) => !v)}
        >
          <span
            className={`pw-sb-user-avatar ${avatar.mode === "initials" ? "is-initial" : ""}`}
            style={{ background: avatar.bg }}
          >
            {avatar.mode === "emoji" ? avatar.emoji : profileInitial(profile.nickname)}
          </span>
          <span className="pw-sb-user-name">{nickname}</span>
        </button>
        {menu.open ? (
          <div className="pw-tb-menu pw-tb-menu--up pw-tb-menu--left pw-sb-user-menu" role="menu">
            {onOpenFlashNote ? (
              <button type="button" className="pw-tb-menu-item" role="menuitem" onClick={run(onOpenFlashNote)}>
                <Icon.Pin size={15} />
                <span>闪记</span>
              </button>
            ) : null}
            {bridge?.automationList ? (
              <button
                type="button"
                className={`pw-tb-menu-item ${automationOpen ? "is-on" : ""}`}
                role="menuitem"
                onClick={run(openAutomation)}
              >
                <Icon.Workflow size={15} />
                <span>自动化</span>
              </button>
            ) : null}
            {bridge?.workflowList ? (
              <button
                type="button"
                className={`pw-tb-menu-item ${workflowOpen ? "is-on" : ""}`}
                role="menuitem"
                onClick={run(openWorkflow)}
              >
                <Icon.GitBranch size={15} />
                <span>Loop</span>
              </button>
            ) : null}
            <div className="pw-tb-menu-sep" />
            {/* 宠物是开关而非跳转：点击就地切换、菜单**不关**，方便用户看着宠物出现/消失再决定。
                选中态用 Check 而非自绘 switch —— 与本菜单其它项、以及 AgentSelect 等下拉一致。 */}
            <button
              type="button"
              className="pw-tb-menu-item"
              role="menuitemcheckbox"
              aria-checked={petEnabled}
              onClick={togglePet}
            >
              <Icon.Sparkle size={15} />
              <span>显示宠物</span>
              {petEnabled ? <Icon.Check size={13} /> : null}
            </button>
            <button
              type="button"
              className={`pw-tb-menu-item ${settingsOpen ? "is-on" : ""}`}
              role="menuitem"
              onClick={run(() => openSettings())}
            >
              <Icon.Settings size={15} />
              <span>{t("sidebar.settings")}</span>
            </button>
          </div>
        ) : null}
      </div>
      <NotificationBell />
    </div>
  );
}
