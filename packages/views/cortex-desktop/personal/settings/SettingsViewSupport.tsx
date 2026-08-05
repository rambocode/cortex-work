// 设置整页的轻量分区外壳与键盘焦点守卫。
// 抽离出 SettingsMenu 以维持主导航组件的 1200 行上限；不含状态或跨组件副作用。

import { useTranslation } from "@cortex-work/core/i18n";
import { BrowserSettingsSection } from "./BrowserSettingsSection";
import { MediaGenSettingsSection } from "./MediaGenSettingsSection";
import { ReplySettingsSection } from "./ReplySettingsSection";

/** 输入/录制控件拥有 Escape 的局部语义，不能关闭整页设置。 */
export function isSettingsTypingTarget(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((element as HTMLElement).isContentEditable) return true;
  return element.classList.contains("is-recording");
}

export function BrowserSection() {
  const { t } = useTranslation("settings");
  return (
    <>
      <div className="pw-dlg-title">{t("browser.title")}</div>
      <div className="pw-dlg-desc">{t("browser.desc")}</div>
      <BrowserSettingsSection />
    </>
  );
}

export function MediaGenSection() {
  const { t } = useTranslation("settings");
  return (
    <>
      <div className="pw-mediagen-head">
        <div className="pw-dlg-title">{t("mediaGen.title")}</div>
        <span className="pw-mediagen-autofx">{t("mediaGen.autoEffectBadge")}</span>
      </div>
      <div className="pw-dlg-desc">{t("mediaGen.desc")}</div>
      <MediaGenSettingsSection />
    </>
  );
}

export function ReplySection() {
  return <ReplySettingsSection />;
}
