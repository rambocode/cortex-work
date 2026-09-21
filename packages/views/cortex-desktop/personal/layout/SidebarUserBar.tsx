// 侧栏底部用户行：左侧「头像 + 昵称」点开功能菜单，右侧消息铃铛。
//
// 菜单只放「显示宠物 / 设置」;闪记 / 自动化 / Loop 已移到侧栏滚动区顶部的功能入口行
//(见 PersonalSidebar 的 .pw-sidebar-nav),对齐 ChatGPT 侧栏。

import {
  profileInitial,
  resolveAvatar,
  usePersonalProfile,
  usePersonalStore,
  usePetStore,
} from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";
import { patchPetPrefs } from "../../pet/prefs";
import { useDismissableMenu } from "../shared/useDismissableMenu";

export function SidebarUserBar() {
  const { t } = useTranslation();
  const menu = useDismissableMenu();
  const profile = usePersonalProfile();
  const avatar = resolveAvatar(profile);
  const nickname = profile.nickname?.trim() || "我";

  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  const openSettings = usePersonalStore((s) => s.openSettings);
  // 宠物开关直接读写 petStore（与设置里的「显示宠物」同一份状态，两处联动）。
  const petEnabled = usePetStore((s) => s.enabled);
  // 改运行时状态与落盘由 patchPetPrefs 一并完成(pet/prefs.ts 是唯一的偏好写入端口)。
  // 此前这里要手动配对两步,漏掉落盘就是「切了生效、重启回滚」。
  const togglePet = () => patchPetPrefs({ enabled: !petEnabled });

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
    </div>
  );
}
